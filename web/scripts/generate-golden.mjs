/** Execute the existing TypeScript generator with Vite, without a second TS runner dependency. */
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const root = fileURLToPath(new URL('../', import.meta.url))
const server = await createServer({
  root, configFile: false, logLevel: 'silent', optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true, watch: null }, appType: 'custom',
})
try {
  const { main } = await server.ssrLoadModule('/scripts/generate-golden.ts')
  process.exitCode = await main()
} catch {
  // Parser errors and filenames can contain identifying source text. Keep
  // command-line failures useful without echoing those strings into CI logs.
  console.error('Golden generation failed; source details are not logged. Run without --no-desensitize and verify input format and input.meta.json SHA-256 locally.')
  process.exitCode = 2
} finally {
  await server.close()
}
