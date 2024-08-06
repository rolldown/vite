import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import glob from 'fast-glob'
import type { Plugin } from 'rolldown'
import { scan } from 'rolldown/experimental'
import type { Loader } from 'esbuild'
import  { transform } from 'esbuild'
import colors from 'picocolors'
import type { ResolvedConfig } from '..'
import {
  CSS_LANGS_RE,
  JS_TYPES_RE,
  KNOWN_ASSET_TYPES,
  SPECIAL_QUERY_RE,
} from '../constants'
import {
  arraify,
  asyncFlatten,
  createDebugger,
  dataUrlRE,
  externalRE,
  isInNodeModules,
  isObject,
  isOptimizable,
  moduleListContains,
  multilineCommentsRE,
  normalizePath,
  // parseRequest,
  singlelineCommentsRE,
  virtualModulePrefix,
  virtualModuleRE,
} from '../utils'
import type { PluginContainer } from '../server/pluginContainer'
import { createPluginContainer } from '../server/pluginContainer'
import { transformGlobImport } from '../plugins/importMetaGlob'
import { cleanUrl } from '../../shared/utils'
import { loadTsconfigJsonForFile } from '../plugins/esbuild'

type ResolveIdOptions = Parameters<PluginContainer['resolveId']>[2]

const debug = createDebugger('vite:deps')

const htmlTypesRE = /\.(html|vue|svelte|astro|imba)$/

// A simple regex to detect import sources. This is only used on
// <script lang="ts"> blocks in vue (setup only) or svelte files, since
// seemingly unused imports are dropped by esbuild when transpiling TS which
// prevents it from crawling further.
// We can't use es-module-lexer because it can't handle TS, and don't want to
// use Acorn because it's slow. Luckily this doesn't have to be bullet proof
// since even missed imports can be caught at runtime, and false positives will
// simply be ignored.
export const importsRE =
  /(?<!\/\/.*)(?<=^|;|\*\/)\s*import(?!\s+type)(?:[\w*{}\n\r\t, ]+from)?\s*("[^"]+"|'[^']+')\s*(?=$|;|\/\/|\/\*)/gm

export function scanImports(config: ResolvedConfig): {
  cancel: () => Promise<void>
  result: Promise<{
    deps: Record<string, string>
    missing: Record<string, string>
  }>
} {
  // Only used to scan non-ssr code

  const start = performance.now()
  const deps: Record<string, string> = {}
  const missing: Record<string, string> = {}
  let entries: string[]

  const scanContext = { cancelled: false }

  const context = computeEntries(config).then((computedEntries) => {
    entries = computedEntries

    if (!entries.length) {
      if (!config.optimizeDeps.entries && !config.optimizeDeps.include) {
        config.logger.warn(
          colors.yellow(
            '(!) Could not auto-determine entry point from rollupOptions or html files ' +
              'and there are no explicit optimizeDeps.include patterns. ' +
              'Skipping dependency pre-bundling.',
          ),
        )
      }
      return
    }
    if (scanContext.cancelled) return

    debug?.(
      `Crawling dependencies using entries: ${entries
        .map((entry) => `\n  ${colors.dim(entry)}`)
        .join('')}`,
    )
    return prepareRolldownScanner(config, entries, deps, missing, scanContext)
  })

  const result = context
    .then((context) => {
      if (!context || scanContext?.cancelled) {
        return { deps: {}, missing: {} }
      }
      return context
        .build()
        .then(() => {
          return {
            // Ensure a fixed order so hashes are stable and improve logs
            deps: orderedDependencies(deps),
            missing,
          }
        })
    })
    .catch(async (e) => {
      // if (e.errors && e.message.includes('The build was canceled')) {
      //   // esbuild logs an error when cancelling, but this is expected so
      //   // return an empty result instead
      //   return { deps: {}, missing: {} }
      // }

      const prependMessage = colors.red(`\
  Failed to scan for dependencies from entries:
  ${entries.join('\n')}

  `)
      // if (e.errors) {
      //   const msgs = await formatMessages(e.errors, {
      //     kind: 'error',
      //     color: true,
      //   })
      //   e.message = prependMessage + msgs.join('\n')
      // } else {
        e.message = prependMessage + e.message
      // }
      throw e
    })
    .finally(() => {
      if (debug) {
        const duration = (performance.now() - start).toFixed(2)
        const depsStr =
          Object.keys(orderedDependencies(deps))
            .sort()
            .map((id) => `\n  ${colors.cyan(id)} -> ${colors.dim(deps[id])}`)
            .join('') || colors.dim('no dependencies found')
        debug(`Scan completed in ${duration}ms: ${depsStr}`)
      }
    })

  return {
    cancel: async () => {
      scanContext.cancelled = true
      // return esbuildContext.then((context) => context?.cancel())
    },
    result,
  }
}

