import path from 'node:path'
import { createRequire } from 'node:module'
import type {
  TransformOptions as OxcTransformOptions,
  TransformResult as OxcTransformResult,
} from 'rolldown/experimental'
import { transform } from 'rolldown/experimental'
import type { RawSourceMap } from '@ampproject/remapping'
import { type InternalModuleFormat, type SourceMap, rolldown } from 'rolldown'
import type { FSWatcher } from 'dep-types/chokidar'
import { TSConfckParseError } from 'tsconfck'
import type { RollupError } from 'rollup'
import {
  combineSourcemaps,
  createFilter,
  ensureWatchedFile,
  generateCodeFrame,
} from '../utils'
import type { ResolvedConfig } from '../config'
import type { Plugin, PluginContext } from '../plugin'
import { cleanUrl } from '../../shared/utils'
import type { Logger } from '..'
import type { ViteDevServer } from '../server'
import type { ESBuildOptions } from './esbuild'
import { loadTsconfigJsonForFile } from './esbuild'

// IIFE content looks like `var MyLib = (function() {`.
const IIFE_BEGIN_RE =
  /(?:const|var)\s+\S+\s*=\s*\(?function\([^()]*\)\s*\{\s*"use strict";/
// UMD content looks like `(this, function(exports) {`.
const UMD_BEGIN_RE = /\(this,\s*function\([^()]*\)\s*\{\s*"use strict";/

const jsxExtensionsRE = /\.(?:j|t)sx\b/
const validExtensionRE = /\.\w+$/

export interface OxcOptions extends OxcTransformOptions {
  include?: string | RegExp | string[] | RegExp[]
  exclude?: string | RegExp | string[] | RegExp[]
  jsxInject?: string
  jsxInclude?: string | RegExp | string[] | RegExp[]
  jsxExclude?: string | RegExp | string[] | RegExp[]
}

export async function transformWithOxc(
  ctx: PluginContext | undefined,
  code: string,
  filename: string,
  options?: OxcTransformOptions,
  inMap?: object,
  config?: ResolvedConfig,
  watcher?: FSWatcher,
): Promise<OxcTransformResult> {
  let lang = options?.lang

  if (!lang) {
    // if the id ends with a valid ext, use it (e.g. vue blocks)
    // otherwise, cleanup the query before checking the ext
    const ext = path
      .extname(validExtensionRE.test(filename) ? filename : cleanUrl(filename))
      .slice(1)

    if (ext === 'cjs' || ext === 'mjs') {
      lang = 'js'
    } else if (ext === 'cts' || ext === 'mts') {
      lang = 'ts'
    } else {
      lang = ext as 'js' | 'jsx' | 'ts' | 'tsx'
    }
  }

  const resolvedOptions = {
    sourcemap: true,
    ...options,
    lang,
  }

  if (lang === 'ts' || lang === 'tsx') {
    try {
      const { tsconfig: loadedTsconfig, tsconfigFile } =
        await loadTsconfigJsonForFile(filename, config)
      // tsconfig could be out of root, make sure it is watched on dev
      if (watcher && tsconfigFile && config) {
        ensureWatchedFile(watcher, tsconfigFile, config.root)
      }
      const loadedCompilerOptions = loadedTsconfig.compilerOptions ?? {}
      // tsc compiler experimentalDecorators/target/useDefineForClassFields

      if (loadedCompilerOptions.jsx === 'preserve') {
        resolvedOptions.jsx = 'preserve'
      } else {
        const jsxOptions = {
          ...(resolvedOptions.jsx === 'preserve' ? {} : resolvedOptions.jsx),
        }

        if (loadedCompilerOptions.jsxFactory) {
          jsxOptions.pragma = loadedCompilerOptions.jsxFactory
        }
        if (loadedCompilerOptions.jsxFragmentFactory) {
          jsxOptions.pragmaFrag = loadedCompilerOptions.jsxFragmentFactory
        }
        if (loadedCompilerOptions.jsxImportSource) {
          jsxOptions.importSource = loadedCompilerOptions.jsxImportSource
        }

        switch (loadedCompilerOptions.jsx) {
          case 'react-jsxdev':
            jsxOptions.runtime = 'automatic'
            jsxOptions.development = true
            break
          case 'react':
            jsxOptions.runtime = 'classic'
            break
          case 'react-jsx':
            jsxOptions.runtime = 'automatic'
            break
          default:
            break
        }

        resolvedOptions.jsx = jsxOptions
      }

      /**
       * | preserveValueImports | importsNotUsedAsValues | verbatimModuleSyntax | onlyRemoveTypeImports |
       * | -------------------- | ---------------------- | -------------------- |---------------------- |
       * | false                | remove                 | false                | false                 |
       * | false                | preserve, error        | -                    | -                     |
       * | true                 | remove                 | -                    | -                     |
       * | true                 | preserve, error        | true                 | true                  |
       */
      if (loadedCompilerOptions.verbatimModuleSyntax !== undefined) {
        resolvedOptions.typescript ??= {}
        resolvedOptions.typescript.onlyRemoveTypeImports =
          loadedCompilerOptions.verbatimModuleSyntax
      } else if (
        loadedCompilerOptions.preserveValueImports !== undefined ||
        loadedCompilerOptions.importsNotUsedAsValues !== undefined
      ) {
        const preserveValueImports =
          loadedCompilerOptions.preserveValueImports ?? false
        const importsNotUsedAsValues =
          loadedCompilerOptions.importsNotUsedAsValues ?? 'remove'
        if (
          preserveValueImports === false &&
          importsNotUsedAsValues === 'remove'
        ) {
          resolvedOptions.typescript ??= {}
          resolvedOptions.typescript.onlyRemoveTypeImports = true
        } else if (
          preserveValueImports === true &&
          (importsNotUsedAsValues === 'preserve' ||
            importsNotUsedAsValues === 'error')
        ) {
          resolvedOptions.typescript ??= {}
          resolvedOptions.typescript.onlyRemoveTypeImports = false
        } else {
          ctx?.warn(
            `preserveValueImports=${preserveValueImports} + importsNotUsedAsValues=${importsNotUsedAsValues} is not supported by oxc.` +
              'Please migrate to the new verbatimModuleSyntax option.',
          )
        }
      }
    } catch (e) {
      if (e instanceof TSConfckParseError) {
        // tsconfig could be out of root, make sure it is watched on dev
        if (watcher && e.tsconfigFile && config) {
          ensureWatchedFile(watcher, e.tsconfigFile, config.root)
        }
      }
      throw e
    }
  }

  const result = transform(filename, code, resolvedOptions)

  if (result.errors.length > 0) {
    const firstError = result.errors[0]
    const error: RollupError = new Error(firstError.message)
    let frame = ''
    frame += firstError.labels
      .map(
        (l) =>
          (l.message ? `${l.message}\n` : '') +
          generateCodeFrame(code, l.start, l.end),
      )
      .join('\n')
    if (firstError.helpMessage) {
      frame += '\n' + firstError.helpMessage
    }
    error.frame = frame
    error.pos =
      firstError.labels.length > 0 ? firstError.labels[0].start : undefined
    throw error
  }

  let map: SourceMap
  if (inMap && result.map) {
    const nextMap = result.map
    nextMap.sourcesContent = []
    map = combineSourcemaps(filename, [
      nextMap as RawSourceMap,
      inMap as RawSourceMap,
    ]) as SourceMap
  } else {
    map = result.map as SourceMap
  }
  return {
    ...result,
    map,
  }
}

export function oxcPlugin(config: ResolvedConfig): Plugin {
  const options = config.oxc as OxcOptions
  const {
    jsxInject,
    include,
    exclude,
    jsxInclude,
    jsxExclude,
    ...oxcTransformOptions
  } = options

  const defaultInclude = Array.isArray(include)
    ? include
    : [include || /\.(m?ts|[jt]sx)$/]
  const filter = createFilter(
    defaultInclude.concat(jsxInclude || []),
    exclude || /\.js$/,
  )
  const jsxFilter = createFilter(
    jsxInclude || /\.jsx$/,
    jsxExclude || /\.(m?[jt]s|tsx)$/,
  )

  let server: ViteDevServer

  return {
    name: 'vite:oxc',
    configureServer(_server) {
      server = _server
    },
    async transform(code, id) {
      if (filter(id) || filter(cleanUrl(id))) {
        const oxcTransformJsxOptions = oxcTransformOptions.jsx
        // disable refresh at ssr
        if (
          this.environment.config.consumer === 'server' &&
          typeof oxcTransformJsxOptions === 'object' &&
          oxcTransformJsxOptions.refresh
        ) {
          oxcTransformJsxOptions.refresh = false
        }
        if (
          (jsxFilter(id) || jsxFilter(cleanUrl(id))) &&
          !oxcTransformOptions.lang
        ) {
          oxcTransformOptions.lang = 'jsx'
        }

        const result = await transformWithOxc(
          this,
          code,
          id,
          oxcTransformOptions,
          undefined,
          config,
          server?.watcher,
        )
        if (jsxInject && jsxExtensionsRE.test(id)) {
          result.code = jsxInject + ';' + result.code
        }
        return {
          code: result.code,
          map: result.map,
        }
      }
    },
  }
}

export const buildOxcPlugin = (config: ResolvedConfig): Plugin => {
  return {
    name: 'vite:oxc-transpile',
    async renderChunk(code, chunk, opts) {
      // @ts-expect-error injected by @vitejs/plugin-legacy
      if (opts.__vite_skip_esbuild__) {
        return null
      }

      const options = resolveOxcTranspileOptions(config, opts.format)

      if (!options) {
        return null
      }

      const res = await transformWithOxc(
        this,
        code,
        chunk.fileName,
        options,
        undefined,
        config,
      )

      const runtimeHelpers = Object.entries(res.helpersUsed)
      if (runtimeHelpers.length > 0) {
        const helpersCode = await generateRuntimeHelpers(runtimeHelpers)
        switch (opts.format) {
          case 'es': {
            if (res.code.startsWith('#!')) {
              let secondLinePos = res.code.indexOf('\n')
              if (secondLinePos === -1) {
                secondLinePos = 0
              }
              // inject after hashbang
              res.code =
                res.code.slice(0, secondLinePos) +
                helpersCode +
                res.code.slice(secondLinePos)
              if (res.map) {
                res.map.mappings = res.map.mappings.replace(';', ';;')
              }
            } else {
              res.code = helpersCode + res.code
              if (res.map) {
                res.map.mappings = ';' + res.map.mappings
              }
            }
            break
          }
          case 'cjs': {
            if (/^\s*['"]use strict['"];/.test(res.code)) {
              // inject after use strict
              res.code = res.code.replace(
                /^\s*['"]use strict['"];/,
                (m) => m + helpersCode,
              )
              // no need to update sourcemap because the runtime helpers are injected in the same line with "use strict"
            } else {
              res.code = helpersCode + res.code
              if (res.map) {
                res.map.mappings = ';' + res.map.mappings
              }
            }
            break
          }
          // runtime helpers needs to be injected inside the UMD and IIFE wrappers
          // to avoid collision with other globals.
          // We inject the helpers inside the wrappers.
          // e.g. turn:
          //    (function(){ /*actual content/* })()
          // into:
          //    (function(){ <runtime helpers> /*actual content/* })()
          // Not using regex because it's too hard to rule out performance issues like #8738 #8099 #10900 #14065
          // Instead, using plain string index manipulation (indexOf, slice) which is simple and performant
          // We don't need to create a MagicString here because both the helpers and
          // the headers don't modify the sourcemap
          case 'iife':
          case 'umd': {
            const m = (
              opts.format === 'iife' ? IIFE_BEGIN_RE : UMD_BEGIN_RE
            ).exec(res.code)
            if (!m) {
              this.error('Unexpected IIFE format')
              return
            }
            const pos = m.index + m.length
            res.code =
              res.code.slice(0, pos) + helpersCode + '\n' + res.code.slice(pos)
            break
          }
          case 'app': {
            throw new Error('format: "app" is not supported yet')
            break
          }
          default: {
            opts.format satisfies never
          }
        }
      }

      return res
    },
  }
}

export function resolveOxcTranspileOptions(
  config: ResolvedConfig,
  format: InternalModuleFormat,
): OxcTransformOptions | null {
  const target = config.build.target
  if (!target || target === 'esnext') {
    return null
  }

  return {
    ...(config.oxc || {}),
    helpers: { mode: 'External' },
    lang: 'js',
    sourceType: format === 'es' ? 'module' : 'script',
    target: target || undefined,
    sourcemap: !!config.build.sourcemap,
  }
}

let rolldownDir: string

async function generateRuntimeHelpers(
  runtimeHelpers: readonly [string, string][],
): Promise<string> {
  if (!rolldownDir) {
    let dir = createRequire(import.meta.url).resolve('rolldown')
    while (dir && path.basename(dir) !== 'rolldown') {
      dir = path.dirname(dir)
    }
    rolldownDir = dir
  }

  const bundle = await rolldown({
    cwd: rolldownDir,
    input: 'entrypoint',
    platform: 'neutral',
    plugins: [
      {
        name: 'entrypoint',
        resolveId: {
          filter: { id: /^entrypoint$/ },
          handler: (id) => id,
        },
        load: {
          filter: { id: /^entrypoint$/ },
          handler() {
            return runtimeHelpers
              .map(
                ([name, helper]) =>
                  `export { default as ${name} } from ${JSON.stringify(helper)};`,
              )
              .join('\n')
          },
        },
      },
    ],
  })
  const output = await bundle.generate({
    format: 'iife',
    name: 'babelHelpers',
    minify: true,
  })
  return output.output[0].code
}

type OxcJsxOptions = Exclude<OxcOptions['jsx'], string | undefined>

export function convertEsbuildConfigToOxcConfig(
  esbuildConfig: ESBuildOptions,
  logger: Logger,
): OxcOptions {
  const { jsxInject, include, exclude, ...esbuildTransformOptions } =
    esbuildConfig

  const oxcOptions: OxcOptions = {
    jsxInject,
    include,
    exclude,
  }

  if (esbuildTransformOptions.jsx === 'preserve') {
    oxcOptions.jsx = 'preserve'
  } else {
    const jsxOptions: OxcJsxOptions = {}

    switch (esbuildTransformOptions.jsx) {
      case 'automatic':
        jsxOptions.runtime = 'automatic'
        break
      case 'transform':
        jsxOptions.runtime = 'classic'
        break
      default:
        break
    }

    if (esbuildTransformOptions.jsxDev) {
      jsxOptions.development = true
    }
    if (esbuildTransformOptions.jsxFactory) {
      jsxOptions.pragma = esbuildTransformOptions.jsxFactory
    }
    if (esbuildTransformOptions.jsxFragment) {
      jsxOptions.pragmaFrag = esbuildTransformOptions.jsxFragment
    }
    if (esbuildTransformOptions.jsxImportSource) {
      jsxOptions.importSource = esbuildTransformOptions.jsxImportSource
    }

    oxcOptions.jsx = jsxOptions
  }

  if (esbuildTransformOptions.loader) {
    if (['js', 'jsx', 'ts', 'tsx'].includes(esbuildTransformOptions.loader)) {
      oxcOptions.lang = esbuildTransformOptions.loader as
        | 'js'
        | 'jsx'
        | 'ts'
        | 'tsx'
    } else {
      logger.warn(
        `The esbuild loader ${esbuildTransformOptions.loader} is not supported by oxc`,
      )
    }
  }
  if (esbuildTransformOptions.define) {
    oxcOptions.define = esbuildTransformOptions.define
  }

  switch (esbuildTransformOptions.sourcemap) {
    case true:
    case false:
    case undefined:
      oxcOptions.sourcemap = esbuildTransformOptions.sourcemap
      break
    case 'external':
      oxcOptions.sourcemap = true
      break
    // ignore it because it's not supported by esbuild `transform`
    case 'linked':
      break
    default:
      logger.warn(
        `The esbuild sourcemap ${esbuildTransformOptions.sourcemap} is not supported by oxc`,
      )
      break
  }

  return oxcOptions
}
