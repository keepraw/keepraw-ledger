import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Custom domain deployment: assets are served from the domain root.
// GitHub Pages project paths should be supplied through VITE_BASE_PATH when needed.
const base = process.env.VITE_BASE_PATH ?? '/'

export default defineConfig({
  base,
  plugins: [
    react(),
    {
      name: 'production-csp',
      // HMR injects development scripts/styles. Only shipped HTML gets this policy.
      apply: 'build',
      transformIndexHtml: {
        order: 'post',
        handler: () => [{
          tag: 'meta',
          attrs: {
            'http-equiv': 'Content-Security-Policy',
            content: [
              "default-src 'none'",
              "script-src 'self'",
              "script-src-attr 'none'",
              "connect-src 'self'",
              "worker-src 'self'",
              "style-src 'self'",
              // React uses dynamic style attributes for charts/progress and layout.
              // This permits attributes only; inline <style> and scripts stay blocked.
              "style-src-attr 'unsafe-inline'",
              "img-src 'self'",
              "font-src 'self'",
              "object-src 'none'",
              "base-uri 'none'",
              "form-action 'none'",
            ].join('; '),
          },
          // Must precede Vite's generated scripts, modulepreloads and stylesheets.
          injectTo: 'head-prepend',
        }],
      },
    },
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
  },
  worker: {
    format: 'es',
  },
})