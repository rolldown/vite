import { join } from 'node:path'
import { debuglog } from 'node:util'
import { defineConfig } from 'vite'

const debug = debuglog('dev')

export default defineConfig({
  clearScreen: false,
  experimental: {
    rolldownDev: {
      hmr: true,
      reactRefresh: true,
    },
  },
  resolve: {
    alias: {
      'test-alias': join(import.meta.dirname, './src/test-alias-dest.tsx'),
    },
  },
  plugins: [
    {
      name: 'test',
      options() {
        debug('[options]', this.environment?.name)
      },
      buildStart() {
        debug('[buildStart]', this.environment?.name)
      },
      buildEnd() {
        debug('[buildEnd]', this.environment?.name)
      },
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
            return `export default "test:virtual:ok, environment.name: ${this.environment.name}"`
          }
        },
      },
      renderChunk() {
        debug('[renderChunk]', this.environment?.name)
      },
      generateBundle() {
        debug('[generateBundle]', this.environment?.name)
      },
    },
  ],
})
