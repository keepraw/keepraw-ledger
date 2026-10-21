import { expect, test, type Page } from '@playwright/test'
import { syntheticStatement } from '../tests/fixtures/identity'
import { historyRow, workbookBytes } from '../tests/fixtures/legacyWorkbook'
import { LEGACY_UNIFIED_COLUMNS } from '../src/importers/legacyPythonExportV1'

async function seed(page: Page, count: number) {
  await page.goto('/#/settings')
  await page.getByTestId('demo-toggle').uncheck()
  const parsed = syntheticStatement(Array.from({ length: count }, (_, i) => `消费 合成商户${i}`))
  parsed.summary = { ...parsed.summary, previousBalanceMinor: 0, currentBalanceMinor: 12880, newDebitMinor: 12880, newCreditMinor: 0 }
  await page.evaluate(async (parsed) => {
    const repositoryUrl = '/src/db/repository.ts', ingestUrl = '/src/core/ingest.ts'
    const repository = await import(repositoryUrl)
    const { ingestParsedStatement } = await import(ingestUrl)
    await repository.persistImportResults([ingestParsedStatement(parsed,
      { fileName: 'synthetic.txt', fileHash: 'synthetic-bank', fileSize: 1, sourceType: 'text' }, await repository.readSnapshot())])
  }, parsed)
  await page.reload()
}

test('excluding one 128.80 row publishes a reconciled statement immediately and after reload', async ({ page }) => {
  await seed(page, 2)
  await page.goto('/#/review')
  await page.getByRole('button', { name: /交易复核/ }).click()
  const target = page.getByTestId('review-table').locator('tbody tr').filter({ has: page.locator('td[title="消费 合成商户1"]') })
  await expect(target).toContainText('合成商户1')
  await expect(target).not.toContainText('消费 合成商户1')
  await target.getByRole('button', { name: '排除' }).click()
  // Same mounted Provider: verifies the committed statement reaches React too.
  await page.getByRole('button', { name: /账单对账/ }).click()
  await expect(page.getByText('所有账单都已通过对账')).toBeVisible()
  await page.goto('/#/dashboard')
  await expect(page.locator('.stat-value').first()).toHaveText('¥128.80')
  await page.reload()
  await expect(page.locator('.stat-value').first()).toHaveText('¥128.80')
  const state = await page.evaluate(async () => {
    const url = '/src/db/repository.ts'
    return (await import(url)).readSnapshot()
  })
  expect(state.statements[0]).toMatchObject({ status: 'reconciled', transactionCount: 2, reconciliation: { status: 'passed' } })
  expect(state.transactions).toHaveLength(2)
  expect(state.transactions.filter((row: { reviewStatus: string }) => row.reviewStatus === 'rejected')).toHaveLength(1)
})

test('XLSX append removes 257.60 from trusted spending and persists the mismatch', async ({ page }) => {
  await seed(page, 1)
  await page.goto('/#/dashboard')
  await expect(page.locator('.stat-value').first()).toHaveText('¥128.80')
  await page.goto('/#/import')
  await page.getByTestId('legacy-file-input').setInputFiles({ name: 'synthetic-append.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: Buffer.from(workbookBytes('标准字段', LEGACY_UNIFIED_COLUMNS, [historyRow({ description: '消费 追加商户' })])) })
  await expect(page.getByTestId('legacy-preview')).toBeVisible()
  await page.getByTestId('legacy-confirm').click()
  await expect(page.getByTestId('legacy-preview')).toHaveCount(0)
  await page.goto('/#/dashboard')
  await expect(page.locator('.stat-value').first()).toHaveText('¥0.00')
  await page.reload()
  await expect(page.locator('.stat-value').first()).toHaveText('¥0.00')
  await page.goto('/#/review')
  await expect(page.getByRole('button', { name: '重新核对并保存' })).toBeVisible()
  const state = await page.evaluate(async () => {
    const url = '/src/db/repository.ts'
    return (await import(url)).readSnapshot()
  })
  expect(state.statements[0]).toMatchObject({ status: 'needs_review', transactionCount: 2, reconciliation: { status: 'mismatch' } })
  expect(state.transactions).toHaveLength(2)
})

test('explicit recalculation repairs a selected old status and persists it across reload', async ({ page }) => {
  await seed(page, 1)
  await page.evaluate(async () => {
    const url = '/src/db/db.ts'
    const { db } = await import(url)
    const statement = (await db.statements.toArray())[0]
    // Reproduce a pre-fix database: correct transactions, stale statement state.
    await db.statements.update(statement.id, { status: 'needs_review', reconciliation: { ...statement.reconciliation, status: 'mismatch' } })
  })
  await page.reload()
  await page.goto('/#/review')
  await page.getByRole('button', { name: '重新核对并保存' }).click()
  await expect(page.getByText('所有账单都已通过对账')).toBeVisible()
  await page.reload()
  await expect(page.getByText('所有账单都已通过对账')).toBeVisible()
  await page.goto('/#/dashboard')
  await expect(page.locator('.stat-value').first()).toHaveText('¥128.80')
})

test('an old falsely reconciled statement can be selected for explicit repair without rewriting other history', async ({ page }) => {
  await seed(page, 2)
  await page.evaluate(async () => {
    const url = '/src/db/db.ts'
    const { db } = await import(url)
    const statement = (await db.statements.toArray())[0]
    await db.statements.update(statement.id, { status: 'reconciled', reconciliation: { ...statement.reconciliation, status: 'passed' } })
  })
  await page.reload()
  await page.goto('/#/review')
  await page.getByRole('checkbox', { name: '显示全部账单（可重新核对历史状态）' }).check()
  await page.getByRole('button', { name: '重新核对并保存' }).click()
  await expect(page.getByRole('button', { name: '账单对账 1' })).toBeVisible()
  await page.goto('/#/dashboard')
  await expect(page.locator('.stat-value').first()).toHaveText('¥0.00')
  await page.reload()
  await expect(page.locator('.stat-value').first()).toHaveText('¥0.00')
})
