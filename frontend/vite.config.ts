import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// base: '/' 保证 dist/index.html 可被静态服务器（甚至 file://）直接打开
export default defineConfig({
  base: '/',
  server: { host: '127.0.0.1', proxy: { '/api': 'http://127.0.0.1:8790' } },
  preview: { host: '127.0.0.1', proxy: { '/api': 'http://127.0.0.1:8790' } },
  plugins: [react(), tailwindcss(), {
    name: 'ynote-current-build-assets',
    generateBundle(_options, bundle) {
      this.emitFile({ type: 'asset', fileName: 'build-assets.json', source: JSON.stringify(Object.keys(bundle).filter(name => name.startsWith('assets/'))) })
    },
  }],
})
