import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import * as XLSX from 'xlsx'
import { MIGRATION_FORMATS } from '../tests/fixtures/historicalMigration'
import { historyRow, workbookBytes } from '../tests/fixtures/legacyWorkbook'

for (const format of MIGRATION_FORMATS) {
  test(`${format.sheet}: normalized UI, raw search, exports and manual edits survive reload`, async ({ page }) => {
    const raw = '网上消费 支付宝，合成 A-B (HK)'
    const normalized = '支付宝-合成 A-B (HK)'
    await page.goto('/#/settings')
    await page.getByTestId('demo-toggle').uncheck()
    await page.goto('/#/import')
    const buffer = workbookBytes(format.sheet, format.columns, [historyRow({ description: raw, 说明: raw, 交易详情: raw }, format.format)])
    await page.getByTestId('legacy-file-input').setInputFiles({ name: 'synthetic-description.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from(buffer) })
    await expect(page.getByTestId('legacy-preview')).toBeVisible()
    await page.getByTestId('legacy-confirm').click()
    await expect(page.getByTestId('legacy-preview')).toHaveCount(0)
    await page.goto('/#/transactions')
    await expect(page.locator('tbody tr')).toContainText(normalized)
    await expect(page.locator('tbody td[title]').first()).toHaveAttribute('title', `${normalized}｜原始：${raw}`)
    for (const query of [normalized, raw]) {
      await page.getByTestId('transaction-search').fill(query)
      await expect(page.locator('tbody tr')).toHaveCount(1)
    }
    const csvEvent = page.waitForEvent('download')
    await page.getByTestId('export-csv').click()
    const csv = await readFile((await (await csvEvent).path())!, 'utf8')
    expect(csv).toContain(normalized)
    expect(csv).toContain(raw)
    const xlsxEvent = page.waitForEvent('download')
    await page.getByTestId('export-xlsx').click()
    const book = XLSX.read(await readFile((await (await xlsxEvent).path())!))
    const rows = XLSX.utils.sheet_to_json<string[]>(book.Sheets['交易明细']!, { header: 1 })
    expect(rows[1]![4]).toBe(normalized)
    expect(rows[1]![rows[0]!.indexOf('原始描述')]).toBe(raw)
    await page.goto('/#/review')
    await page.getByRole('checkbox', { name: '显示全部账单（可重新核对历史状态）' }).check()
    await expect(page.locator('td[title]').filter({ hasText: normalized })).toHaveAttribute('title', raw)
    const before = await page.evaluate(async () => {
      const url = '/src/db/db.ts', { db } = await import(url)
      return (await db.transactions.toArray())[0]
    })
    await page.evaluate(async () => {
      const url = '/src/db/db.ts', { db } = await import(url)
      const repository = '/src/db/repository.ts', { patchTransaction } = await import(repository)
      const row = (await db.transactions.toArray())[0]
      await patchTransaction({ id: row.id, description: '消费 我的描述-A:01', merchant: '我的商户', category: '教育' })
    })
    await page.goto('/#/transactions')
    await page.reload()
    await expect(page.locator('tbody tr')).toContainText('消费 我的描述-A:01')
    await page.getByTestId('transaction-search').fill('我的商户')
    await expect(page.locator('tbody tr')).toHaveCount(1)
    const after = await page.evaluate(async () => {
      const url = '/src/db/db.ts', { db } = await import(url)
      return (await db.transactions.toArray())[0]
    })
    expect(after).toMatchObject({ id: before.id, fingerprint: before.fingerprint, occurrence: before.occurrence, rawDescription: raw, category: '教育' })
  })
}
