import path from 'node:path'
import { transform } from 'rolldown/experimental'
import type { RawSourceMap } from '@ampproject/remapping'
import type { SourceMap } from 'rolldown'
import { combineSourcemaps, createFilter } from '../utils'
import type { ResolvedConfig } from '../config'
import type { Plugin, PluginContext } from '../plugin'
import { cleanUrl } from '../../shared/utils'
import type { Logger } from '..'
import type { ESBuildOptions } from './esbuild'
import {
  loadTsconfigJsonForFile,
  reloadOnTsconfigChange,
  setServer,
} from './esbuild'

const jsxExtensionsRE = /\.(?:j|t)sx\b/
const validExtensionRE = /\.\w+$/

// should import from rolldown
declare type OxcTransformOptions = any
declare type OxcTransformResult = any

export interface OxcOptions extends OxcTransformOptions {
  include?: string | RegExp | string[] | RegExp[]
  exclude?: string | RegExp | string[] | RegExp[]
  jsxInject?: string
}

export async function transformWithOxc(
  ctx: PluginContext,
  code: string,
  filename: string,
  options?: OxcTransformOptions,
  inMap?: object,
): Promise<OxcTransformResult> {
  const resolvedOptions = {
    sourcemap: true,
    ...options,
  }

  const ext = path
    .extname(validExtensionRE.test(filename) ? filename : cleanUrl(filename))
    .slice(1)

  if (ext === 'cts' || ext === 'mts' || ext === 'tsx' || ext === 'ts') {
    const loadedTsconfig = await loadTsconfigJsonForFile(filename)
    const loadedCompilerOptions = loadedTsconfig.compilerOptions ?? {}
    // tsc compiler alwaysStrict/experimentalDecorators/importsNotUsedAsValues/preserveValueImports/target/useDefineForClassFields/verbatimModuleSyntax

    resolvedOptions.react = {
      pragma: loadedCompilerOptions.jsxFactory,
      pragmaFrag: loadedCompilerOptions.jsxFragmentFactory,
      importSource: loadedCompilerOptions.jsxImportSource,
    }

    switch (loadedCompilerOptions.jsx) {
      case 'react-jsxdev':
        resolvedOptions.react.runtime = 'automatic'
        resolvedOptions.react.development = true
        break

      case 'react':
        resolvedOptions.react.runtime = 'classic'
        break

      case 'react-jsx':
        resolvedOptions.react.runtime = 'automatic'
        break
      case 'preserve':
        ctx.warn('The tsconfig jsx preserve is not supported at oxc')
        break

      default:
        break
    }
  }

  const result = await transform(filename, code, resolvedOptions)

  if (result.errors.length > 0) {
    throw new Error(result.errors[0])
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
  const { jsxInject, include, exclude, ...oxcTransformOptions } = options

  const filter = createFilter(include || /\.(m?ts|[jt]sx)$/, exclude || /\.js$/)

  return {
    name: 'vite:oxc',
    configureServer(server) {
      setServer(server)
      server.watcher
        .on('add', reloadOnTsconfigChange)
        .on('change', reloadOnTsconfigChange)
        .on('unlink', reloadOnTsconfigChange)
    },
    buildEnd() {
      // recycle serve to avoid preventing Node self-exit (#6815)
      setServer(null)
    },
    async transform(code, id) {
      if (filter(id) || filter(cleanUrl(id))) {
        const result = await transformWithOxc(
          this,
          code,
          id,
          oxcTransformOptions,
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
    react: {},
  }

  switch (esbuildTransformOptions.jsx) {
    case 'automatic':
      oxcOptions.react.runtime = 'automatic'
      break

    case 'transform':
      oxcOptions.react.runtime = 'classic'
      break

    case 'preserve':
      logger.warn('The esbuild jsx preserve is not supported at oxc')
      break

    default:
      break
  }

  if (esbuildTransformOptions.jsxDev) {
    oxcOptions.react.development = true
  }
  if (esbuildTransformOptions.jsxFactory) {
    oxcOptions.react.pragma = esbuildTransformOptions.jsxFactory
  }
  if (esbuildTransformOptions.jsxFragment) {
    oxcOptions.react.pragmaFrag = esbuildTransformOptions.jsxFragment
  }
  if (esbuildTransformOptions.jsxImportSource) {
    oxcOptions.react.importSource = esbuildTransformOptions.jsxImportSource
  }

  switch (esbuildTransformOptions.sourcemap) {
    case true:
    case false:
      oxcOptions.sourcemap = esbuildTransformOptions.sourcemap
      break

    default:
      logger.warn(
        `The esbuild sourcemap ${esbuildTransformOptions.sourcemap} is not supported at oxc`,
      )
      break
  }

  return oxcOptions
}
