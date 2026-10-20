import { expect, test } from '@playwright/test'
import { bocCurrencyLayout, encodeBocPdf } from '../tests/fixtures/bocCurrencyPdf'

for (const currencies of [['USD'], ['HKD'], ['USD', 'CNY', 'HKD'], ['HKD', 'USD', 'CNY']]) {
  test(`AUD-012: real PDF extraction, persistence and display for ${currencies.join('/')}`, async ({ page }) => {
    await page.goto('/#/settings')
    await page.getByTestId('demo-toggle').uncheck()
    await page.goto('/#/import')
    const hasCny = currencies.includes('CNY')
    const bytes = encodeBocPdf(bocCurrencyLayout(currencies, { foreignDetails: true }))
    await page.getByTestId('file-input').setInputFiles({ name: 'synthetic-boc-currency.pdf', mimeType: 'application/pdf', buffer: Buffer.from(bytes) })
    await expect(page.getByTestId('import-row').first()).toContainText('解析到 14 笔')
    await expect(page.getByTestId('import-row').first()).toContainText(hasCny ? '账单对账通过' : '账单缺少必要汇总信息')
    const stored = await page.evaluate(async () => {
      const url = '/src/db/db.ts', { db } = await import(url)
      const statement = (await db.statements.toArray())[0]
      const transactions = await db.transactions.toArray()
      return { status: statement.reconciliation.status, current: statement.summary.currentBalanceMinor,
        currencies: statement.summary.components.map((item: { currency: string }) => item.currency),
        usd: transactions.filter((row: { settlementCurrency: string }) => row.settlementCurrency === 'USD').length,
        cny: transactions.filter((row: { settlementCurrency: string }) => row.settlementCurrency === 'CNY').length,
        evidence: await db.attachments.count() }
    })
    expect(stored).toMatchObject({ status: hasCny ? 'passed' : 'insufficient', current: hasCny ? 60000 : null, usd: 7, cny: 7, evidence: 1 })
    expect(new Set(stored.currencies)).toEqual(new Set(currencies))
    await page.goto('/#/transactions')
    await expect(page.locator('tbody tr')).toHaveCount(14)
    await expect(page.locator('tbody')).toContainText('USD')
    await expect(page.locator('tbody')).toContainText('CNY')
    await page.reload()
    await expect(page.locator('tbody tr')).toHaveCount(14)
    if (!hasCny) {
      await page.goto('/#/review')
      await expect(page.getByText(/无法完成对账/).first()).toBeVisible()
    }
  })
}
