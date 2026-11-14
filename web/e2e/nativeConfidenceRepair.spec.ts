import { expect, test, type Page } from '@playwright/test'
import type { Transaction } from '../src/core/types'
import { transactionToRow } from '../src/export/tabular'
import { NATIVE_HEADERS, nativeTransaction, nativeWorkbook } from '../tests/fixtures/nativeLedger'

async function transactions(page: Page): Promise<Transaction[]> {
  return page.evaluate(async () => {
    const url = '/src/db/repository.ts'
    return (await (await import(url)).readSnapshot()).transactions
  })
}

async function expectQueue(page: Page, count: number) {
  await page.goto('/#/review')
  await expect(page.getByRole('button', { name: `交易复核 ${count}`, exact: true })).toBeVisible()
}

test('18,286 native XLSX rows: UI import, historical v4 repair, refresh and application reopen preserve decisions and notes', async ({ page, context }, testInfo) => {
  test.setTimeout(180_000)
  await page.goto('/#/settings')
  await page.getByTestId('demo-toggle').uncheck()
  const rows = Array.from({ length: 18_286 }, (_, i) => transactionToRow(nativeTransaction(i + 1, {
    reviewStatus: i < 18_000 ? 'ok' : i < 18_200 ? 'confirmed' : i < 18_250 ? 'pending' : 'rejected',
  })))
  await page.goto('/#/import')
  await page.getByTestId('legacy-file-input').setInputFiles({ name: 'synthetic-18286.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: Buffer.from(nativeWorkbook(rows, [...NATIVE_HEADERS, '原始描述'])) })
  await expect(page.getByTestId('legacy-preview-summary')).toContainText(/可导入 18286 笔/)
  await expect(page.getByTestId('legacy-preview')).toContainText('不触发逐笔复核')
  await page.getByTestId('legacy-confirm').click()
  await expect(page.getByTestId('legacy-preview')).toHaveCount(0)
  const imported = await transactions(page)
  expect(imported).toHaveLength(18_286)
  expect(imported.every(tx => tx.confidence === 0 && tx.flags.length === 0)).toBe(true)
  await expectQueue(page, 50)
  await page.reload()
  await expectQueue(page, 50)

  // Recreate ONLY this isolated test context's database in the PR #48/v4 shape.
  // Capture actual UI-imported rows and every store before replacing the test DB.
  const before = await page.evaluate(async () => {
    const url = '/src/db/db.ts'
    const { db, BillDatabase } = await import(url)
    const Dexie = Object.getPrototypeOf(BillDatabase)
    const stores: Record<string, unknown[]> = {}
    for (const table of db.tables) stores[table.name] = await table.toArray()
    stores.transactions = (stores.transactions as Transaction[]).map(tx => ({ ...tx,
      flags: tx.occurrence <= 12 ? ['low_confidence', 'suspected_duplicate'] : ['low_confidence'] }))
    stores.reviewNotes = (stores.transactions as Transaction[]).map(tx => ({ transactionId: tx.id,
      note: `Synthetic retained note ${tx.occurrence}`, updatedAt: '2024-01-01T00:00:00Z' }))
    const name = db.name
    db.close(); await Dexie.delete(name)
    const old = new Dexie(name)
    old.version(4).stores({ statements: 'id', transactions: 'id, statementId', imports: 'id', settings: 'key',
      reviewNotes: 'transactionId', attachments: 'fileHash' })
    for (const [name, rows] of Object.entries(stores)) await old.table(name).bulkPut(rows)
    old.close()
    return stores
  })
  expect((before.transactions as Transaction[]).filter(tx => tx.reviewStatus !== 'rejected')).toHaveLength(18_250)
  const expected = { ...before, transactions: (before.transactions as Transaction[]).map(tx => ({ ...tx,
    flags: tx.flags.filter(flag => flag !== 'low_confidence') })) }
  await page.reload()
  await expectQueue(page, 62)
  const readAll = (target: Page) => target.evaluate(async () => {
    const url = '/src/db/db.ts', { db } = await import(url)
    const stores: Record<string, unknown[]> = {}
    for (const table of db.tables) stores[table.name] = await table.toArray()
    return stores
  })
  expect(await readAll(page)).toEqual(expected)
  await page.goto('/#/quality')
  await expect(page.getByTestId('dq-flagged')).toHaveText('12')
  await page.reload()
  await expectQueue(page, 62)
  expect(await readAll(page)).toEqual(expected)
  const origin = new URL(String(testInfo.project.use.baseURL)).origin
  await page.close()
  const reopened = await context.newPage()
  await reopened.goto(`${origin}/#/review`)
  await expectQueue(reopened, 62)
  expect(await readAll(reopened)).toEqual(expected)
  console.info('Chromium native confidence: 18,286 rows; historical queue 18,250 -> 62; new import queue 50; flagged 12; every store preserved after refresh/reopen')
})
