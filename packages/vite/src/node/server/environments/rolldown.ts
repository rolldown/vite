/* eslint-disable no-console */
import assert from 'node:assert'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import MagicString from 'magic-string'
import * as rolldown from 'rolldown'
import sirv from 'sirv'
import { createLogger } from '../../publicUtils'
import { DevEnvironment } from '../environment'
import type {
  ConfigEnv,
  DevEnvironmentOptions,
  HmrContext,
  UserConfig,
  ViteDevServer,
} from '../..'
import { CLIENT_ENTRY } from '../../constants'
import { injectEnvironmentToHooks } from '../../build'

const require = createRequire(import.meta.url)

export interface RolldownDevOptions {
  hmr?: boolean
  reactRefresh?: boolean
  ssrModuleRunner?: boolean
}

// TODO: polish logging
const logger = createLogger('info', {
  prefix: '[rolldown]',
  allowClearScreen: false,
})

//
// Vite plugin hooks
//

export function rolldownDevHandleConfig(
  config: UserConfig,
  env: ConfigEnv,
): UserConfig {
  if (!config.experimental?.rolldownDev) {
    return {}
  }
  if (env.command === 'build' || env.isPreview) {
    delete config.experimental?.rolldownDev
    return {}
  }
  return {
    appType: 'custom',
    optimizeDeps: {
      noDiscovery: true,
      include: [],
    },
    experimental: {
      enableNativePlugin: true,
    },
    environments: {
      client: {
        dev: {
          createEnvironment: RolldownEnvironment.createFactory({
            hmr: config.experimental?.rolldownDev?.hmr,
            reactRefresh: config.experimental?.rolldownDev?.reactRefresh,
            ssrModuleRunner: false,
          }),
        },
        build: {
          modulePreload: false,
          assetsInlineLimit: 0,
          rollupOptions: {
            input:
              config.build?.rollupOptions?.input ??
              config.environments?.client.build?.rollupOptions?.input ??
              './index.html',
          },
        },
      },
      ssr: {
        dev: {
          createEnvironment: RolldownEnvironment.createFactory({
            hmr: false,
            reactRefresh: false,
            ssrModuleRunner: config.experimental?.rolldownDev?.ssrModuleRunner,
          }),
        },
      },
    },
  }
}

// type casting helper
function asRolldown(server: ViteDevServer): Omit<
  ViteDevServer,
  'environments'
> & {
  environments: {
    client: RolldownEnvironment
    ssr: RolldownEnvironment
  }
} {
  return server as any
}

export function rolldownDevConfigureServer(server: ViteDevServer): void {
  const { environments } = asRolldown(server)

  // rolldown server as middleware
  server.middlewares.use(
    sirv(environments.client.outDir, { dev: true, extensions: ['html'] }),
  )

  // full build on non self accepting entry
  server.ws.on('rolldown:hmr-deadend', async (data) => {
    logger.info(`hmr-deadend '${data.moduleId}'`, { timestamp: true })
    await environments.client.build()
    server.ws.send({ type: 'full-reload' })
  })
}

export async function rolldownDevHandleHotUpdate(
  ctx: HmrContext,
): Promise<void> {
  const { environments } = asRolldown(ctx.server)
  await environments.ssr.handleUpdate(ctx)
  await environments.client.handleUpdate(ctx)
}

//
// Rolldown dev environment
//

class RolldownEnvironment extends DevEnvironment {
  instance!: rolldown.RolldownBuild
  result!: rolldown.RolldownOutput
  outDir!: string
  buildTimestamp = Date.now()
  inputOptions!: rolldown.InputOptions
  outputOptions!: rolldown.OutputOptions

  static createFactory(
    rolldownDevOptioins: RolldownDevOptions,
  ): NonNullable<DevEnvironmentOptions['createEnvironment']> {
    return (name, config) =>
      new RolldownEnvironment(rolldownDevOptioins, name, config)
  }

  constructor(
    public rolldownDevOptions: RolldownDevOptions,
    name: ConstructorParameters<typeof DevEnvironment>[0],
    config: ConstructorParameters<typeof DevEnvironment>[1],
  ) {
    super(name, config, { hot: false })
    this.outDir = path.join(this.config.root, this.config.build.outDir)
  }

