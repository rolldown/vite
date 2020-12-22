import fs from 'fs'
import path from 'path'
import { resolveConfig, UserConfig } from '../config'
import Rollup, { Plugin, RollupBuild, RollupOptions } from 'rollup'
import { sizeReporPlugin } from '../plugins/size'
import { buildDefinePlugin } from '../plugins/define'
import chalk from 'chalk'
import { buildHtmlPlugin } from '../plugins/html'
import { buildEsbuildPlugin } from '../plugins/esbuild'
import { terserPlugin } from '../plugins/terser'
import { Terser } from 'types/terser'
import { copyDir, emptyDir } from '../utils'
import { buildManifestPlugin } from '../plugins/manifest'

export interface BuildOptions {
  /**
   * Entry. Use this to specify a js entry file in use cases where an
   * `index.html` does not exist (e.g. serving vite assets from a different host)
   * @default 'index.html'
   */
  entry?: string
  /**
   * Base public path when served in production.
   * @default '/'
   */
  base?: string
  /**
   * Directory relative from `root` where build output will be placed. If the
   * directory exists, it will be removed before the build.
   * @default 'dist'
   */
  outDir?: string
  /**
   * Directory relative from `outDir` where the built js/css/image assets will
   * be placed.
   * @default 'assets'
   */
  assetsDir?: string
  /**
   * Static asset files smaller than this number (in bytes) will be inlined as
   * base64 strings. Default limit is `4096` (4kb). Set to `0` to disable.
   * @default 4096
   */
  assetsInlineLimit?: number
  /**
   * Whether to code-split CSS. When enabled, CSS in async chunks will be
   * inlined as strings in the chunk and inserted via dynamically created
   * style tags when the chunk is loaded.
   * @default true
   */
  cssCodeSplit?: boolean
  /**
   * Whether to generate sourcemap
   * @default false
   */
  sourcemap?: boolean | 'inline'
  /**
   * Set to `false` to disable minification, or specify the minifier to use.
   * Available options are 'terser' or 'esbuild'.
   * @default 'terser'
   */
  minify?: boolean | 'terser' | 'esbuild'
  /**
   * The option for `terser`
   */
  terserOptions?: Terser.MinifyOptions
  /**
   * Build for server-side rendering, only as a CLI flag
   * for programmatic usage, use `ssrBuild` directly.
   * @internal
   */
  ssr?: boolean
  /**
   * Will be merged with internal rollup options.
   * https://rollupjs.org/guide/en/#big-list-of-options
   */
  rollupOptions?: RollupOptions
  /**
   * Whether to write bundle to disk
   * @default true
   */
  write?: boolean
  /**
   * Whether to emit index.html
   * @default true
   */
  emitIndex?: boolean
  /**
   * Whether to emit assets other than JavaScript
   * @default true
   */
  emitAssets?: boolean
  /**
   * Whether to emit a manifest.json under assets dir to map hash-less filenames
   * to their hashed versions. Useful when you want to generate your own HTML
   * instead of using the one generated by Vite.
   *
   * Example:
   *
   * ```json
   * {
   *   "main.js": "main.68fe3fad.js",
   *   "style.css": "style.e6b63442.css"
   * }
   * ```
   * @default false
   */
  emitManifest?: boolean
}

export type BuildHook = (options: BuildOptions) => BuildOptions | void

export function resolveBuildOptions(
  raw?: BuildOptions
): Required<BuildOptions> {
  const resolved: Required<BuildOptions> = {
    entry: 'index.html',
    base: '/',
    outDir: 'dist',
    assetsDir: 'assets',
    assetsInlineLimit: 4096,
    cssCodeSplit: true,
    sourcemap: false,
    minify: 'terser',
    terserOptions: {},
    ssr: false,
    rollupOptions: {},
    write: true,
    emitIndex: true,
    emitAssets: true,
    emitManifest: false,
    ...raw
  }

  // ensure base ending slash
  resolved.base = resolved.base.replace(/([^/])$/, '$1/')

  return resolved
}

/**
 * Track parallel build calls and only stop the esbuild service when all
 * builds are done. (#1098)
 */
let parallelCallCounts = 0
// we use a separate counter to track since the call may error before the
// bundle is even pushed.
const paralellBuilds: RollupBuild[] = []

/**
 * Bundles the app for production.
 * Returns a Promise containing the build result.
 */
export async function build(
  inlineConfig: UserConfig & { mode?: string } = {},
  configPath?: string | false
) {
  parallelCallCounts++
  try {
    return await doBuild(inlineConfig, configPath)
  } finally {
    parallelCallCounts--
    if (parallelCallCounts <= 0) {
      paralellBuilds.forEach((bundle) => bundle.close())
      paralellBuilds.length = 0
    }
  }
}

async function doBuild(
  inlineConfig: UserConfig & { mode?: string } = {},
  configPath?: string | false
) {
  const mode = inlineConfig.mode || 'production'
  const config = await resolveConfig(inlineConfig, 'build', mode, configPath)
  const options = config.build

  const resolve = (p: string) => path.resolve(config.root, p)

  const input = resolve(options.entry)
  const outDir = resolve(options.outDir)
  const publicDir = resolve('public')

  const plugins = [
    ...(config.plugins as Plugin[]),
    ...(options.rollupOptions.plugins || []),
    buildHtmlPlugin(config),
    buildDefinePlugin(config),
    buildEsbuildPlugin(config),
    ...(options.minify && options.minify !== 'esbuild'
      ? [terserPlugin(options.terserOptions)]
      : []),
    ...(options.emitManifest ? [buildManifestPlugin()] : []),
    sizeReporPlugin(config)
  ]

  const rollup = require('rollup') as typeof Rollup

  try {
    const bundle = await rollup.rollup({
      input,
      preserveEntrySignatures: false,
      treeshake: { moduleSideEffects: 'no-external' },
      ...options.rollupOptions,
      plugins
    })

    paralellBuilds.push(bundle)

    if (options.write) {
      emptyDir(outDir)
      if (fs.existsSync(publicDir)) {
        copyDir(publicDir, outDir)
      }
    }

    await bundle[options.write ? 'write' : 'generate']({
      dir: outDir,
      format: 'es',
      sourcemap: options.sourcemap,
      entryFileNames: path.posix.join(options.assetsDir, `[name].[hash].js`),
      chunkFileNames: path.posix.join(options.assetsDir, `[name].[hash].js`),
      assetFileNames: path.posix.join(options.assetsDir, `[name].[hash].[ext]`),
      // #764 add `Symbol.toStringTag` when build es module into cjs chunk
      // #1048 add `Symbol.toStringTag` for module default export
      namespaceToStringTag: true,
      ...options.rollupOptions.output
    })
  } catch (e) {
    config.logger.error(
      chalk.red(`${e.plugin ? `[${e.plugin}] ` : ``}${e.message}`)
    )
    if (e.id) {
      const loc = e.loc ? `:${e.loc.line}:${e.loc.column}` : ``
      config.logger.error(`file: ${chalk.cyan(`${e.id}${loc}`)}`)
    }
    if (e.frame) {
      config.logger.error(chalk.yellow(e.frame))
    }
    throw e
  }
}
