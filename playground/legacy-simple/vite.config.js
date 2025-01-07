// import fs from 'node:fs'
// import path from 'node:path'
import assert from 'assert'
import legacy from '@vitejs/plugin-legacy'
import { defineConfig } from 'vite'

export default defineConfig({
  // base: './',
  plugins: [
    legacy({
      targets: 'IE 11',
      // modernPolyfills: true,
    }),
    {
      name: 'legacy-html',
      apply: 'build',
      enforce: 'post',
      generateBundle(_options, bundle) {
        const chunk = bundle['index.html']
        assert(chunk.type === 'asset')
        const source = chunk.source
        assert(typeof source === 'string')
        chunk.source = source
          .replace(/<script type="module".*?<\/script>/g, '')
          .replace(/<link rel="modulepreload".*?>/, '')
          .replace(/<script nomodule/g, '<script')
      },
    },
  ],

  build: {
    minify: false,
    assetsInlineLimit: 0,
    // manifest: true,
    // sourcemap: true,
  },

  // // for tests, remove `<script type="module">` tags and remove `nomodule`
  // // attrs so that we run the legacy bundle instead.
  // __test__() {
  //   const indexPath = path.resolve(__dirname, './dist/index.html')
  //   let index = fs.readFileSync(indexPath, 'utf-8')
  //   index = index
  //     .replace(/<script type="module".*?<\/script>/g, '')
  //     .replace(/<script nomodule/g, '<script')
  //   fs.writeFileSync(indexPath, index)
  // },
})
