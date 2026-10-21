import { readFile } from 'node:fs/promises'
import * as XLSX from 'xlsx'
import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import { TRANSACTION_TYPE_LABELS, type Transaction } from '../src/core/types'
import { buildDuplicateReviewDetails } from '../src/core/migrationAudit'
import { validateBackup } from '../src/backup/validation'
import type { Snapshot } from '../src/db/repository'
import { MIGRATION_FORMATS, migrationFixture } from '../tests/fixtures/historicalMigration'

async function localAssetsOnly(context: BrowserContext, origin: string, unexpected: string[]) {
  await context.route('**/*', (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const staticPath = url.pathname === '/' || ['/src/', '/node_modules/', '/@'].some((prefix) => url.pathname.startsWith(prefix))
    const asset = staticPath && !['fetch', 'xhr'].includes(request.resourceType()) && !/\.(?:py|sqlite3?|db)$/i.test(url.pathname)
    if (url.origin === origin && request.method() === 'GET' && asset) return route.continue()
    unexpected.push(`${request.method()} ${url.pathname}`)
    return route.abort()
  })
  await context.routeWebSocket('**/*', (socket) => {
    if (new URL(socket.url()).host === new URL(origin).host) socket.connectToServer()
    else { unexpected.push('external websocket'); socket.close() }
  })
}

async function snapshot(page: Page): Promise<Snapshot> {
  return page.evaluate(async () => {
    const url = '/src/db/repository.ts'
    const { readSnapshot } = await import(url)
    return readSnapshot()
  })
}

function duplicateRelationships(transactions: Transaction[]) {
  return buildDuplicateReviewDetails(transactions, transactions.filter((row) => row.flags.includes('suspected_duplicate')))
}

