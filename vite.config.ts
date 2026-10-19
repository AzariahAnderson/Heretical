import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
        timeout: 120000,
        proxyTimeout: 120000
      }
    }
  },
  optimizeDeps: {
    include: ['react', 'react-dom', 'zustand', 'react-markdown', 'remark-gfm']
  },
  build: { target: 'es2022', sourcemap: false, minify: 'esbuild' }
})