  override init: DevEnvironment['init'] = async () => {
    await super.init()
    // patch out plugin container hooks
    assert(this._pluginContainer)
    this._pluginContainer.buildStart = async () => {}
    this._pluginContainer.close = async () => {}
    await this.build()
  }

  override close: DevEnvironment['init'] = async () => {
    await super.close()
    await this.instance?.close()
  }

  async build(): Promise<void> {
    if (!this.config.build.rollupOptions.input) {
      return
    }

    await this.instance?.close()

    if (this.config.build.emptyOutDir !== false) {
      fs.rmSync(this.outDir, { recursive: true, force: true })
    }

    // all plugins are shared like Vite 6 `sharedConfigBuild`.
    let plugins = this._plugins!
    // TODO: enable more core plugins
    plugins = plugins.filter(
      (p) =>
        !(typeof p.name === 'number' || p.name?.startsWith('vite:')) ||
        [
          'vite:define',
          'vite:build-html',
          'vite:build-metadata',
          'vite:css',
          'vite:css-post',
          'vite:asset',
        ].includes(p.name) ||
        [
          'AliasPlugin',
          'TransformPlugin',
          'LoadFallbackPlugin',
          'ManifestPlugin',
        ].includes(p.constructor.name),
    )
    plugins = plugins.map((p) => injectEnvironmentToHooks(this as any, p))

    console.time(`[rolldown:${this.name}:build]`)
    this.inputOptions = {
      dev: this.rolldownDevOptions.hmr,
      input: this.config.build.rollupOptions.input,
      cwd: this.config.root,
      platform: this.name === 'client' ? 'browser' : 'node',
      resolve: {
        conditionNames: this.config.resolve.conditions,
        mainFields: this.config.resolve.mainFields,
        symlinks: !this.config.resolve.preserveSymlinks,
      },
      plugins: [
        ...plugins,
        patchRuntimePlugin(this),
        patchCssPlugin(),
        reactRefreshPlugin(),
      ],
      moduleTypes: {
        '.css': 'js',
      },
    }
    this.instance = await rolldown.rolldown(this.inputOptions)

    const format: rolldown.ModuleFormat =
      this.name === 'client' || this.rolldownDevOptions.ssrModuleRunner
        ? 'app'
        : 'esm'
    this.outputOptions = {
      dir: this.outDir,
      format,
      // TODO: hmr_rebuild returns source map file when `sourcemap: true`
      sourcemap: 'inline',
      // TODO: https://github.com/rolldown/rolldown/issues/2041
      // handle `require("stream")` in `react-dom/server`
      banner:
        this.name === 'ssr' && format === 'esm'
          ? `import __nodeModule from "node:module"; const require = __nodeModule.createRequire(import.meta.url);`
          : undefined,
    }
    // `generate` should work but we use `write` so it's easier to see output and debug
    this.result = await this.instance.write(this.outputOptions)

    this.buildTimestamp = Date.now()
    console.timeEnd(`[rolldown:${this.name}:build]`)
  }

  async handleUpdate(ctx: HmrContext): Promise<void> {
    if (!this.result) {
      return
    }
    const output = this.result.output[0]
    if (!output.moduleIds.includes(ctx.file)) {
      return
    }
    if (
      this.rolldownDevOptions.hmr ||
      this.rolldownDevOptions.ssrModuleRunner
    ) {
      logger.info(`hmr '${ctx.file}'`, { timestamp: true })
      console.time(`[rolldown:${this.name}:hmr]`)
      const result = await this.instance.experimental_hmr_rebuild([ctx.file])
      if (this.name === 'client') {
        ctx.server.ws.send('rolldown:hmr', result)
      } else {
        this.getRunner().evaluate(
          result[1].toString(),
          path.join(this.outDir, result[0]),
        )
      }
      console.timeEnd(`[rolldown:${this.name}:hmr]`)
    } else {
      await this.build()
      if (this.name === 'client') {
        ctx.server.ws.send({ type: 'full-reload' })
      }
    }
  }

  runner!: RolldownModuleRunner

