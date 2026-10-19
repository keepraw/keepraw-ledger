import { expect, test } from '@playwright/test'
import { MIGRATION_FORMATS } from '../tests/fixtures/historicalMigration'
import { historyRow, workbookBytes } from '../tests/fixtures/legacyWorkbook'

for (const format of MIGRATION_FORMATS) {
  test(`${format.sheet}: merchant promotion stays purchase and untyped credits stay visible for review`, async ({ page }) => {
    await page.goto('/#/settings')
    await page.getByTestId('demo-toggle').uncheck()
    await page.goto('/#/import')
    const rows = [['示例优惠超市', 100], ['合成未知贷记商户', -20]].map(([description, amount]) => historyRow({
      description, 说明: description, 交易详情: description, transaction_amount: amount, settlement_amount: amount,
      交易金额: amount, 结算金额: amount, 入账金额: amount,
    }, format.format))
    await page.getByTestId('legacy-file-input').setInputFiles({ name: 'synthetic-type.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer: Buffer.from(workbookBytes(format.sheet, format.columns, rows)) })
    await expect(page.getByTestId('legacy-preview')).toBeVisible()
    await page.getByTestId('legacy-confirm').click()
    await expect(page.getByTestId('legacy-preview')).toHaveCount(0)
    await page.goto('/#/dashboard')
    await expect(page.locator('.stat-value').first()).toHaveText('¥100.00')
    await expect(page.getByTestId('type-summary-warning')).toContainText('1 笔交易类型待确认')
    await page.reload()
    await expect(page.locator('.stat-value').first()).toHaveText('¥100.00')
    await page.goto('/#/transactions')
    await expect(page.locator('tbody tr')).toHaveCount(2)
    await page.goto('/#/review')
    await page.getByRole('button', { name: /交易复核/ }).click()
    await expect(page.getByTestId('review-table')).toContainText('交易类型待确认')
    const rowsInDb = await page.evaluate(async () => {
      const url = '/src/db/db.ts', { db } = await import(url)
      return db.transactions.toArray()
    })
    expect(rowsInDb.find((row: { description: string }) => row.description === '示例优惠超市')).toMatchObject({ type: 'purchase', direction: 'debit', settlementAmountMinor: 10000 })
    expect(rowsInDb.find((row: { description: string }) => row.description === '合成未知贷记商户')).toMatchObject({ reviewStatus: 'pending', flags: ['transaction_type_unclear'] })
  })
}
