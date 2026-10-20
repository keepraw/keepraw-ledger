import { expect, test } from '@playwright/test'
import { CROSS_YEAR_ABC_HTML } from '../tests/fixtures/abcEml'

test('AUD-009: native import persists cross-year dates and shows the correct Dashboard months', async ({ page }) => {
  await page.goto('/#/settings')
  await page.getByTestId('demo-toggle').uncheck()
  await page.goto('/#/import')
  const file = { name: 'synthetic-abc-cross-year.html', mimeType: 'text/html', buffer: Buffer.from(CROSS_YEAR_ABC_HTML) }
  await page.getByTestId('file-input').setInputFiles(file)
  await expect(page.getByTestId('import-row').first()).toContainText('解析到 2 笔')
  await page.goto('/#/transactions')
  await expect(page.locator('tbody')).toContainText('2025-12-20')
  await expect(page.locator('tbody')).toContainText('2026-01-06')
  await page.reload()
  await expect(page.locator('tbody')).toContainText('2025-12-21')
  await page.goto('/#/dashboard')
  await expect(page.getByRole('group', { name: '2025-12，消费金额 100.00 元，退款金额 0.00 元' })).toBeVisible()
  await expect(page.getByRole('group', { name: '2026-01，消费金额 200.00 元，退款金额 0.00 元' })).toBeVisible()
  await page.goto('/#/import')
  await page.getByTestId('file-input').setInputFiles(file)
  await expect(page.getByTestId('import-row').first()).toContainText('内容完全相同')
})
