import { defineConfig } from '@playwright/test'
import base from './playwright.config'

const PORT = Number(process.env.CSP_E2E_PORT ?? 5200)

export default defineConfig({
  ...base,
  testMatch: 'csp.spec.ts',
  testIgnore: [],
  use: { ...base.use, baseURL: `http://127.0.0.1:${PORT}` },
  webServer: {
    command: `npm run build && npm run preview -- --port ${PORT} --strictPort --host 127.0.0.1`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
})