  getRunner() {
    if (!this.runner) {
      const output = this.result.output[0]
      const filepath = path.join(this.outDir, output.fileName)
      this.runner = new RolldownModuleRunner()
      const code = fs.readFileSync(filepath, 'utf-8')
      this.runner.evaluate(code, filepath)
    }
    return this.runner
  }

  async import(input: string): Promise<unknown> {
    if (this.outputOptions.format === 'app') {
      return this.getRunner().import(input)
    }
    // input is no use
    const output = this.result.output[0]
    const filepath = path.join(this.outDir, output.fileName)
    // TODO: source map not applied when adding `?t=...`?
    // return import(`${pathToFileURL(filepath)}`)
    return import(`${pathToFileURL(filepath)}?t=${this.buildTimestamp}`)
  }
}

class RolldownModuleRunner {
  // intercept globals
  private context = {
    rolldown_runtime: {} as any,
    __rolldown_hot: {
      send: () => {},
    },
    // TODO: external require doesn't work in app format.
    // TODO: also it should be aware of importer for non static require/import.
    _require: require,
  }

  // TODO: support resolution?
  async import(id: string): Promise<unknown> {
    const mod = this.context.rolldown_runtime.moduleCache[id]
    assert(mod, `Module not found '${id}'`)
    return mod.exports
  }

