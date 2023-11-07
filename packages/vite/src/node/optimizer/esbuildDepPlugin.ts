import path from 'node:path'
import type { ImportKind } from 'esbuild'
import type { Plugin } from 'rollup'
import { KNOWN_ASSET_TYPES } from '../constants'
import type { PackageCache } from '../packages'
import { getDepOptimizationConfig } from '../config'
import type { ResolvedConfig } from '../config'
import {
  escapeRegex,
  flattenId,
  isBuiltin,
  isExternalUrl,
  moduleListContains,
  normalizePath,
} from '../utils'
import { browserExternalId, optionalPeerDepId } from '../plugins/resolve'
import { isCSSRequest, isModuleCSSRequest } from '../plugins/css'

const optionalPeerDepNamespace = 'optional-peer-dep:'
const browserExternalNamespace = 'browser-external:'
const externalWithConversionNamespace =
  'vite:dep-pre-bundle:external-conversion'
const convertedExternalPrefix = 'vite-dep-pre-bundle-external:'

const cjsExternalFacadeNamespace = 'vite:cjs-external-facade'
const nonFacadePrefix = 'vite-cjs-external-facade:'

const externalTypes = [
  'css',
  // supported pre-processor types
  'less',
  'sass',
  'scss',
  'styl',
  'stylus',
  'pcss',
  'postcss',
  // wasm
  'wasm',
  // known SFC types
  'vue',
  'svelte',
  'marko',
  'astro',
  'imba',
  // JSX/TSX may be configured to be compiled differently from how esbuild
  // handles it by default, so exclude them as well
  'jsx',
  'tsx',
  ...KNOWN_ASSET_TYPES,
]

