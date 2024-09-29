import path from 'node:path'
import { transform } from 'rolldown/experimental'
import type { RawSourceMap } from '@ampproject/remapping'
import type { SourceMap } from 'rolldown'
import { combineSourcemaps, createFilter } from '../utils'
import type { ResolvedConfig } from '../config'
import type { Plugin } from '../plugin'
import { cleanUrl } from '../../shared/utils'
import { loadTsconfigJsonForFile } from './esbuild'

const jsxExtensionsRE = /\.(?:j|t)sx\b/
const validExtensionRE = /\.\w+$/

// should import from rolldown
declare type TransformOptions = any
declare type TransformResult = any

export interface OxcOptions extends TransformOptions {
  include?: string | RegExp | string[] | RegExp[]
  exclude?: string | RegExp | string[] | RegExp[]
  jsxInject?: string
}

export async function transformWithOxc(
  code: string,
  filename: string,
  options?: TransformOptions,
  inMap?: object,
): Promise<TransformResult> {
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
      development: loadedCompilerOptions.jsx === 'react-jsxdev',
      runtime: loadedCompilerOptions.jsx === 'react-jsxdev',
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
        // not support
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
    async transform(code, id) {
      if (filter(id) || filter(cleanUrl(id))) {
        const result = await transformWithOxc(code, id, oxcTransformOptions)
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