for (const format of MIGRATION_FORMATS) {
  test(`${format.sheet}: six banks migrate, archive and recover in a fresh browser without Python or SQLite`, async ({ page, browser }, testInfo) => {
    const origin = new URL(String(testInfo.project.use.baseURL)).origin
    const unexpected: string[] = []
    await localAssetsOnly(page.context(), origin, unexpected)
    await page.goto('/#/settings')
    await page.getByTestId('demo-toggle').uncheck()
    expect((await snapshot(page)).transactions).toEqual([])
    const { buffer, expected } = migrationFixture(format)
    const upload = { name: 'synthetic-history.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from(buffer) }
    await page.goto('/#/import')
    await page.getByTestId('legacy-file-input').setInputFiles(upload)
    await expect(page.getByTestId('legacy-preview-summary')).toContainText(/共 72 行数据，可导入 72 笔，\s*异常 0 行/)
    await page.getByTestId('legacy-confirm').click()
    await expect(page.getByTestId('legacy-preview')).toHaveCount(0)
    const initial = await snapshot(page)
    expect(initial.transactions).toHaveLength(72)
    expect(initial.statements).toHaveLength(6)
    const bySource = [...initial.transactions].sort((a, b) => a.sourceRow - b.sourceRow)
    for (const [index, row] of expected.entries()) {
      expect(bySource[index]).toMatchObject({ bank: row.bank, cardLast4: row.cardLast4, description: row.description,
        transactionDate: row.transactionDate, postingDate: row.postingDate, type: row.type, direction: row.direction,
        transactionCurrency: row.transactionCurrency, transactionAmountMinor: row.transactionAmountMinor,
        settlementCurrency: row.settlementCurrency, settlementAmountMinor: row.settlementAmountMinor })
    }
    expect(new Set(initial.transactions.map((row) => row.id)).size).toBe(72)
    const relationships = duplicateRelationships(initial.transactions)
    expect(relationships.size).toBeGreaterThanOrEqual(6)
    expect([...relationships.values()].every((row) => row.candidateCount > 0)).toBe(true)

    // The archive can be read using an ordinary XLSX library outside the app.
    await page.goto('/#/transactions')
    const archiveDownload = page.waitForEvent('download')
    await page.getByTestId('export-xlsx').click()
    const archive = await archiveDownload
    const workbook = XLSX.read(await readFile((await archive.path())!), { type: 'buffer' })
    const archiveRows = XLSX.utils.sheet_to_json<Record<string, string>>(workbook.Sheets['交易明细']!, { raw: true })
    expect(archiveRows).toHaveLength(72)
    expect(archiveRows.every(row => !Object.hasOwn(row, '商户'))).toBe(true)
    const archiveById = new Map(archiveRows.map((row) => [row['交易标识'], row]))
    expect(archiveById.size).toBe(72)
    for (const row of bySource) {
      const reference = expected[row.sourceRow - 2]!
      // The fixture's purchase action is display noise; its stored source remains exact.
      const displayed = reference.type === 'purchase' ? reference.description.replace(/^消费 /, '') : reference.description
      expect(archiveById.get(row.id)).toMatchObject({ 银行: reference.bankName, 卡尾号: row.cardLast4,
        交易日: row.transactionDate, 入账日: row.postingDate, 交易描述: displayed, 原始描述: reference.description,
        交易币种: row.transactionCurrency, 交易金额: String(reference.transactionAmount),
        入账币种: row.settlementCurrency, 入账金额: String(reference.settlementAmount),
        交易类型: TRANSACTION_TYPE_LABELS[reference.type], 借贷方向: reference.direction === 'debit' ? '借' : '贷',
        交易标识: row.id, 业务指纹: row.fingerprint, 重复序号: String(row.occurrence) })
    }

    // Include actual duplicate-file references and retain distinct repeated purchases.
    await page.goto('/#/import')
    await page.getByTestId('legacy-file-input').setInputFiles(upload)
    await expect(page.getByText('该文件此前已导入，确认后不会产生重复交易。')).toBeVisible()
    await page.getByTestId('legacy-confirm').click()
    await expect(page.getByTestId('legacy-preview')).toHaveCount(0)
    const before = await snapshot(page)
    expect(before.transactions).toEqual(initial.transactions)
    expect(before.imports.some((row) => row.duplicateOf !== null)).toBe(true)
    await page.goto('/#/settings')
    const backupDownload = page.waitForEvent('download')
    await page.getByTestId('backup').click()
    const backupFile = await backupDownload
    expect(backupFile.suggestedFilename()).toMatch(/^credit-card-data-\d{4}-\d{2}-\d{2}\.json$/)
    const backupPath = (await backupFile.path())!
    const backup: unknown = JSON.parse(await readFile(backupPath, 'utf8'))
    expect(validateBackup(backup)).toBe(true)

    // A separate browser profile has no ledger, SQLite, cached import, or original XLSX.
    const fresh = await browser.newContext({ baseURL: origin, locale: 'zh-CN', serviceWorkers: 'block' })
    try {
      await localAssetsOnly(fresh, origin, unexpected)
      const restoredPage = await fresh.newPage()
      await restoredPage.goto('/#/settings')
      expect((await snapshot(restoredPage)).transactions).toEqual([])
      await restoredPage.locator('input[type="file"][accept*=".json"]').setInputFiles(backupPath)
      // V2 restores report the recovered review-note count; match the stable
      // financial prefix rather than the full message string.
      await expect(restoredPage.getByText(/已恢复 72 笔交易、6 份账单/)).toBeVisible()
      await restoredPage.reload()
      const restored = await snapshot(restoredPage)
      expect(restored.transactions).toEqual(before.transactions)
      expect(restored.imports).toEqual(before.imports)
      expect(restored.statements).toHaveLength(6)
      expect(restored.statements.every((row) => row.transactionCount === 12)).toBe(true)
      expect(duplicateRelationships(restored.transactions)).toEqual(relationships)
      // Repeated restore and later import preserve all IDs and occurrences.
      await restoredPage.locator('input[type="file"][accept*=".json"]').setInputFiles(backupPath)
      // V2 restores report the recovered review-note count; match the stable
      // financial prefix rather than the full message string.
      await expect(restoredPage.getByText(/已恢复 72 笔交易、6 份账单/)).toBeVisible()
      await restoredPage.goto('/#/import')
      await restoredPage.getByTestId('legacy-file-input').setInputFiles(upload)
      await expect(restoredPage.getByText('该文件此前已导入，确认后不会产生重复交易。')).toBeVisible()
      await restoredPage.getByTestId('legacy-confirm').click()
      await expect(restoredPage.getByTestId('legacy-preview')).toHaveCount(0)
      expect((await snapshot(restoredPage)).transactions).toEqual(before.transactions)
    } finally { await fresh.close() }
    expect(unexpected).toEqual([])
  })
}
