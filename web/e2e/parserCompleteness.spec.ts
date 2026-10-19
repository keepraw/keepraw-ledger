import { expect, test } from '@playwright/test'
import { SYNTHETIC_CCB_HTML } from '../tests/fixtures/ccbEml'

test('preserves all 17 bank rows, foreign currencies and evidence after reload and reimport', async ({ page }) => {
  await page.goto('/#/settings')
  await page.getByTestId('demo-toggle').uncheck()
  await page.goto('/#/import')
  const rows = ['audit before', 'The End Store', 'audit after'].map(description =>
    `<tr><td>2026-08-10</td><td>2026-08-10</td><td>5678</td><td>消费 ${description}</td><td>USD</td><td>10.00</td><td>USD</td><td>10.00</td></tr>`).join('')
  const html = SYNTHETIC_CCB_HTML.replace('<tr><td>*** 结束 The End ***</td></tr>', rows + '<tr><td>*** 结束 The End ***</td></tr>')
  const file = { name: 'synthetic-complete.html', mimeType: 'text/html', buffer: Buffer.from(html) }
  await page.getByTestId('file-input').setInputFiles(file)
  await expect(page.getByTestId('import-row').first()).toContainText('解析到 17 笔')
  await expect(page.getByTestId('import-row').first()).toContainText('其他币种交易已保留、未核对')
  await page.goto('/#/transactions')
  await expect(page.locator('tbody tr')).toHaveCount(17)
  await page.reload()
  await expect(page.locator('tbody tr')).toHaveCount(17)
  await page.goto('/#/import')
  await page.getByTestId('file-input').setInputFiles(file)
  await expect(page.getByTestId('import-row').first()).toContainText('内容完全相同')
  const result = await page.evaluate(async () => {
    const url = '/src/db/db.ts', { db } = await import(url)
    const rows = await db.transactions.toArray()
    return { count: rows.length, usd: rows.filter((row: { settlementCurrency: string }) => row.settlementCurrency === 'USD').length,
      evidence: await db.attachments.count() }
  })
  expect(result).toEqual({ count: 17, usd: 3, evidence: 1 })
})

test('a malformed bank candidate fails visibly while preserving original-file evidence', async ({ page }) => {
  await page.goto('/#/settings')
  await page.getByTestId('demo-toggle').uncheck()
  await page.goto('/#/import')
  const html = SYNTHETIC_CCB_HTML.replace('<td>2026-07-20</td>', '<td>unreadable</td>')
  await page.getByTestId('file-input').setInputFiles({ name: 'synthetic-invalid-row.html', mimeType: 'text/html', buffer: Buffer.from(html) })
  await expect(page.getByTestId('import-row').first()).toContainText('交易行结构或交易日期无效')
  const result = await page.evaluate(async () => {
    const url = '/src/db/db.ts', { db } = await import(url)
    return { count: await db.transactions.count(), statements: await db.statements.count(), evidence: await db.attachments.count() }
  })
  expect(result).toEqual({ count: 0, statements: 0, evidence: 1 })
})