export function rollupDepPlugin(
  qualified: Record<string, string>,
  external: string[],
  config: ResolvedConfig,
  ssr: boolean,
): Plugin {
  const { extensions } = getDepOptimizationConfig(config, ssr)

  // remove optimizable extensions from `externalTypes` list
  const allExternalTypes = extensions
    ? externalTypes.filter((type) => !extensions?.includes('.' + type))
    : externalTypes

  // use separate package cache for optimizer as it caches paths around node_modules
  // and it's unlikely for the core Vite process to traverse into node_modules again
  const esmPackageCache: PackageCache = new Map()
  const cjsPackageCache: PackageCache = new Map()

  // default resolver which prefers ESM
  const _resolve = config.createResolver({
    asSrc: false,
    scan: true,
    packageCache: esmPackageCache,
  })

  // cjs resolver that prefers Node
  const _resolveRequire = config.createResolver({
    asSrc: false,
    isRequire: true,
    scan: true,
    packageCache: cjsPackageCache,
  })

  const resolve = (
    id: string,
    importer: string | undefined,
    kind: ImportKind,
    resolveDir?: string,
  ): Promise<string | undefined> => {
    let _importer: string | undefined = undefined
    // explicit resolveDir - this is passed only during yarn pnp resolve for
    // entries
    if (resolveDir) {
      _importer = normalizePath(path.join(resolveDir, '*'))
    } else if (importer) {
      // map importer ids to file paths for correct resolution
      _importer = importer in qualified ? qualified[importer] : importer
    }
    const resolver = kind.startsWith('require') ? _resolveRequire : _resolve
    return resolver(id, _importer, undefined, ssr)
  }

  const resolveResult = (id: string, resolved: string) => {
    if (resolved.startsWith(browserExternalId)) {
      return {
        id: browserExternalNamespace + id,
      }
    }
    if (resolved.startsWith(optionalPeerDepId)) {
      return {
        id: optionalPeerDepNamespace + resolved,
      }
    }
    if (ssr && isBuiltin(resolved)) {
      return
    }
    if (isExternalUrl(resolved)) {
      return {
        id: resolved,
        external: true,
      }
    }
    return {
      id: path.resolve(resolved),
    }
  }

  const allExternalTypesReg = new RegExp(
    `\\.(` + allExternalTypes.join('|') + `)(\\?.*)?$`,
  )

  function resolveEntry(id: string) {
    const flatId = flattenId(id)
    if (flatId in qualified) {
      return {
        id: qualified[flatId],
      }
    }
  }

  return {
    name: 'vite:dep-pre-bundle',
    // clear package cache when build is finished
    buildEnd() {
      esmPackageCache.clear()
      cjsPackageCache.clear()
    },
    resolveId: async function (id, importer, options) {
      // TODO rolldown: kind is not available in rollup
      const kind: ImportKind = options.custom?.kind
      // externalize assets and commonly known non-js file types
      // See #8459 for more details about this require-import conversion
      if (allExternalTypesReg.test(id)) {
        // if the prefix exist, it is already converted to `import`, so set `external: true`
        if (id.startsWith(convertedExternalPrefix)) {
          return {
            id: id.slice(convertedExternalPrefix.length),
            external: true,
          }
        }

        const resolved = await resolve(id, importer, kind)
        if (resolved) {
          if (kind === 'require-call') {
            // here it is not set to `external: true` to convert `require` to `import`
            return {
              id: externalWithConversionNamespace + resolved,
            }
          }
          return {
            id: resolved,
            external: true,
          }
        }
      }

      if (/^[\w@][^:]/.test(id)) {
        if (moduleListContains(external, id)) {
          return {
            id: id,
            external: true,
          }
        }

        // ensure esbuild uses our resolved entries
        let entry: { id: string } | undefined
        // if this is an entry, return entry namespace resolve result
        if (!importer) {
          if ((entry = resolveEntry(id))) return entry
          // check if this is aliased to an entry - also return entry namespace
          const aliased = await _resolve(id, undefined, true)
          if (aliased && (entry = resolveEntry(aliased))) {
            return entry
          }
        }

        // use vite's own resolver
        const resolved = await resolve(id, importer, kind)
        if (resolved) {
          return resolveResult(id, resolved)
        }
      }
    },
    load(id) {
      if (id.startsWith(externalWithConversionNamespace)) {
        const path = id.slice(externalWithConversionNamespace.length)
        // import itself with prefix (this is the actual part of require-import conversion)
        const modulePath = `"${convertedExternalPrefix}${path}"`
        return {
          code:
            isCSSRequest(path) && !isModuleCSSRequest(path)
              ? `import ${modulePath};`
              : `export { default } from ${modulePath};` +
                `export * from ${modulePath};`,
        }
      }

      if (id.startsWith(browserExternalNamespace)) {
        if (config.isProduction) {
          return {
            code: 'module.exports = {}',
          }
        } else {
          // Return in CJS to intercept named imports. Use `Object.create` to
          // create the Proxy in the prototype to workaround esbuild issue. Why?
          //
          // In short, esbuild cjs->esm flow:
          // 1. Create empty object using `Object.create(Object.getPrototypeOf(module.exports))`.
          // 2. Assign props of `module.exports` to the object.
          // 3. Return object for ESM use.
          //
          // If we do `module.exports = new Proxy({}, {})`, step 1 returns empty object,
          // step 2 does nothing as there's no props for `module.exports`. The final object
          // is just an empty object.
          //
          // Creating the Proxy in the prototype satisfies step 1 immediately, which means
          // the returned object is a Proxy that we can intercept.
          //
          // Note: Skip keys that are accessed by esbuild and browser devtools.
          return {
            code: `\
                    module.exports = Object.create(new Proxy({}, {
                        get(_, key) {
                        if (
                            key !== '__esModule' &&
                            key !== '__proto__' &&
                            key !== 'constructor' &&
                            key !== 'splice'
                        ) {
                            console.warn(\`Module "${path}" has been externalized for browser compatibility. Cannot access "${path}.\${key}" in client code. See http://vitejs.dev/guide/troubleshooting.html#module-externalized-for-browser-compatibility for more details.\`)
                        }
                        }
                    }))`,
          }
        }
      }

      if (id.startsWith(optionalPeerDepNamespace)) {
        if (config.isProduction) {
          return {
            code: 'module.exports = {}',
          }
        } else {
          const path = id.slice(externalWithConversionNamespace.length)
          const [, peerDep, parentDep] = path.split(':')
          return {
            code: `throw new Error(\`Could not resolve "${peerDep}" imported by "${parentDep}". Is it installed?\`)`,
          }
        }
      }
    },
  }
}

const matchesEntireLine = (text: string) => `^${escapeRegex(text)}$`

// esbuild doesn't transpile `require('foo')` into `import` statements if 'foo' is externalized
// https://github.com/evanw/esbuild/issues/566#issuecomment-735551834
export function rollupCjsExternalPlugin(
  externals: string[],
  platform: 'node' | 'browser',
): Plugin {
  const filter = new RegExp(externals.map(matchesEntireLine).join('|'))

  return {
    name: 'cjs-external',
    resolveId(id, importer, options) {
      if (id.startsWith(nonFacadePrefix)) {
        return {
          id: id.slice(nonFacadePrefix.length),
          external: true,
        }
      }

      if (filter.test(id)) {
        // TODO rolldown: kind is not available in rollup
        const kind: ImportKind = options.custom?.kind
        if (kind === 'require-call' && platform !== 'node') {
          return {
            id: cjsExternalFacadeNamespace + id,
          }
        }

        return {
          id,
          external: true,
        }
      }
    },
    load(id) {
      if (id.startsWith(cjsExternalFacadeNamespace)) {
        return {
          code:
            `import * as m from ${JSON.stringify(
              nonFacadePrefix + id.slice(cjsExternalFacadeNamespace.length),
            )};` + `module.exports = m;`,
        }
      }
    },
  }
}
