import { readFile } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'
import type { Snapshot } from '../src/db/repository'
import type { LegacyPreview } from '../src/importers/types'
import { nativeCells, nativeDisplayCells, nativeTransaction, nativeWorkbook } from '../tests/fixtures/nativeLedger'

async function snapshot(page: Page): Promise<Snapshot> {
  return page.evaluate(async () => {
    const url = '/src/db/repository.ts'
    return (await import(url)).readSnapshot()
  })
}

test('same native file incrementally recovers previously excluded rows and a second repeat inserts zero', async ({ page }) => {
  await page.goto('/#/settings')
  await page.getByTestId('demo-toggle').uncheck()
  const buffer = Buffer.from(nativeWorkbook([nativeCells(1), nativeDisplayCells(), nativeCells(3)]))
  const before = await page.evaluate(async bytes => {
    const importerUrl = '/src/importers/legacyImport.ts'
    const repositoryUrl = '/src/db/repository.ts'
    const descriptionUrl = '/src/core/descriptionNormalizer.ts'
    const { previewLegacyWorkbook, planLegacyImport } = await import(importerUrl)
    const repository = await import(repositoryUrl)
    const { transactionDisplayDescription } = await import(descriptionUrl)
    const workbook = new Uint8Array(bytes).buffer
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', workbook)))
      .map(value => value.toString(16).padStart(2, '0')).join('')
    const existing = await repository.readSnapshot()
    const full = await previewLegacyWorkbook(workbook, { fileName: 'synthetic-recovery.xlsx', fileHash: hash, fileSize: bytes.length }, existing)
    const oldRows = full.rows.filter((row: LegacyPreview['rows'][number]) =>
      transactionDisplayDescription(row) === row.description)
    await repository.persistLegacyImport(planLegacyImport({ ...full, rows: oldRows }, existing))
    const initial = await repository.readSnapshot()
    await repository.patchTransaction({ id: initial.transactions[0].id, category: '其他', reviewStatus: 'rejected', confidence: 1, flags: [] })
    return repository.readSnapshot()
  }, Array.from(buffer))
  expect(before.transactions).toHaveLength(2)
  const upload = { name: 'synthetic-recovery.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer }
  await page.goto('/#/import')
  await page.getByTestId('legacy-file-input').setInputFiles(upload)
  await expect(page.getByTestId('legacy-preview-summary')).toContainText(/共 3 行数据，可导入 3 笔，\s*异常 0 行/)
  await expect(page.getByTestId('legacy-incremental-recovery')).toContainText('已存在 2 笔')
  await expect(page.getByTestId('legacy-incremental-recovery')).toContainText('本次可新增 1 笔')
  await expect(page.getByTestId('legacy-confirm')).toHaveText('确认导入 1 笔')
  await page.getByTestId('legacy-confirm').click()
  await expect(page.getByTestId('legacy-preview')).toHaveCount(0)
  const recovered = await snapshot(page)
  expect(recovered.transactions).toHaveLength(3)
  for (const tx of before.transactions) expect(recovered.transactions.find(row => row.id === tx.id)).toEqual(tx)
  expect(recovered.imports[0]).toMatchObject({ status: 'imported', transactionCount: 1, duplicateOf: null })
  expect(recovered.imports[0]!.message).toContain('增量恢复')
  await page.getByTestId('legacy-file-input').setInputFiles(upload)
  await expect(page.getByText('该文件此前已导入，确认后不会产生重复交易。')).toBeVisible()
  await expect(page.getByTestId('legacy-confirm')).toHaveText('确认导入 0 笔')
  await page.getByTestId('legacy-confirm').click()
  await expect(page.getByTestId('legacy-preview')).toHaveCount(0)
  const repeat = await snapshot(page)
  expect(repeat.transactions).toEqual(recovered.transactions)
  expect(repeat.statements).toEqual(recovered.statements)
  expect(repeat.imports[0]).toMatchObject({ status: 'duplicate', transactionCount: 0 })
})

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
