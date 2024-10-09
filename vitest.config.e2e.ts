import { resolve } from 'node:path'
import { defaultExclude, defineConfig } from 'vitest/config'

const isBuild = !!process.env.VITE_TEST_BUILD

const timeout = process.env.PWDEBUG ? Infinity : process.env.CI ? 50000 : 30000

export default defineConfig({
  resolve: {
    alias: {
      '~utils': resolve(__dirname, './playground/test-utils'),
    },
  },
  test: {
    include: ['./playground/**/*.spec.[tj]s'],
    exclude: [
      './playground/legacy/**/*.spec.[tj]s', // system format
      ...(isBuild
        ? [
            './playground/backend-integration/**/*.spec.[tj]s', // https://github.com/rolldown/rolldown/issues/2392
            './playground/dynamic-import/**/*.spec.[tj]s', // https://github.com/rolldown/rolldown/issues/1843
            './playground/external/**/*.spec.[tj]s', // https://github.com/rolldown/rolldown/issues/2041
            './playground/lib/**/*.spec.[tj]s', // umd format
            './playground/object-hooks/**/*.spec.[tj]s', // object hook sequential
            './playground/optimize-deps/**/*.spec.[tj]s', // https://github.com/rolldown/rolldown/issues/2031
            './playground/worker/__tests__/es/*.spec.[tj]s', // https://github.com/rolldown/rolldown/issues/2208
          ]
        : []),
      ...defaultExclude,
    ],
    setupFiles: ['./playground/vitestSetup.ts'],
    globalSetup: ['./playground/vitestGlobalSetup.ts'],
    testTimeout: timeout,
    hookTimeout: timeout,
    reporters: 'dot',
    deps: {
      // Prevent Vitest from running the workspace packages in Vite's SSR runtime
      moduleDirectories: ['node_modules', 'packages'],
    },
    onConsoleLog(log) {
      if (
        log.match(
          /experimental|jit engine|emitted file|tailwind|The CJS build of Vite/i,
        )
      )
        return false
    },
  },
  esbuild: {
    target: 'node18',
  },
  publicDir: false,
})