  evaluate(code: string, sourceURL: string) {
    const context = {
      self: this.context,
      ...this.context,
    }
    // extract sourcemap and move to the bottom
    const sourcemap = code.match(/^\/\/# sourceMappingURL=.*/m)?.[0] ?? ''
    if (sourcemap) {
      code = code.replace(sourcemap, '')
    }
    code = `\
'use strict';(${Object.keys(context).join(',')})=>{{${code}
// TODO: need to re-expose runtime utilities for now
self.__toCommonJS = __toCommonJS;
self.__export = __export;
self.__toESM = __toESM;
}}
//# sourceURL=${sourceURL}
//# sourceMappingSource=rolldown-module-runner
${sourcemap}
`
    const fn = (0, eval)(code)
    try {
      fn(...Object.values(context))
    } catch (e) {
      console.error('[RolldownModuleRunner:ERROR]', e)
      throw e
    }
  }
}

function patchRuntimePlugin(environment: RolldownEnvironment): rolldown.Plugin {
  return {
    name: 'vite:rolldown-patch-runtime',
    // TODO: external require doesn't work in app format.
    // rewrite `require -> _require` and provide _require from module runner.
    // for now just rewrite known ones in "react-dom/server".
    transform: {
      filter: {
        code: {
          include: [/require\(['"](stream|util)['"]\)/],
        },
      },
      handler(code) {
        if (!environment.rolldownDevOptions.ssrModuleRunner) {
          return
        }
        return code.replace(
          /require(\(['"](stream|util)['"]\))/g,
          '_require($1)',
        )
      },
    },
    renderChunk(code) {
      // patch rolldown_runtime to workaround a few things
      // TODO: is there a robust way to inject code specifically to entry or runtime?
      if (code.includes('//#region rolldown:runtime')) {
        // TODO: this magic string is heavy
        const output = new MagicString(code)
        output
          // replace hard-coded WebSocket setup with custom client
          .replace(
            /const socket =.*?\n\};/s,
            environment.name === 'client' ? getRolldownClientCode() : '',
          )
          // fix rolldown_runtime.patch
          .replace(
            'this.executeModuleStack.length > 1',
            'this.executeModuleStack.length > 0',
          )
          .replace('parents: [parent],', 'parents: parent ? [parent] : [],')
          .replace(
            'if (module.parents.indexOf(parent) === -1) {',
            'if (parent && module.parents.indexOf(parent) === -1) {',
          )
          .replace(
            'for (var i = 0; i < module.parents.length; i++) {',
            `
            boundaries.push(moduleId);
            invalidModuleIds.push(moduleId);
            if (module.parents.filter(Boolean).length === 0) {
              __rolldown_hot.send("rolldown:hmr-deadend", { moduleId });
              break;
            }
            for (var i = 0; i < module.parents.length; i++) {`,
          )
        if (environment.rolldownDevOptions.reactRefresh) {
          output.prepend(getReactRefreshRuntimeCode())
        }
        return {
          code: output.toString(),
          map: output.generateMap({ hires: 'boundary' }),
        }
      }
    },
  }
}

// patch vite:css transform for hmr
function patchCssPlugin(): rolldown.Plugin {
  return {
    name: 'vite:rolldown-patch-css',
    transform: {
      filter: {
        id: {
          include: ['*.css'],
        },
        code: {
          include: ['__vite__updateStyle'],
        },
      },
      handler(code, id) {
        // TODO: import.meta.hot.prune
        const cssCode = code.match(/^const __vite__css = (.*)$/m)![1]
        const jsCode = `
          __rolldown_updateStyle(${JSON.stringify(id)}, ${cssCode});
          module.hot.accept();
        `
        return { code: jsCode, moduleSideEffects: true }
      },
    },
  }
}

// reuse /@vite/client for Websocket API
function getRolldownClientCode() {
  let code = fs.readFileSync(CLIENT_ENTRY, 'utf-8')
  const replacements = {
    // TODO: packages/vite/src/node/plugins/clientInjections.ts
    __BASE__: `"/"`,
    __SERVER_HOST__: `""`,
    __HMR_PROTOCOL__: `null`,
    __HMR_HOSTNAME__: `null`,
    __HMR_PORT__: `new URL(self.location.href).port`,
    __HMR_DIRECT_TARGET__: `""`,
    __HMR_BASE__: `"/"`,
    __HMR_TIMEOUT__: `30000`,
    __HMR_ENABLE_OVERLAY__: `true`,
    __HMR_CONFIG_NAME__: `""`,
  }
  for (const [k, v] of Object.entries(replacements)) {
    code = code.replaceAll(k, v)
  }
  // runtime define is not necessary
  code = code.replace(/^import\s*['"]@vite\/env['"]/gm, '')
  // remove esm
  code = code.replace(/^export\s*\{[^}]*\}/gm, '')
  code = code.replace(/\bimport.meta.url\b/g, 'self.location.href')
  code = code.replace(/^\/\/#.*/gm, '')
  // inject own hmr event handler
  code += `
const hot = createHotContext("/__rolldown");
hot.on("rolldown:hmr", (data) => {
  (0, eval)(data[1]);
});
self.__rolldown_hot = hot;
self.__rolldown_updateStyle = updateStyle;
`
  return `(() => {/*** @vite/client ***/\n${code}}\n)()`
}

function reactRefreshPlugin(): rolldown.Plugin {
  return {
    name: 'vite:rolldown-react-refresh',
    transform: {
      filter: {
        code: {
          include: ['$RefreshReg$'],
        },
      },
      handler(code, id) {
        const output = new MagicString(code)
        output.prepend(
          `const [$RefreshSig$, $RefreshReg$] = __react_refresh_transform_define(${JSON.stringify(id)});`,
        )
        output.append(`;__react_refresh_transform_setupHot(module.hot);`)
        return {
          code: output.toString(),
          map: output.generateMap({ hires: 'boundary' }),
        }
      },
    },
  }
}

// inject react refresh runtime in client runtime to ensure initialized early
function getReactRefreshRuntimeCode() {
  const code = fs.readFileSync(
    path.resolve(
      require.resolve('react-refresh/runtime'),
      '..',
      'cjs/react-refresh-runtime.development.js',
    ),
    'utf-8',
  )
  const output = new MagicString(code)
  output.prepend('self.__react_refresh_runtime = {};\n')
  output.replaceAll('process.env.NODE_ENV !== "production"', 'true')
  output.replaceAll(/\bexports\./g, '__react_refresh_runtime.')
  output.append(`
    (() => {
      __react_refresh_runtime.injectIntoGlobalHook(self);

      __react_refresh_transform_define = (file) => [
        __react_refresh_runtime.createSignatureFunctionForTransform,
        (type, id) => __react_refresh_runtime.register(type, file + '_' + id)
      ];

      __react_refresh_transform_setupHot = (hot) => {
        hot.accept((prev) => {
          debouncedRefresh();
        });
      };

      function debounce(fn, delay) {
        let handle
        return () => {
          clearTimeout(handle)
          handle = setTimeout(fn, delay)
        }
      }
      const debouncedRefresh = debounce(__react_refresh_runtime.performReactRefresh, 16);
    })()
  `)
  return output.toString()
}
