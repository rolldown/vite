import { debuglog } from 'node:util'
import { defineConfig } from 'vite'

process.setSourceMapsEnabled(true)

const debug = debuglog('dev')

export default defineConfig({
  environments: {
    client: {
      build: {
        outDir: 'dist/client',
        rollupOptions: {
          input: './src/entry-client',
        },
      },
    },
    ssr: {
      build: {
        outDir: 'dist/server',
        rollupOptions: {
          input: {
            index: './src/entry-server',
          },
        },
      },
    },
  },
  experimental: {
    rolldownDev: {
      hmr: true,
      reactRefresh: true,
      ssrModuleRunner: !process.env['NO_MODULE_RUNNER'],
    },
  },
  plugins: [
    {
      name: 'ssr-middleware',
      configureServer(server) {
        return () => {
          server.middlewares.use(async (req, res, next) => {
            try {
              const mod = await (server.environments.ssr as any).import(
                'src/entry-server.tsx',
              )
              await mod.default(req, res)
            } catch (e) {
              next(e)
            }
          })
        }
      },
    },
    {
      name: 'test',
      resolveId: {
        handler(source, importer, _options) {
          if (source === 'virtual:test') {
            debug('[resolveId]', [this.environment?.name, source, importer])
            return `\0virtual:test`
          }
        },
      },
      load: {
        handler(id, _options) {
          if (id === '\0virtual:test') {
            debug('[load]', this.environment?.name)
            return `export default "test:virtual:ok"`
          }
        },
      },
    },
  ],
})
