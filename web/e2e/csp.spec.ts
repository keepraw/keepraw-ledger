import { readFile } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'
import JSZip from 'jszip'
import { SYNTHETIC_CCB_HTML } from '../tests/fixtures/ccbEml'
import { bocCurrencyLayout, encodeBocPdf } from '../tests/fixtures/bocCurrencyPdf'
import { historyRow, workbookBytes } from '../tests/fixtures/legacyWorkbook'
import type { BackupPayloadV2 } from '../src/db/repository'
import { LEGACY_UNIFIED_COLUMNS } from '../src/importers/legacyPythonExportV1'

declare global {
  interface Window {
    cspViolations: { directive: string; blocked: string }[]
    cspProbeRan?: boolean
    cspEvalBlocked?: boolean
  }
}

function observePolicy(page: Page, failures: string[]) {
  page.on('console', message => {
    if (/content security policy/i.test(message.text())) failures.push(message.text())
  })
  page.on('pageerror', error => failures.push(error.message))
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.cspViolations = []
    document.addEventListener('securitypolicyviolation', event => {
      window.cspViolations.push({ directive: event.effectiveDirective, blocked: event.blockedURI })
    })
  })
})

test('production document blocks unnecessary execution, connections and resource sources', async ({ page }) => {
  const externalRequests: string[] = []
  // Harmless synthetic responses: no request needs to leave the test process.
  await page.route('https://csp-probe.invalid/**', route => {
    externalRequests.push(route.request().url())
    return route.fulfill({ contentType: 'text/javascript', body: 'window.cspProbeRan = true' })
  })
  await page.route('**/__csp-eval-probe.js', route => route.fulfill({
    contentType: 'text/javascript',
    // A real same-origin script must attempt eval. DevTools page.evaluate itself
    // bypasses CSP's eval restriction and cannot prove browser enforcement.
    body: 'try { (0,eval)("window.cspProbeRan = true") } catch { window.cspEvalBlocked = true }',
  }))
  const response = await page.goto('/#/dashboard')
  const html = await response!.text()
  const policyPosition = html.indexOf('http-equiv="Content-Security-Policy"')
  await expect(page.locator('h1')).toBeVisible()
  const result = await page.evaluate(async () => {
    const inline = document.createElement('script')
    inline.textContent = 'window.cspProbeRan = true'
    document.head.append(inline)
    const loadScript = (src: string) => new Promise<boolean>(resolve => {
      const script = document.createElement('script')
      script.src = src
      script.onload = () => resolve(false)
      script.onerror = () => resolve(true)
      document.head.append(script)
    })
    await loadScript('/__csp-eval-probe.js')
    const evalBlocked = window.cspEvalBlocked === true
    const blob = URL.createObjectURL(new Blob(['window.cspProbeRan = true'], { type: 'text/javascript' }))
    const scripts = await Promise.all([
      loadScript('https://csp-probe.invalid/script.js'),
      loadScript(blob),
      loadScript('data:text/javascript,window.cspProbeRan=true'),
    ])
    URL.revokeObjectURL(blob)
    const connectBlocked = await fetch('https://csp-probe.invalid/connect').then(() => false, () => true)
    const workerBlob = URL.createObjectURL(new Blob(['postMessage("unexpected")'], { type: 'text/javascript' }))
    const workerBlocked = await new Promise<boolean>(resolve => {
      try {
        const worker = new Worker(workerBlob)
        worker.onmessage = () => { worker.terminate(); resolve(false) }
        worker.onerror = event => { event.preventDefault(); worker.terminate(); resolve(true) }
      } catch { resolve(true) }
    })
    URL.revokeObjectURL(workerBlob)
    const style = document.createElement('style')
    style.textContent = 'html { --csp-probe: unexpected; }'
    document.head.append(style)
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = 'https://csp-probe.invalid/style.css'
    document.head.append(link)
    const image = new Image()
    image.src = 'https://csp-probe.invalid/image.png'
    document.body.append(image)
    const object = document.createElement('object')
    object.data = 'https://csp-probe.invalid/object'
    document.body.append(object)
    const base = document.createElement('base')
    base.href = 'https://csp-probe.invalid/'
    document.head.append(base)
    return { ran: window.cspProbeRan === true, evalBlocked, scripts, connectBlocked, workerBlocked,
      baseUnchanged: document.baseURI === location.href,
      styleBlocked: getComputedStyle(document.documentElement).getPropertyValue('--csp-probe') === '' }
  })
  expect(result).toEqual({ ran: false, evalBlocked: true, scripts: [true, true, true],
    connectBlocked: true, workerBlocked: true, baseUnchanged: true, styleBlocked: true })
  expect(policyPosition).toBeGreaterThan(0)
  expect(policyPosition).toBeLessThan(html.indexOf('<script'))
  expect(policyPosition).toBeLessThan(html.indexOf('<link'))
  await expect.poll(() => page.evaluate(() => [...new Set(window.cspViolations.map(v => v.directive))])).toEqual(
    expect.arrayContaining(['script-src-elem', 'script-src', 'connect-src', 'worker-src', 'style-src-elem', 'img-src', 'object-src', 'base-uri']),
  )
  expect(externalRequests).toEqual([])
})

