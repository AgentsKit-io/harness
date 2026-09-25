import { fileURLToPath, URL } from 'node:url'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

// Output lands at <repo root>/dist/app — `src/ui/api/server.ts` resolves its default `appDir` as `./app` next
// to the compiled server module (`dist/*.js`), so this path and that one must agree.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  build: { outDir: fileURLToPath(new URL('../../../dist/app', import.meta.url)), emptyOutDir: true },
  server: { port: 5173, strictPort: true },
})
