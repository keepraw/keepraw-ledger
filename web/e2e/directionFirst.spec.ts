import { expect, test } from '@playwright/test'
import { ingestSynthetic } from '../tests/fixtures/identity'

test('Chromium v5 repair rolls back on abort, preserves identity and notes, and reopens idempotently', async ({ page }) => {
  await page.goto('/')
  const result = ingestSynthetic(['合成未知借记', '境外交易返现', '财付通信用卡还款 财付通支付科技有限公司', '方向冲突', '已确认', '已排除'])
  const rows = result.transactions.map((row, index) => ({ ...row,
    direction: index === 0 ? 'debit' : 'credit',
    transactionAmountMinor: index === 0 || index === 3 ? 12880 : -12880,
    settlementAmountMinor: index === 0 ? 12880 : -12880,
    flags: index === 2 ? ['transaction_type_unclear', 'suspected_duplicate'] : ['transaction_type_unclear'],
    reviewStatus: index === 4 ? 'confirmed' : index === 5 ? 'rejected' : 'pending',
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
  const repaired = rows.map((row, index) => ({ ...row, flags: index === 2 ? ['suspected_duplicate'] : index === 3 ? ['amount_direction_unclear'] : [],
    reviewStatus: index < 2 ? 'ok' : row.reviewStatus }))
  expect(observed.repaired).toEqual(sort(repaired))
  expect(observed.reopened).toEqual(sort(repaired))
  expect(observed.retainedNote).toEqual(observed.note)
})

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