async function computeEntries(config: ResolvedConfig) {
  let entries: string[] = []

  const explicitEntryPatterns = config.optimizeDeps.entries
  const buildInput = config.build.rollupOptions?.input

  if (explicitEntryPatterns) {
    entries = await globEntries(explicitEntryPatterns, config)
  } else if (buildInput) {
    const resolvePath = (p: string) => path.resolve(config.root, p)
    if (typeof buildInput === 'string') {
      entries = [resolvePath(buildInput)]
    } else if (Array.isArray(buildInput)) {
      entries = buildInput.map(resolvePath)
    } else if (isObject(buildInput)) {
      entries = Object.values(buildInput).map(resolvePath)
    } else {
      throw new Error('invalid rollupOptions.input value.')
    }
  } else {
    entries = await globEntries('**/*.html', config)
  }

  // Non-supported entry file types and virtual files should not be scanned for
  // dependencies.
  entries = entries.filter(
    (entry) =>
      isScannable(entry, config.optimizeDeps.extensions) &&
      fs.existsSync(entry),
  )

  return entries
}

async function prepareRolldownScanner(
  config: ResolvedConfig,
  entries: string[],
  deps: Record<string, string>,
  missing: Record<string, string>,
  scanContext?: { cancelled: boolean },
): Promise<
  | {
      build: () => Promise<void>
    }
  | undefined
> {
  const container = await createPluginContainer(config)

  if (scanContext?.cancelled) return

  if (config.optimizeDeps.esbuildOptions) {
    config.logger.error(
      `You've set "optimizeDeps.esbuildOptions" in your config. ` +
        `This is deprecated and vite already use rollup to optimize packages. ` +
        `Please use "optimizeDeps.rollupOptions" instead.`,
    )
  }

  const { plugins: pluginsFromConfig = [], ...rollupOptions } =
    config.optimizeDeps.rollupOptions ?? {}

  const plugins = await asyncFlatten(
    Array.isArray(pluginsFromConfig) ? pluginsFromConfig : [pluginsFromConfig],
  )

  plugins.push(rolldownScanPlugin(config, container, deps, missing, entries))

  async function build() {
    await scan({
      input: entries,
      logLevel: 'silent',
      plugins,
      ...rollupOptions,
    })
  }

  return { build }
}

function orderedDependencies(deps: Record<string, string>) {
  const depsList = Object.entries(deps)
  // Ensure the same browserHash for the same set of dependencies
  depsList.sort((a, b) => a[0].localeCompare(b[0]))
  return Object.fromEntries(depsList)
}

function globEntries(pattern: string | string[], config: ResolvedConfig) {
  const resolvedPatterns = arraify(pattern)
  if (resolvedPatterns.every((str) => !glob.isDynamicPattern(str))) {
    return resolvedPatterns.map((p) =>
      normalizePath(path.resolve(config.root, p)),
    )
  }
  return glob(pattern, {
    cwd: config.root,
    ignore: [
      '**/node_modules/**',
      `**/${config.build.outDir}/**`,
      // if there aren't explicit entries, also ignore other common folders
      ...(config.optimizeDeps.entries
        ? []
        : [`**/__tests__/**`, `**/coverage/**`]),
    ],
    absolute: true,
    suppressErrors: true, // suppress EACCES errors
  })
}

