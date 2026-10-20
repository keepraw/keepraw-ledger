import { build } from 'vite'
import { chromium } from '@playwright/test'
import JSZip from 'jszip'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, writeFile, readFile, stat, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import { SEED, makeRows, makeWorkbook } from '../storage-benchmark/fixture.mjs'

const directory = path.dirname(fileURLToPath(import.meta.url)), ownWeb = path.resolve(directory, '../..')
const web = path.resolve(process.env.LEDGER_WEB_ROOT ?? ownWeb), repo = path.resolve(ownWeb, '..')
const mode = process.env.LEDGER_MODE ?? 'backup'
if (['read', 'read-native'].includes(mode) && (!process.env.LEDGER_PROFILE_ROOT || !process.env.LEDGER_ORIGIN_PORT)) throw new Error('Read mode requires generated synthetic profile root and original origin port')
if (['read', 'read-native'].includes(mode) && (!process.env.LEDGER_PROFILE_ROOT || !process.env.LEDGER_ORIGIN_PORT)) throw new Error('Read mode requires generated synthetic profile root and original origin port')
const sizes = (process.env.LEDGER_SIZES ?? (mode === 'backup' ? '18000,36000,100000' : '18000,100000')).split(',').map(Number)
const output = process.env.LEDGER_OUTPUT ?? path.join(repo, `docs/benchmarks/large-ledger-${mode}.json`)
const scratchRoot = process.env.LEDGER_TEMP_DIR ?? path.join(os.tmpdir(), 'keepraw-ledger-benchmark')
await mkdir(scratchRoot, { recursive: true })
const temporary = await mkdtemp(path.join(scratchRoot, 'large-ledger-')), buildDirectory = path.join(web, 'scripts/large-ledger')
await mkdir(buildDirectory, { recursive: true })
const generated = path.join(buildDirectory, '.generated.html'), generatedProbe = path.join(buildDirectory, '.generated-probe.tsx')
const dist = path.join(temporary, 'dist'), assets = new Map(), contexts = new Set()
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const log = value => process.stdout.write(`${new Date().toISOString()} ${value}\n`)
const result = { metadata: { date: new Date().toISOString(), mode, seed: SEED, source: web,
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: web, encoding: 'utf8' }).trim(),
  reusedProfileRoot: process.env.LEDGER_PROFILE_ROOT ?? null, node: process.version, cpu: os.cpus()[0].model, cpus: os.cpus().length, memoryBytes: os.totalmem(), os: { platform: os.platform(), release: os.release(), arch: os.arch() },
  sampleCounts: { imports: 3, operations: 5, edits: 5, ui: 5, startup: 3, actualBackup: 3 }, temporary }, cases: [] }
