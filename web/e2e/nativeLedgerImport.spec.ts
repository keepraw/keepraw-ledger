import { readFile } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'
import type { Snapshot } from '../src/db/repository'
import { nativeCells, nativeTransaction, nativeWorkbook } from '../tests/fixtures/nativeLedger'

async function snapshot(page: Page): Promise<Snapshot> {
  return page.evaluate(async () => {
    const url = '/src/db/repository.ts'
    return (await import(url)).readSnapshot()
  })
}

test('native 20-column preview, UI export, fresh-browser 21-column restoration and conflict protection', async ({ page, browser }, testInfo) => {
  const origin = new URL(String(testInfo.project.use.baseURL)).origin
  await page.goto('/#/settings')
  await page.getByTestId('demo-toggle').uncheck()
  const invalid = nativeCells(5); invalid[6] = 'invalid-money'
  const upload = { name: 'synthetic-native.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: Buffer.from(nativeWorkbook([nativeCells(1), nativeCells(3), invalid])) }
  await page.goto('/#/import')
  await page.getByTestId('legacy-file-input').setInputFiles(upload)
  await expect(page.getByTestId('legacy-preview')).toContainText('legacy-keepraw-ledger-export-v1')
  await expect(page.getByTestId('legacy-preview-summary')).toContainText(/共 3 行数据，可导入 2 笔，\s*异常 1 行/)
  await expect(page.getByTestId('legacy-preview-summary')).toContainText('2024-01-05')
  await expect(page.getByTestId('legacy-preview')).toContainText('0012')
  await expect(page.getByTestId('legacy-preview-anomalies')).toContainText('金额无法解析 1 行')
  await page.getByTestId('legacy-confirm').click()
  await expect(page.getByTestId('legacy-preview')).toHaveCount(0)
  const initial = await snapshot(page)
  expect(initial.transactions.map(tx => tx.id).sort()).toEqual([nativeTransaction().id, nativeTransaction(3).id].sort())
  expect(initial.transactions.every(tx => tx.transactionCurrency === 'USD' && tx.settlementCurrency === 'HKD' &&
    tx.transactionAmountMinor === 1234 && tx.settlementAmountMinor === 9625 && tx.reviewStatus === 'confirmed')).toBe(true)
  await page.getByTestId('legacy-file-input').setInputFiles(upload)
  await expect(page.getByText('该文件此前已导入，确认后不会产生重复交易。')).toBeVisible()
  await page.getByTestId('legacy-confirm').click()
  await expect(page.getByTestId('legacy-preview')).toHaveCount(0)
  expect((await snapshot(page)).transactions).toEqual(initial.transactions)

  await page.goto('/#/transactions')
  const downloaded = page.waitForEvent('download')
  await page.getByTestId('export-xlsx').click()
  const exported = await downloaded
  const buffer = await readFile((await exported.path())!)
  const fresh = await browser.newContext({ baseURL: origin })
  try {
    const restoredPage = await fresh.newPage()
    await restoredPage.goto('/#/settings')
    await restoredPage.getByTestId('demo-toggle').uncheck()
    await restoredPage.goto('/#/import')
    expect((await snapshot(restoredPage)).transactions).toEqual([])
    const roundtrip = { name: 'synthetic-native-roundtrip.xlsx', mimeType: upload.mimeType, buffer }
    await restoredPage.getByTestId('legacy-file-input').setInputFiles(roundtrip)
    await expect(restoredPage.getByTestId('legacy-preview-summary')).toContainText(/共 2 行数据，可导入 2 笔，\s*异常 0 行/)
    await restoredPage.getByTestId('legacy-confirm').click()
    await expect(restoredPage.getByTestId('legacy-preview')).toHaveCount(0)
    await restoredPage.reload()
    expect((await snapshot(restoredPage)).transactions).toEqual(initial.transactions)
    await restoredPage.getByTestId('legacy-file-input').setInputFiles(roundtrip)
    await expect(restoredPage.getByText('该文件此前已导入，确认后不会产生重复交易。')).toBeVisible()
    await restoredPage.getByTestId('legacy-confirm').click()
    await expect(restoredPage.getByTestId('legacy-preview')).toHaveCount(0)
    await restoredPage.evaluate(async (id) => {
      const url = '/src/db/repository.ts'
      await (await import(url)).patchTransaction({ id, transactionAmountMinor: 999 })
    }, nativeTransaction().id)
    const beforeConflict = await snapshot(restoredPage)
    await restoredPage.getByTestId('legacy-file-input').setInputFiles(roundtrip)
    await expect(restoredPage.getByTestId('legacy-identity-warnings')).toContainText('交易标识冲突')
    await expect(restoredPage.getByTestId('legacy-confirm')).toBeDisabled()
    expect((await snapshot(restoredPage)).transactions).toEqual(beforeConflict.transactions)
  } finally { await fresh.close() }
})