export const scriptRE =
  /(<script(?:\s+[a-z_:][-\w:]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^"'<>=\s]+))?)*\s*>)(.*?)<\/script>/gis
export const commentRE = /<!--.*?-->/gs
const srcRE = /\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s'">]+))/i
const typeRE = /\btype\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s'">]+))/i
const langRE = /\blang\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s'">]+))/i
const contextRE = /\bcontext\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s'">]+))/i

function rolldownScanPlugin(
  config: ResolvedConfig,
  container: PluginContainer,
  depImports: Record<string, string>,
  missing: Record<string, string>,
  entries: string[],
): Plugin {
  const seen = new Map<string, string | undefined>()

  const resolve = async (
    id: string,
    importer?: string,
    options?: ResolveIdOptions,
  ) => {
    const key = id + (importer && path.dirname(importer))
    if (seen.has(key)) {
      return seen.get(key)
    }
    const resolved = await container.resolveId(
      id,
      importer && normalizePath(importer),
      {
        ...options,
        scan: true,
      },
    )
    const res = resolved?.id
    seen.set(key, res)
    return res
  }

  const include = config.optimizeDeps?.include
  const exclude = [
    ...(config.optimizeDeps?.exclude || []),
    '@vite/client',
    '@vite/env',
  ]

  const externalUnlessEntry = ({ path }: { path: string }) => ({
    id: path,
    external: !entries.includes(path),
  })

  const doTransformGlobImport = async (contents: string, id: string) => {
    const result = await transformGlobImport(contents, id, config.root, resolve)

    return result?.s.toString() || contents
  }

  const htmlTypeOnLoadCallback: (path: string) => Promise<string> = async (
    p,
  ) => {
    let raw = await fsp.readFile(p, 'utf-8')
    // Avoid matching the content of the comment
    raw = raw.replace(commentRE, '<!---->')
    const isHtml = p.endsWith('.html')
    scriptRE.lastIndex = 0
    let js = ''
    let scriptId = 0
    let match: RegExpExecArray | null
    while ((match = scriptRE.exec(raw))) {
      const [, openTag, content] = match
      const typeMatch = typeRE.exec(openTag)
      const type = typeMatch && (typeMatch[1] || typeMatch[2] || typeMatch[3])
      const langMatch = langRE.exec(openTag)
      const lang = langMatch && (langMatch[1] || langMatch[2] || langMatch[3])
      // skip non type module script
      if (isHtml && type !== 'module') {
        continue
      }
      // skip type="application/ld+json" and other non-JS types
      if (
        type &&
        !(
          type.includes('javascript') ||
          type.includes('ecmascript') ||
          type === 'module'
        )
      ) {
        continue
      }
      let loader: Loader = 'js'
      if (lang === 'ts' || lang === 'tsx' || lang === 'jsx') {
        loader = lang
      } else if (p.endsWith('.astro')) {
        loader = 'ts'
      }
      const srcMatch = srcRE.exec(openTag)
      if (srcMatch) {
        const src = srcMatch[1] || srcMatch[2] || srcMatch[3]
        js += `import ${JSON.stringify(src)}\n`
      } else if (content.trim()) {
        // The reason why virtual modules are needed:
        // 1. There can be module scripts (`<script context="module">` in Svelte and `<script>` in Vue)
        // or local scripts (`<script>` in Svelte and `<script setup>` in Vue)
        // 2. There can be multiple module scripts in html
        // We need to handle these separately in case variable names are reused between them

        // append imports in TS to prevent esbuild from removing them
        // since they may be used in the template
        let contents =
          content + (loader.startsWith('ts') ? extractImportPaths(content) : '')

        const key = `${p}?id=${scriptId++}&loader=${loader}`
        if (loader !== 'js') {
          contents = (await transform(contents, { loader })).code
        }
        if (contents.includes('import.meta.glob')) {
          scripts[key] = {
            contents: await doTransformGlobImport(contents, p),
            loader
          }
        } else {
          scripts[key] = {
            contents, loader
          }
        }

        const virtualModulePath = JSON.stringify(virtualModulePrefix + key)

        const contextMatch = contextRE.exec(openTag)
        const context =
          contextMatch &&
          (contextMatch[1] || contextMatch[2] || contextMatch[3])

        // Especially for Svelte files, exports in <script context="module"> means module exports,
        // exports in <script> means component props. To avoid having two same export name from the
        // star exports, we need to ignore exports in <script>
        if (p.endsWith('.svelte') && context !== 'module') {
          js += `import ${virtualModulePath}\n`
        } else {
          js += `export * from ${virtualModulePath}\n`
        }
      }
    }

    // This will trigger incorrectly if `export default` is contained
    // anywhere in a string. Svelte and Astro files can't have
    // `export default` as code so we know if it's encountered it's a
    // false positive (e.g. contained in a string)
    if (!p.endsWith('.vue') || !js.includes('export default')) {
      js += '\nexport default {}'
    }

    return js
  }

  const scripts: Record<string, {
    contents: string,
    loader: Loader,
  }> = {}

  const ASSET_TYPE_RE = new RegExp(`\\.(${KNOWN_ASSET_TYPES.join('|')})$`)

  return {
    name: 'vite:dep-scan',
    resolveId: async function (id, importer, options) {
      // Make sure virtual module importer can be resolve
      importer =
        importer && virtualModuleRE.test(importer)
          ? importer.replace(virtualModulePrefix, '')
          : importer
      // external urls
      if (externalRE.test(id)) {
        return {
          id,
          external: true,
        }
      }

      // data urls
      if (dataUrlRE.test(id)) {
        return {
          id,
          external: true,
        }
      }

      // local scripts (`<script>` in Svelte and `<script setup>` in Vue)
      if (virtualModuleRE.test(id)) {
        return {
          id,
        }
      }

      // html types: extract script contents -----------------------------------
      if (htmlTypesRE.test(id)) {
        const resolved = await resolve(id, importer)
        if (!resolved) return
        // It is possible for the scanner to scan html types in node_modules.
        // If we can optimize this html type, skip it so it's handled by the
        // bare import resolve, and recorded as optimization dep.
        if (
          isInNodeModules(resolved) &&
          isOptimizable(resolved, config.optimizeDeps)
        )
          return
        return {
          id: resolved,
        }
      }

      // bare imports: record and externalize ----------------------------------
      // avoid matching windows volume

      if (/^[\w@][^:]/.test(id)) {
        if (moduleListContains(exclude, id)) {
          return externalUnlessEntry({ path: id })
        }
        if (depImports[id]) {
          return externalUnlessEntry({ path: id })
        }
        const resolved = await resolve(id, importer, {
          custom: {
            depScan: importer ? { loader: scripts[importer]?.loader } : {},
          },
        })
        if (resolved) {
          if (shouldExternalizeDep(resolved, id)) {
            return externalUnlessEntry({ path: id })
          }
          if (isInNodeModules(resolved) || include?.includes(id)) {
            // dependency or forced included, externalize and stop crawling
            if (isOptimizable(resolved, config.optimizeDeps)) {
              depImports[id] = resolved
            }
            return externalUnlessEntry({ path: id })
          } else if (isScannable(resolved, config.optimizeDeps.extensions)) {
            // linked package, keep crawling
            return {
              id: path.resolve(resolved),
            }
          } else {
            return externalUnlessEntry({ path: id })
          }
        } else {
          missing[id] = normalizePath(importer!)
        }
      }

      // Externalized file types -----------------------------------------------
      // these are done on raw ids using esbuild's native regex filter so it
      // should be faster than doing it in the catch-all via js
      // they are done after the bare import resolve because a package name
      // may end with these extensions

      // css
      if (CSS_LANGS_RE.test(id)) {
        return externalUnlessEntry({ path: id })
      }

      // json & wasm
      if (/\.(?:json|json5|wasm)$/.test(id)) {
        return externalUnlessEntry({ path: id })
      }

      // known asset types

      if (ASSET_TYPE_RE.test(id)) {
        return externalUnlessEntry({ path: id })
      }

      // known vite query types: ?worker, ?raw

      if (SPECIAL_QUERY_RE.test(id)) {
        return {
          id,
          external: true,
        }
      }

      // catch all -------------------------------------------------------------

      // use vite resolver to support urls and omitted extensions
      const resolved = await resolve(id, importer, {
        custom: {
          depScan: importer ? { loader: scripts[importer]?.loader } : {},
        },
      })
      if (resolved) {
        if (
          shouldExternalizeDep(resolved, id) ||
          !isScannable(resolved, config.optimizeDeps.extensions)
        ) {
          return externalUnlessEntry({ path: id })
        }

        return {
          id: path.resolve(cleanUrl(resolved)),
        }
      } else {
        // resolve failed... probably unsupported type
        return externalUnlessEntry({ path: id })
      }
    },
    load: async function (id) {
      if (virtualModuleRE.test(id)) {
        return {
          code: scripts[id.replace(virtualModulePrefix, '')].contents,
        }
      }

      // extract scripts inside HTML-like files and treat it as a js module
      if (htmlTypesRE.test(id)) {
        return {
          code: await htmlTypeOnLoadCallback(id),
        }
      }

      // for jsx/tsx, we need to access the content and check for
      // presence of import.meta.glob, since it results in import relationships
      // but isn't crawled by esbuild.
      if (JS_TYPES_RE.test(id)) {
        let ext = path.extname(id).slice(1)
        if (ext === 'mjs') ext = 'js'

        let contents = await fsp.readFile(id, 'utf-8')
        if (ext.endsWith('x') && config.esbuild && config.esbuild.jsxInject) {
          contents = config.esbuild.jsxInject + `\n` + contents
        }

        const loader = ext as Loader

        if (loader !== 'js') {
          let tsconfigRaw
          const tsconfigResult = await loadTsconfigJsonForFile(
                  path.join(config.root, '_dummy.js'),
          )
          if (tsconfigResult.compilerOptions?.experimentalDecorators) {
            tsconfigRaw = { compilerOptions: { experimentalDecorators: true } }
          }
          contents = (await transform(contents, { loader, tsconfigRaw })).code
        }

        if (contents.includes('import.meta.glob')) {
          return {
            code: await doTransformGlobImport(contents, id),
          }
        }

        return {
          code: contents,
        }
      }
    },
  }
}


/**
 * when using TS + (Vue + `<script setup>`) or Svelte, imports may seem
 * unused to esbuild and dropped in the build output, which prevents
 * esbuild from crawling further.
 * the solution is to add `import 'x'` for every source to force
 * esbuild to keep crawling due to potential side effects.
 */
function extractImportPaths(code: string) {
  // empty singleline & multiline comments to avoid matching comments
  code = code
    .replace(multilineCommentsRE, '/* */')
    .replace(singlelineCommentsRE, '')

  let js = ''
  let m
  importsRE.lastIndex = 0
  while ((m = importsRE.exec(code)) != null) {
    js += `\nimport ${m[1]}`
  }
  return js
}

function shouldExternalizeDep(resolvedId: string, rawId: string): boolean {
  // not a valid file path
  if (!path.isAbsolute(resolvedId)) {
    return true
  }
  // virtual id
  if (resolvedId === rawId || resolvedId.includes('\0')) {
    return true
  }
  return false
}

function isScannable(id: string, extensions: string[] | undefined): boolean {
  return (
    JS_TYPES_RE.test(id) ||
    htmlTypesRE.test(id) ||
    extensions?.includes(path.extname(id)) ||
    false
  )
}