result.metadata.sourceFiles = {}
for (const name of ['app/AppStore.tsx', 'db/db.ts', 'db/repository.ts', 'backup/json.ts', 'backup/archive.ts', 'backup/zipSafety.ts', 'ui/pages/TransactionsPage.tsx', 'core/analytics.ts']) {
  const file = path.join(web, 'src', name)
  if (await stat(file).catch(() => null)) result.metadata.sourceFiles[name] = hash(await readFile(file))
}
const save = async () => { await mkdir(path.dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(result, null, 2) + '\n') }
const call = (page, method, ...args) => page.evaluate(async ({ method, args }) => window.benchmark[method](...args), { method, args })
let server, origin
async function launch(name, databaseOnly = false) {
  const profile = path.join(process.env.LEDGER_PROFILE_ROOT ?? temporary, name)
  const context = await chromium.launchPersistentContext(profile, { executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium',
    headless: true, locale: 'zh-CN', timezoneId: 'UTC', acceptDownloads: true,
    viewport: { width: 1440, height: 1000 }, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  result.metadata.browser ??= context.browser().version()
  contexts.add(context); context.on('close', () => contexts.delete(context))
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort())
  const page = context.pages()[0]; page.setDefaultTimeout(180000)
  const memory = { peakChromiumRssBytes: 0, peakNodeRssBytes: 0, peakSamples: [] }
  if (mode === 'backup') {
    const session = await context.browser().newBrowserCDPSession()
    let closed = false; context.on('close', () => { closed = true })
    void (async () => {
      while (!closed) {
        try {
          const { processInfo } = await session.send('SystemInfo.getProcessInfo')
          const pids = processInfo.map(info => info.id).filter(id => Number.isInteger(id) && id > 0)
          const text = execFileSync('ps', ['-o', 'rss=', '-p', pids.join(',')], { encoding: 'utf8' })
          const rss = text.trim().split(/\s+/).reduce((sum, value) => sum + Number(value) * 1024, 0)
          if (rss > memory.peakChromiumRssBytes) { memory.peakChromiumRssBytes = rss; memory.peakSamples.push({ at: new Date().toISOString(), bytes: rss }) }
          memory.peakNodeRssBytes = Math.max(memory.peakNodeRssBytes, process.memoryUsage().rss)
        } catch { if (closed) break }
        await new Promise(resolve => setTimeout(resolve, 250))
      }
    })()
  }
  page.on('pageerror', error => log(`PAGE ERROR: ${error.message}`))
  if (['read', 'read-native'].includes(mode)) {
    const cdp = await context.newCDPSession(page)
    await cdp.send('Network.enable')
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true })
  }
  await page.goto(`${origin}/scripts/large-ledger/.generated.html${databaseOnly ? '?database=1' : ['read', 'read-native'].includes(mode) ? `?read=${encodeURIComponent(result.metadata.date)}` : ''}#/transactions`)
  await page.waitForFunction(() => window.benchmark?.ready())
  if (!databaseOnly) await call(page, 'disableDemo')
  return { context, page, profile, memory }
}
async function verified(page, name, extras, format = 'database', existing = false, override = null) {
  const counts = await call(page, 'verify', name, extras, format, existing, override)
  for (const [key, value] of Object.entries(counts)) assert.equal(value, 0, key)
  return counts
}
async function exported(page, kind, name) {
  const download = page.waitForEvent('download', { timeout: 180000 })
  const ms = await call(page, 'exportFile', kind)
  const item = await download, bytes = await readFile(await item.path())
  assets.set(name, bytes)
  return { bytes: bytes.length, ms, sha256: hash(bytes) }
}
async function allRows(page, table) {
  // The probe pages at 2000 rows; 100k ledgers with distributed notes exceed
  // one page, so collect every page for exact comparison.
  const out = []
  let after = null
  for (;;) {
    const batch = await call(page, 'rows', table, after)
    if (!batch.length) break
    out.push(...batch)
    if (batch.length < 2000) break
    after = batch[batch.length - 1].__key
  }
  return out
}
async function backupCase(count) {
  log(`BACKUP ${count}`)
  const workbookName = `python-${count}.xlsx`, fixture = makeWorkbook(makeRows(count)); assets.set(workbookName, fixture)
  const source = await launch(`source-${count}`), entry = { count, import: await call(source.page, 'normalImport', workbookName), checks: [], restore: [], memoryProfiles: [] }
  const first = (await call(source.page, 'rows', 'transactions', null))[0]
  await call(source.page, 'edit', first.id, '旅行', 'confirmed'); await call(source.page, 'note', first.id); await call(source.page, 'seedNotes', 20); await call(source.page, 'originals', workbookName)
  const extras = { notes: await allRows(source.page, 'reviewNotes'), attachments: await allRows(source.page, 'attachments') }
  assert.equal((await call(source.page, 'counts')).transactions, count)
  entry.json = await exported(source.page, 'json', `${count}.json`); entry.zip = await exported(source.page, 'zip', `${count}.zip`)
  log(`EXPORT ${count}: JSON=${entry.json.bytes} ZIP=${entry.zip.bytes}`)
  await call(source.page, 'edit', first.id, '医疗健康', 'rejected')
  const override = { id: first.id, category: '医疗健康', reviewStatus: 'rejected' }
  for (const name of [`${count}.json`, `${count}.zip`]) {
    const restored = await call(source.page, 'restoreFile', name); assert.equal(restored.ok, true, restored.message)
    entry.restore.push({ context: 'existing-edits-notes-originals', name, ...restored })
    entry.checks.push({ context: 'existing', ...await verified(source.page, `${count}.json`, extras, 'database', true, override) })
  }
  const empty = await call(source.page, 'clear')
  for (const table of ['transactions', 'statements', 'imports', 'reviewNotes', 'attachments']) assert.equal(empty[table], 0)
  const cleared = await call(source.page, 'restoreFile', `${count}.json`); assert.equal(cleared.ok, true, cleared.message)
  entry.restore.push({ context: 'export-clear-restore', kind: 'json', ...cleared })
  entry.checks.push({ context: 'clear-json', ...await verified(source.page, `${count}.json`, extras, 'json') })
  await source.context.close(); entry.memoryProfiles.push({ label: 'source', ...source.memory })
  for (const kind of ['json', 'zip']) {
    for (let profileRepeat = 0; profileRepeat < Number(process.env.LEDGER_FRESH_PROFILES ?? 1); profileRepeat++) {
    const target = await launch(`fresh-${kind}-${count}-${profileRepeat}`)
    if (kind === 'zip' && count === 100000 && profileRepeat === 0) {
      const failed = await call(target.page, 'attachmentFailure', `${count}.zip`); assert.equal(failed.ok, false)
      const state = await call(target.page, 'counts')
      for (const table of ['transactions', 'statements', 'imports', 'attachments', 'reviewNotes']) assert.equal(state[table], 0, 'late error must roll back')
      entry.lateRollback = { failed, counts: state }; log('100k native late-attachment rollback passed')
    }
    for (let repeat = 0; repeat < 3; repeat++) {
      const restored = await call(target.page, 'restoreFile', `${count}.${kind}`); assert.equal(restored.ok, true, restored.message)
      entry.restore.push({ context: 'fresh-profile', kind, profileRepeat, repeat, ...restored })
      entry.checks.push({ context: `fresh-${kind}-${profileRepeat}-${repeat}`, ...await verified(target.page, `${count}.json`, extras, kind) })
      log(`RESTORE ${count} ${kind} profile ${profileRepeat} repeat ${repeat}: ${restored.ms.toFixed(1)}ms`)
    }
    // Nonempty destination: conflicting note content must reject without partial changes.
    if (kind === 'json' && profileRepeat === 0) {
      const conflictId = first.id
      await call(target.page, 'customNote', conflictId, 'local conflicting note — must survive')
      const conflicted = await call(target.page, 'restoreFile', `${count}.${kind}`); assert.equal(conflicted.ok, false)
      entry.restore.push({ context: 'nonempty-note-conflict', kind, ...conflicted })
      const afterState = await call(target.page, 'counts')
      assert.equal(afterState.transactions, count)
      const preserved = await allRows(target.page, 'reviewNotes')
      assert.ok(preserved.some(row => row.transactionId === conflictId && row.note === 'local conflicting note — must survive'))
      log(`CONFLICT ${count} ${kind}: rejection preserved nonempty destination`)
    }
    await target.context.close(); entry.memoryProfiles.push({ label: `fresh-${kind}-${profileRepeat}`, ...target.memory })
    }
  }
  const legacyPayload = JSON.parse(assets.get(`${count}.json`).toString('utf8'))
  legacyPayload.format = 'credit-bill-manager-backup'; legacyPayload.settings = { demoMode: false, theme: 'dark' }
  legacyPayload.version = 1; delete legacyPayload.reviewNotes
  const legacyText = JSON.stringify(legacyPayload, null, 2); assets.set(`${count}-legacy.json`, Buffer.from(legacyText))
  const currentZip = await JSZip.loadAsync(assets.get(`${count}.zip`)), legacyZip = new JSZip()
  for (const [name, file] of Object.entries(currentZip.files)) if (!file.dir) legacyZip.file(name, name === 'database.json' ? legacyText : await file.async('uint8array'))
  assets.set(`${count}-legacy.zip`, await legacyZip.generateAsync({ type: 'nodebuffer', compression: 'STORE' }))
  for (const kind of ['json', 'zip']) {
    const target = await launch(`legacy-${kind}-${count}`)
    const restored = await call(target.page, 'restoreFile', `${count}-legacy.${kind}`); assert.equal(restored.ok, true, restored.message)
    entry.restore.push({ context: 'legacy-v1', kind, bytes: assets.get(`${count}-legacy.${kind}`).length, ...restored })
    entry.checks.push({ context: `legacy-${kind}`, ...await verified(target.page, `${count}.json`, extras, `legacy-${kind}`) })
    await target.context.close(); entry.memoryProfiles.push({ label: `legacy-${kind}`, ...target.memory })
  }
  entry.contract = { version: 2, notesExported: true, existingNotesPreserved: true, freshZipAttachmentTimestampReconstructed: true, orphanPolicy: 'preserve-all-notes-including-orphans' }
  result.cases.push(entry); await save(); log(`PASS BACKUP ${count}`)
  for (const key of [...assets.keys()]) if (key.startsWith(String(count)) || key === workbookName) assets.delete(key)
}
async function indexedFiles(profile) {
  const files = []
  const visit = async directory => {
    for (const name of await (await import('node:fs/promises')).readdir(directory).catch(() => [])) {
      const file = path.join(directory, name), value = await stat(file)
      if (value.isDirectory()) await visit(file)
      else files.push({ path: path.relative(profile, file), bytes: value.size, allocatedBytes: value.blocks * 512 })
    }
  }
  await visit(path.join(profile, 'Default/IndexedDB'))
  return { fileBytes: files.reduce((sum, file) => sum + file.bytes, 0), allocatedBytes: files.reduce((sum, file) => sum + file.allocatedBytes, 0), files }
}
async function migrationCase(count, control = false) {
  log(`MIGRATION ${count}`)
  const workbookName = `python-${count}.xlsx`, jsonName = `${count}-migration.json`
  assets.set(workbookName, makeWorkbook(makeRows(count)))
  const source = await launch(`migration-source-${count}`)
  const imported = await call(source.page, 'normalImport', workbookName)
  const first = (await call(source.page, 'rows', 'transactions', null))[0]
  await call(source.page, 'edit', first.id, '旅行', 'confirmed'); await call(source.page, 'note', first.id); await call(source.page, 'originals', workbookName)
  await exported(source.page, 'json', jsonName)
  const extras = { notes: await call(source.page, 'rows', 'reviewNotes', null), attachments: await call(source.page, 'rows', 'attachments', null) }
  await source.context.close()
  const entry = { count, imported, versions: [] }
  for (const version of (control ? [2, 3] : [1, 2, 3])) {
    const repeats = version === 1 ? 1 : 3
    for (let repeat = 0; repeat < repeats; repeat++) {
      const target = await launch(`migration-${count}-v${version}-${repeat}`, true)
      const expectedExtras = version === 1 ? { notes: extras.notes, attachments: [] } : extras
      const seeded = await call(target.page, 'seedVersion', version, jsonName, workbookName, extras)
      const checks = [await verified(target.page, jsonName, expectedExtras, 'migration', true)]
      const beforeSamples = await call(target.page, 'databaseSamples', 3), beforeDisk = await indexedFiles(target.profile)
      if (control) {
        await target.context.close()
        const closedDisk = await indexedFiles(target.profile)
        const reopened = await launch(`migration-${count}-v${version}-${repeat}`, true)
        const schema = await call(reopened.page, 'openHistorical')
        assert.equal(schema.version, version * 10)
        const stableUsage = await call(reopened.page, 'usage')
        checks.push(await verified(reopened.page, jsonName, expectedExtras, 'migration', true))
        await reopened.context.close()
        const stableDisk = await indexedFiles(target.profile)
        let firstReadyAfterUpgradeMs
        if (version === 2) {
          const boot = await launch(`migration-${count}-v${version}-${repeat}`, true)
          const appPage = await boot.context.newPage()
          await appPage.addInitScript(count => { const observer = new MutationObserver(() => {
            if (document.querySelector('.page-head p')?.textContent.startsWith(`共 ${count} 笔`)) { window.firstReady = performance.now(); observer.disconnect() }
          }); observer.observe(document, { childList: true, subtree: true, characterData: true }) }, count)
          await appPage.goto(origin + '/#/transactions'); await appPage.waitForFunction(() => window.firstReady !== undefined, undefined, { timeout: 180000 })
          firstReadyAfterUpgradeMs = await appPage.evaluate(() => window.firstReady)
          await call(boot.page, 'openHistorical')
          checks.push(await verified(boot.page, jsonName, expectedExtras, 'migration', true))
          await boot.context.close()
        }
        entry.versions.push({ version, repeat, seeded, beforeSamples, beforeDisk, closedDisk, stableUsage,
          stableDisk, firstReadyAfterUpgradeMs, checks })
        result.cases = result.cases.filter(item => item.count !== count).concat(entry); await save()
        log(`PASS INDEX CONTROL ${count} v${version} #${repeat}`)
        continue
      }
      let aborted
      if (version === 2 && repeat === 0) {
        aborted = await call(target.page, 'upgradeVersion', true)
        assert.equal(aborted.schema.version, 20)
        assert.equal(aborted.schema.indexes.reduce((sum, table) => sum + table.indexes.length, 0), 21)
        checks.push(await verified(target.page, jsonName, expectedExtras, 'migration', true))
      }
      const upgraded = await call(target.page, 'upgradeVersion', false)
      assert.equal(upgraded.schema.version, 30)
      assert.equal(upgraded.schema.indexes.reduce((sum, table) => sum + table.indexes.length, 0), 1)
      checks.push(await verified(target.page, jsonName, expectedExtras, 'migration', true))
      const afterSamples = await call(target.page, 'databaseSamples', 3), reopens = []
      for (let i = 0; i < 3; i++) reopens.push(await call(target.page, 'databaseReopen'))
      checks.push(await verified(target.page, jsonName, expectedExtras, 'migration', true))
      await target.context.close()
      entry.versions.push({ version, repeat, seeded, beforeSamples, beforeDisk, aborted, upgraded, afterSamples, reopens,
        afterDisk: await indexedFiles(target.profile), checks })
      result.cases = result.cases.filter(item => item.count !== count).concat(entry); await save()
      log(`PASS MIGRATION ${count} v${version} #${repeat}`)
    }
  }
  assets.delete(workbookName); assets.delete(jsonName)
}
async function uiSamples(page) {
  const samples = []
  const measure = async (kind, action) => {
    const pending = page.evaluate(kind => new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('UI event timeout')), 20000)
      document.addEventListener(kind, () => { clearTimeout(timeout); const start = performance.now(); requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - start))) }, { capture: true, once: true })
    }), kind)
    await action(); return pending
  }
  for (let i = 0; i < 5; i++) {
    const searchMs = await measure('input', () => page.getByTestId('transaction-search').fill('咖啡')); await page.getByTestId('transaction-search').fill('')
    const dateSortMs = await measure('click', () => page.locator('th.sortable').filter({ hasText: '交易日' }).click())
    const descriptionSortMs = await measure('click', () => page.locator('th.sortable').filter({ hasText: '交易描述' }).click())
    samples.push({ searchMs, dateSortMs, descriptionSortMs })
  }
  return samples
}
async function performanceCase(count) {
  // Respect the production 25 MiB/file limit without reducing ledger size.
  const rows = makeRows(count), fixtures = []
  for (let offset = 0; offset < count; offset += 50000) {
    const name = `python-${count}-${offset}.xlsx`, bytes = makeWorkbook(rows.slice(offset, offset + 50000))
    assert.ok(bytes.length <= 25 * 1024 * 1024, 'synthetic workbook exceeds production file budget')
    assets.set(name, bytes); fixtures.push({ name, rows: Math.min(50000, count - offset), bytes: bytes.length })
  }
  const entry = { count, fixtures, imports: [], samples: [], startup: [], edits: [], ui: [] }
  for (let repeat = 0; repeat < 3; repeat++) {
    log(`PERFORMANCE ${count} ${repeat}`); const target = await launch(`performance-${count}-${repeat}`)
    const parts = []
    for (const fixture of fixtures) {
      const imported = await call(target.page, 'normalImport', fixture.name)
      assert.equal(imported.valid, fixture.rows)
      parts.push(imported)
    }
    assert.equal((await call(target.page, 'counts')).transactions, count)
    entry.imports.push({ parts, previewMs: parts.reduce((sum, part) => sum + part.previewMs, 0),
      confirmMs: parts.reduce((sum, part) => sum + part.confirmMs, 0), totalMs: parts.reduce((sum, part) => sum + part.totalMs, 0) })
    entry.usage ??= await call(target.page, 'usage')
    if (repeat === 0) {
      entry.samples = await call(target.page, 'performanceSamples', 5); entry.edits = await call(target.page, 'editSamples', 5); entry.ui = await uiSamples(target.page)
      entry.actualBackup = []; for (let i = 0; i < 3; i++) entry.actualBackup.push(await exported(target.page, 'json', `${count}-performance.json`))
      for (let i = 0; i < 3; i++) {
        const page = await target.context.newPage()
        await page.addInitScript(count => { const observer = new MutationObserver(() => {
          if (document.querySelector('.page-head p')?.textContent.startsWith(`共 ${count} 笔`)) { window.firstReady = performance.now(); observer.disconnect() }
        }); observer.observe(document, { childList: true, subtree: true, characterData: true }) }, count)
        await page.goto(origin + '/#/transactions'); await page.waitForFunction(() => window.firstReady !== undefined, undefined, { timeout: 180000 })
        entry.startup.push(await page.evaluate(() => window.firstReady)); await page.close()
      }
    }
    await target.context.close()
  }
  result.cases.push(entry); await save()
  for (const fixture of fixtures) assets.delete(fixture.name)
}
try {
  await writeFile(generatedProbe, await readFile(path.join(directory, 'browser.tsx'), 'utf8'))
  await writeFile(generated, '<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><div id="root"></div><script type="module" src="./.generated-probe.tsx"></script></html>')
  await build({ root: web, configFile: path.join(web, 'vite.config.ts'), logLevel: 'warn', build: { outDir: dist, emptyOutDir: true,
    rollupOptions: { input: { app: path.join(web, 'index.html'), benchmark: generated } } } })
  server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname)
      if (pathname.startsWith('/__fixture/')) { const bytes = assets.get(pathname.slice('/__fixture/'.length)); if (!bytes) throw new Error('missing synthetic asset'); response.end(bytes); return }
      const target = path.resolve(dist, `.${pathname === '/' ? '/index.html' : pathname}`)
      if (!target.startsWith(dist + path.sep)) throw new Error('invalid path')
      response.setHeader('Content-Type', target.endsWith('.html') ? 'text/html' : target.endsWith('.js') ? 'text/javascript' : target.endsWith('.css') ? 'text/css' : 'application/octet-stream')
      response.end(await readFile(target))
    } catch { response.statusCode = 404; response.end('Not found') }
  })
  await new Promise(resolve => server.listen(Number(process.env.LEDGER_ORIGIN_PORT ?? 0), '127.0.0.1', resolve)); origin = `http://127.0.0.1:${server.address().port}`; result.metadata.origin = origin
  for (const count of sizes) {
    if (mode === 'backup') await backupCase(count)
    else if (mode === 'performance') await performanceCase(count)
    else if (mode === 'migration') await migrationCase(count)
    else if (mode === 'index') await migrationCase(count, true)
    else if (['read', 'read-native'].includes(mode)) {
      const entry = { count, profiles: [] }
      for (let repeat = 0; repeat < 3; repeat++) {
        const target = await launch(`performance-${count}-${repeat}`)
        const experiment = mode === 'read-native' ? await call(target.page, 'nativeReadExperiment', 7) : { samples: await call(target.page, 'isolatedReads', 7), equal: true }
        for (const sample of experiment.samples) assert.equal(sample.records, count)
        assert.equal(experiment.equal, true)
        entry.profiles.push({ profile: target.profile, repeat, ...experiment })
        await target.context.close(); log(`PASS ISOLATED READ ${count} #${repeat}`)
      }
      result.cases.push(entry); await save()
    }
    else throw new Error(`Unknown mode: ${mode}`)
  }
  result.metadata.completedAt = new Date().toISOString(); await save(); log(`RESULT ${output}`)
} finally {
  for (const context of contexts) await context.close().catch(() => {})
  if (server) await new Promise(resolve => server.close(resolve))
  await rm(generated, { force: true }); await rm(generatedProbe, { force: true })
}
