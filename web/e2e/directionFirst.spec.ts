import { expect, test } from '@playwright/test'
import { ingestSynthetic } from '../tests/fixtures/identity'
import { BANK_SIGN_CONFLICTS, bocAmountColumns } from '../tests/fixtures/directionConflicts'
import { encodeBocPdf } from '../tests/fixtures/bocCurrencyPdf'
import { readFile } from 'node:fs/promises'

test('Chromium v5 repair rolls back on abort, preserves identity and notes, and reopens idempotently', async ({ page }) => {
  await page.goto('/')
  const result = ingestSynthetic(['合成未知借记', '境外交易返现', '财付通信用卡还款 财付通支付科技有限公司', '方向冲突', '已确认', '已排除'])
  const rows = result.transactions.map((row, index) => ({ ...row,
    direction: index === 0 ? 'debit' : 'credit',
    transactionAmountMinor: index === 0 || index >= 3 ? 12880 : -12880,
    settlementAmountMinor: index === 0 ? 12880 : -12880,
    flags: index === 2 ? ['transaction_type_unclear', 'suspected_duplicate'] : ['transaction_type_unclear'],
    reviewStatus: index === 4 ? 'confirmed' : index === 5 ? 'rejected' : index === 3 ? 'ok' : 'pending',
  }))
  const observed = await page.evaluate(async rows => {
    const url = '/src/db/db.ts', { BillDatabase } = await import(url)
    const Dexie = Object.getPrototypeOf(BillDatabase), name = 'synthetic-direction-v5'
    const old = new Dexie(name)
    old.version(5).stores({ statements: 'id', transactions: 'id, statementId', imports: 'id', settings: 'key', reviewNotes: 'transactionId', attachments: 'fileHash' })
    await old.table('transactions').bulkAdd(rows)
    const note = { transactionId: rows[0]!.id, note: '合成原样备注\n第二行', updatedAt: '2024-01-01T00:00:00Z' }
    await old.table('reviewNotes').put(note); old.close()
    const failing = new BillDatabase(name)
    failing.version(7).stores({}).upgrade(() => { throw new Error('synthetic abort after v6') })
    let aborted = false
    try { await failing.open() } catch { aborted = true } finally { failing.close() }
    const rollback = new Dexie(name); await rollback.open()
    const rolledBack = await rollback.table('transactions').toArray(), version = rollback.verno; rollback.close()
    const upgraded = new BillDatabase(name); await upgraded.open()
    const repaired = await upgraded.transactions.toArray(), retainedNote = await upgraded.reviewNotes.get(note.transactionId)
    upgraded.close(); await upgraded.open()
    const reopened = await upgraded.transactions.toArray(); await upgraded.delete()
    return { aborted, rolledBack, version, repaired, reopened, retainedNote, note }
  }, rows)
  const sort = <T extends { id: string }>(values: T[]) => [...values].sort((a, b) => a.id.localeCompare(b.id))
  expect(observed.aborted).toBe(true)
  expect(observed.version).toBe(5)
  expect(observed.rolledBack).toEqual(sort(rows))
  const repaired = rows.map((row, index) => ({ ...row, flags: index === 2 ? ['suspected_duplicate'] : index >= 3 ? ['amount_direction_unclear'] : [],
    reviewStatus: index < 2 ? 'ok' : index === 3 ? 'pending' : row.reviewStatus }))
  expect(observed.repaired).toEqual(sort(repaired))
  expect(observed.reopened).toEqual(sort(repaired))
  expect(observed.retainedNote).toEqual(observed.note)
})

