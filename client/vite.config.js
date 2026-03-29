import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { readFileSync } from 'fs'

const superdocPkg = JSON.parse(readFileSync('./node_modules/superdoc/package.json', 'utf-8'))

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue()],
  define: {
    __SUPERDOC_VERSION__: JSON.stringify(superdocPkg.version),
  },
})