test('production startup, styles, themes, local PDF Worker and HTML/EML/XLSX imports remain functional', async ({ page }) => {
  const errors: string[] = []
  observePolicy(page, errors)
  await page.goto('/#/settings')
  await page.getByTestId('demo-toggle').uncheck()
  await page.getByTestId('theme-dark').click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  const dark = await page.locator('body').evaluate(el => getComputedStyle(el).backgroundColor)
  await page.getByTestId('theme-light').click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  expect(await page.locator('body').evaluate(el => getComputedStyle(el).backgroundColor)).not.toBe(dark)
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  // An empty ledger starts in demo mode on a new document by design.
  await page.getByTestId('demo-toggle').uncheck()
  await page.goto('/#/import')
  const workerPromise = page.waitForEvent('worker')
  const bytes = encodeBocPdf(bocCurrencyLayout(['CNY']))
  await page.getByTestId('file-input').setInputFiles({ name: 'synthetic-csp.pdf', mimeType: 'application/pdf', buffer: Buffer.from(bytes) })
  const worker = await workerPromise
  expect(new URL(worker.url()).origin).toBe(new URL(page.url()).origin)
  expect(new URL(worker.url()).pathname).toMatch(/^\/assets\/pdf\.worker\.min-.*\.mjs$/)
  await expect(page.getByTestId('import-row').first()).toContainText('解析到 7 笔')
  await expect(page.getByTestId('import-row').first()).toContainText('账单对账通过')
  await page.getByTestId('file-input').setInputFiles({ name: 'synthetic-csp.html', mimeType: 'text/html', buffer: Buffer.from(SYNTHETIC_CCB_HTML) })
  await expect(page.getByTestId('import-row').first()).toContainText('解析成功')
  const eml = `From: synthetic@example.invalid\r\nSubject: synthetic statement\r\nMIME-Version: 1.0\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n${SYNTHETIC_CCB_HTML}`
  await page.getByTestId('file-input').setInputFiles({ name: 'synthetic-csp.eml', mimeType: 'message/rfc822', buffer: Buffer.from(eml) })
  await expect(page.getByTestId('import-row').first()).toContainText(/解析成功|重复/)
  await page.getByTestId('legacy-file-input').setInputFiles({ name: 'synthetic-csp.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: Buffer.from(workbookBytes('标准字段', LEGACY_UNIFIED_COLUMNS, [historyRow({ description: '消费 CSP 合成商户' })])) })
  await expect(page.getByTestId('legacy-preview-summary')).toContainText('可导入 1 笔')
  await page.getByTestId('legacy-confirm').click()
  await expect(page.getByTestId('legacy-preview')).toHaveCount(0)
  await page.goto('/#/transactions')
  await expect(page.locator('tbody tr')).toHaveCount(22)
  await page.reload()
  await expect(page.locator('tbody tr')).toHaveCount(22)
  for (const id of ['export-csv', 'export-xlsx']) {
    const download = page.waitForEvent('download')
    await page.getByTestId(id).click()
    expect((await readFile((await (await download).path())!)).length).toBeGreaterThan(0)
  }
  expect(errors).toEqual([])
  expect(await page.evaluate(() => window.cspViolations)).toEqual([])
  expect(errors).toEqual([])
})

test('production JSON/ZIP downloads and fresh-context restores preserve rows, notes and original bytes', async ({ page, browser }) => {
  const errors: string[] = []
  observePolicy(page, errors)
  await page.goto('/#/settings')
  await page.getByTestId('demo-toggle').uncheck()
  await page.goto('/#/import')
  await page.getByTestId('file-input').setInputFiles({ name: 'synthetic-csp.html', mimeType: 'text/html', buffer: Buffer.from(SYNTHETIC_CCB_HTML) })
  await expect(page.getByTestId('import-row').first()).toContainText('解析成功')
  await page.goto('/#/review')
  await page.getByRole('button', { name: '交易复核' }).click()
  // Edit through the actual UI; no dev source imports in these production tests.
  const note = page.getByPlaceholder('例如：与银行 App 对账一致，确认为退款')
  await note.fill('synthetic CSP preserved note')
  await page.getByRole('button', { name: '保存备注' }).click()
  await expect(page.getByText('synthetic CSP preserved note', { exact: true })).toBeVisible()
  await page.goto('/#/settings')
  const backups: { name: string; bytes: Buffer; json: BackupPayloadV2 }[] = []
  for (const id of ['backup', 'backup-full']) {
    const event = page.waitForEvent('download')
    await page.getByTestId(id).click()
    const download = await event
    const bytes = await readFile((await download.path())!)
    let json
    if (id === 'backup-full') {
      const zip = await JSZip.loadAsync(bytes)
      const original = Object.values(zip.files).find(file => !file.dir && file.name.startsWith('original-files/'))!
      expect(await original.async('string')).toBe(SYNTHETIC_CCB_HTML)
      const database = Object.values(zip.files).find(file => file.name.endsWith('.json') && file.name !== 'manifest.json')!
      json = JSON.parse(await database.async('string'))
    } else json = JSON.parse(bytes.toString('utf8'))
    expect(json.transactions).toHaveLength(14)
    expect(json.reviewNotes).toEqual(expect.arrayContaining([expect.objectContaining({ note: 'synthetic CSP preserved note' })]))
    backups.push({ name: download.suggestedFilename(), bytes, json })
  }
  for (const backup of backups) {
    const context = await browser.newContext()
    try {
      const restored = await context.newPage()
      observePolicy(restored, errors)
      await restored.goto('/#/settings')
      await restored.getByTestId('demo-toggle').uncheck()
      await restored.setInputFiles('input[type="file"][accept*=".json"]', { name: backup.name, mimeType: backup.name.endsWith('.zip') ? 'application/zip' : 'application/json', buffer: backup.bytes })
      await expect(restored.getByText(/已恢复 14 笔交易/)).toBeVisible()
      const event = restored.waitForEvent('download')
      await restored.getByTestId('backup').click()
      const actual = JSON.parse(await readFile((await (await event).path())!, 'utf8'))
      for (const key of ['transactions', 'statements', 'imports', 'reviewNotes'] as const) expect(actual[key]).toEqual(backup.json[key])
      if (backup.name.endsWith('.zip')) {
        const event = restored.waitForEvent('download')
        await restored.getByRole('button', { name: '下载原始文件' }).click()
        expect(await readFile((await (await event).path())!, 'utf8')).toBe(SYNTHETIC_CCB_HTML)
      }
    } finally { await context.close() }
  }
  expect(await page.evaluate(() => window.cspViolations)).toEqual([])
  expect(errors).toEqual([])
})