const conflictUploads = [
  ...BANK_SIGN_CONFLICTS.filter(entry => ['ccb-eight-original-minus', 'citic-original-minus', 'bocom-debit-original-minus'].includes(entry.id))
    .map(entry => ({ ...entry, name: 'synthetic-conflict.html', mimeType: 'text/html', bytes: new TextEncoder().encode(entry.html) })),
  { id: 'boc-both-negative', bank: 'boc', name: 'synthetic-conflict.pdf', mimeType: 'application/pdf',
    bytes: encodeBocPdf(bocAmountColumns('-152.00', '-12.34')), description: '示例超市-东门店',
    direction: 'debit', transactionAmountMinor: -15200, settlementAmountMinor: -15200, count: 7 },
  { id: 'boc-both-positive', bank: 'boc', name: 'synthetic-conflict.pdf', mimeType: 'application/pdf',
    bytes: encodeBocPdf(bocAmountColumns('152.00', '12.34')), description: '示例超市-东门店',
    direction: 'debit', transactionAmountMinor: 15200, settlementAmountMinor: 15200, count: 7 },
]
for (const entry of conflictUploads) {
  test(`${entry.id}: upload saves conflicts and normal rows, then native XLSX preserves evidence and identity`, async ({ page, browser }) => {
    await page.goto('/#/settings')
    await page.getByTestId('demo-toggle').uncheck()
    await page.goto('/#/import')
    await page.getByTestId('file-input').setInputFiles({ name: entry.name, mimeType: entry.mimeType, buffer: Buffer.from(entry.bytes) })
    await expect(page.getByTestId('import-row').first()).toContainText(`解析到 ${entry.count} 笔`)
    await expect(page.getByTestId('import-row').first()).toContainText('已进入待复核')
    const rows = await page.evaluate(async () => {
      const url = '/src/db/db.ts', { db } = await import(url)
      return db.transactions.toArray()
    })
    expect(rows).toHaveLength(entry.count)
    expect(rows.find((row: { rawDescription: string }) => row.rawDescription === entry.description)).toMatchObject({
      direction: entry.direction, transactionAmountMinor: entry.transactionAmountMinor,
      settlementAmountMinor: entry.settlementAmountMinor, reviewStatus: 'pending', flags: expect.arrayContaining(['amount_direction_unclear']) })
    await page.goto('/#/transactions')
    await expect(page.locator('tbody tr')).toHaveCount(entry.count)
    await page.reload()
    await expect(page.locator('tbody tr')).toHaveCount(entry.count)
    await page.goto('/#/review')
    await page.getByRole('button', { name: /交易复核/ }).click()
    await expect(page.getByTestId('review-table')).toContainText('借贷方向不确定')
    await page.goto('/#/transactions')
    const downloadEvent = page.waitForEvent('download')
    await page.getByTestId('export-xlsx').click()
    const download = await downloadEvent
    const bytes = await readFile((await download.path())!)
    const context = await browser.newContext()
    try {
      const restored = await context.newPage()
      await restored.goto('/#/settings')
      await restored.getByTestId('demo-toggle').uncheck()
      await restored.goto('/#/import')
      await restored.getByTestId('legacy-file-input').setInputFiles({ name: 'synthetic-recovery.xlsx',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: bytes })
      await expect(restored.getByTestId('legacy-preview-summary')).toContainText(`可导入 ${entry.count} 笔`)
      await restored.getByTestId('legacy-confirm').click()
      await expect(restored.getByTestId('legacy-preview')).toHaveCount(0)
      const recovered = await restored.evaluate(async () => {
        const url = '/src/db/db.ts', { db } = await import(url)
        return db.transactions.toArray()
      })
      expect(recovered).toHaveLength(entry.count)
      const original = rows.find((row: { rawDescription: string }) => row.rawDescription === entry.description)
      expect(recovered.find((row: { id: string }) => row.id === original.id)).toMatchObject({
        id: original.id, fingerprint: original.fingerprint, occurrence: original.occurrence, direction: original.direction,
        transactionAmountMinor: original.transactionAmountMinor, settlementAmountMinor: original.settlementAmountMinor,
        rawText: original.rawText, reviewStatus: 'pending', flags: ['amount_direction_unclear'] })
      await restored.goto('/#/review')
      await restored.getByRole('button', { name: /交易复核/ }).click()
      await expect(restored.getByTestId('review-table')).toContainText('借贷方向不确定')
    } finally { await context.close() }
  })
}

test('direction filters and Dashboard use debit/credit after restoring old type-only review', async ({ page }) => {
  await page.goto('/#/settings')
  await page.getByTestId('demo-toggle').uncheck()
  const result = ingestSynthetic(['合成借记', '境外交易返现'])
  const statement = { ...result.statement!, status: 'imported' }
  const transactions = result.transactions.map((row, index) => ({ ...row, direction: index ? 'credit' : 'debit',
    transactionAmountMinor: index ? -2880 : 12880, settlementAmountMinor: index ? -2880 : 12880,
    flags: ['transaction_type_unclear'], reviewStatus: 'pending', category: '未分类' }))
  const payload = { format: 'credit-bill-manager-backup', version: 2, exportedAt: '2024-01-01T00:00:00Z',
    statements: [statement], transactions, imports: [result.record], reviewNotes: [], settings: null }
  await page.evaluate(async payload => {
    const url = '/src/db/repository.ts', { importBackup } = await import(url)
    await importBackup(payload)
  }, payload)
  await page.goto('/#/dashboard'); await page.reload()
  await expect(page.locator('.stat').filter({ hasText: '借记总额' }).first()).toContainText('¥128.80')
  await expect(page.locator('.stat').filter({ hasText: '贷记总额' }).first()).toContainText('¥28.80')
  await expect(page.locator('.stat').filter({ hasText: '账单入账净额' })).toContainText('¥100.00')
  await expect(page.getByTestId('type-summary-warning')).toHaveCount(0)
  await page.goto('/#/transactions')
  await page.getByRole('combobox', { name: '借贷方向筛选' }).selectOption('credit')
  await expect(page.locator('tbody tr')).toHaveCount(1)
  await expect(page.locator('tbody tr')).toContainText('境外交易返现')
  await expect(page.locator('tbody tr')).toContainText('贷记')
  await expect(page.locator('tbody tr')).toContainText('正常')
  await page.getByRole('combobox', { name: '借贷方向筛选' }).selectOption('debit')
  await expect(page.locator('tbody tr')).toHaveCount(1)
  await expect(page.locator('tbody tr')).toContainText('合成借记')
})
