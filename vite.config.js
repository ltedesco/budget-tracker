import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// A GitHub Pages project site is served from /<repo>/, not /. The Pages
// workflow passes that prefix in as BASE_PATH; local dev serves from root.
export default defineConfig({
  base: process.env.BASE_PATH || '/',
  plugins: [react()],
  server: { port: 5173 },
})
