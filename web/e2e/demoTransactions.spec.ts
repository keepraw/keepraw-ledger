import { transactionDisplayDescription } from '../src/core/descriptionNormalizer'
import { expect, test, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import JSZip from 'jszip'
import { syntheticStatement } from '../tests/fixtures/identity'
import { buildDemoDataset } from '../src/demo/demoData'
import { deriveStatementState } from '../src/core/statementState'
import { formatMinor } from '../src/core/money'
import type { Transaction } from '../src/core/types'

const demo = buildDemoDataset().flatMap(result => result.transactions)
const pending = demo.filter(tx => tx.reviewStatus === 'pending' || tx.flags.length > 0)
const confirmed = pending[0]!, excluded = pending[1]!
const rowFor = (page: Page, tx: Transaction) => page.getByTestId('review-table').locator('tbody tr')
  .filter({ has: page.getByTitle(tx.rawDescription, { exact: true }) })
  .filter({ has: page.getByText(tx.transactionDate!, { exact: true }) })
  .filter({ has: page.getByText(formatMinor(tx.settlementAmountMinor, tx.settlementCurrency), { exact: true }) })
const categoryFor = (page: Page, tx: Transaction) => page.getByTestId('transactions-table').locator('tbody tr')
  .filter({ has: page.getByTitle(`${transactionDisplayDescription(tx)}｜原始：${tx.rawDescription}`, { exact: true }) })
  .filter({ has: page.getByText(formatMinor(tx.settlementAmountMinor, tx.settlementCurrency), { exact: true }) }).getByRole('combobox')
async function stored(page: Page) {
  return page.evaluate(async () => {
    const repoUrl = '/src/db/repository.ts', dbUrl = '/src/db/db.ts'
    const repository = await import(repoUrl), { db } = await import(dbUrl)
    const attachments = await db.attachments.toArray()
    return { snapshot: await repository.readSnapshot(), notes: await db.reviewNotes.toArray(),
      attachments: attachments.map((row: { data: ArrayBuffer }) => ({ ...row, data: Array.from(new Uint8Array(row.data)) })) }
  })
}
async function review(page: Page) {
  await page.goto('/#/review')
  await page.getByRole('button', { name: /交易复核/ }).click()
}
async function switchDemo(page: Page, enabled: boolean) {
  await page.goto('/#/settings')
  await page.getByTestId('demo-toggle').setChecked(enabled)
  await expect.poll(() => page.evaluate(async () => { const url = '/src/db/db.ts'; return (await import(url)).loadSettings().then((s: { demoMode: boolean }) => s.demoMode) })).toBe(enabled)
}

test('demo confirmation and exclusion update review rows and derived statements immediately', async ({ page }) => {
  await review(page)
  const pendingStatements = buildDemoDataset().filter(result => result.statement!.status !== 'reconciled' && result.statement!.status !== 'imported').length
  await expect(page.getByTestId('nav-review')).toHaveText(`人工复核${pendingStatements}`)
  await expect(rowFor(page, confirmed)).toHaveCount(1)
  await rowFor(page, confirmed).getByRole('button', { name: '确认', exact: true }).click()
  await expect(rowFor(page, confirmed)).toHaveCount(0)
  await rowFor(page, excluded).getByRole('button', { name: '排除', exact: true }).click()
  await expect(rowFor(page, excluded)).toHaveCount(0)
  const statement = buildDemoDataset().find(result => result.statement!.id === excluded.statementId)!
  const next = deriveStatementState(statement.statement!, statement.transactions.map(tx => tx.id === excluded.id ? { ...tx, reviewStatus: 'rejected' } : tx))
  const detail = next.reconciliation.checks.find(check => check.id === 'debit_detail')!
  await page.getByRole('button', { name: /账单对账/ }).click()
  await page.getByRole('checkbox', { name: '显示全部账单（可重新核对历史状态）' }).check()
  const statementRow = page.locator('table').first().locator('tbody tr').filter({ hasText: `${statement.statement!.cycleStart} ~ ${statement.statement!.cycleEnd}` }).filter({ hasText: `尾号${excluded.cardLast4}` })
  await statementRow.click()
  await expect(page.getByText(detail.detail, { exact: true })).toBeVisible()
  expect((await stored(page)).snapshot.transactions).toHaveLength(0)
})

test('demo lifecycle preserves real stores, JSON/ZIP backups and real editing', async ({ page, context }) => {
  await page.goto('/#/settings')
  await switchDemo(page, false)
  const parsed = syntheticStatement(['消费 AUD006合成真实商户'])
  parsed.summary = { ...parsed.summary, previousBalanceMinor: 0, currentBalanceMinor: 12880, newDebitMinor: 12880, newCreditMinor: 0 }
  // A reconciled, nonzero real ledger with one reviewable row.
  parsed.transactions[0]!.confidence = 0.7
  await page.evaluate(async parsed => {
    const repoUrl = '/src/db/repository.ts', ingestUrl = '/src/core/ingest.ts'
    const repository = await import(repoUrl), { ingestParsedStatement } = await import(ingestUrl)
    const bytes = new TextEncoder().encode('AUD006_SYNTHETIC_ORIGINAL')
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map(b => b.toString(16).padStart(2, '0')).join('')
    const result = ingestParsedStatement(parsed, { fileName: 'synthetic.txt', fileHash: hash, fileSize: bytes.length, sourceType: 'text' }, await repository.readSnapshot())
    await repository.persistImportResults([result])
    await repository.saveOriginalFile({ fileHash: hash, fileName: 'synthetic.txt', importId: result.record.id, parserId: result.record.parserId, data: bytes.buffer })
    await repository.setReviewNote(result.transactions[0].id, 'AUD006_REAL_PRIVATE_NOTE')
    await repository.setReviewNote('orphan-aud006', 'AUD006_ORPHAN_PRIVATE_NOTE')
  }, parsed)
  await page.reload()
  const before = await stored(page)
  await page.goto('/#/dashboard')
  await expect(page.locator('.stat-value').first()).toHaveText('¥128.80')
  const realStats = await page.locator('.stat-value').allTextContents()
  await switchDemo(page, true)
  await review(page)
  await page.getByPlaceholder('例如：与银行 App 对账一致，确认为退款').fill('AUD006_DEMO_NOTE')
  await page.getByRole('button', { name: '保存备注' }).click()
  await expect(page.getByText('AUD006_DEMO_NOTE', { exact: true })).toBeVisible()
  await rowFor(page, confirmed).getByRole('button', { name: '确认', exact: true }).click()
  await expect(rowFor(page, confirmed)).toHaveCount(0)
  await rowFor(page, excluded).getByRole('button', { name: '排除', exact: true }).click()
  await expect(rowFor(page, excluded)).toHaveCount(0)
  await page.goto('/#/transactions')
  await page.getByTestId('transaction-search').fill(confirmed.description)
  const category = categoryFor(page, confirmed)
  await category.selectOption('旅行')
  await expect(category).toHaveValue('旅行')
  await page.goto('/#/settings')
  for (const kind of ['backup', 'backup-full']) {
    const download = page.waitForEvent('download')
    await page.getByTestId(kind).click()
    const file = await download, bytes = await readFile((await file.path())!)
    const json = kind === 'backup' ? bytes.toString('utf8') : await (await JSZip.loadAsync(bytes)).file('database.json')!.async('string')
    const backup = JSON.parse(json)
    expect(backup.transactions).toEqual(before.snapshot.transactions)
    expect(backup.statements).toEqual(before.snapshot.statements)
    expect(backup.imports).toEqual(before.snapshot.imports)
    expect(backup.reviewNotes).toEqual(before.notes)
    expect(json).not.toContain('AUD006_DEMO_NOTE')
    expect(backup.transactions.every((tx: { isDemo: boolean }) => !tx.isDemo)).toBe(true)
    if (kind === 'backup-full') {
      const zip = await JSZip.loadAsync(bytes), manifest = JSON.parse(await zip.file('manifest.json')!.async('string'))
      expect(manifest.files).toHaveLength(1)
      const original = Object.keys(zip.files).find(name => name.startsWith('original-files/') && !zip.files[name]!.dir)!
      expect(await zip.file(original)!.async('string')).toBe('AUD006_SYNTHETIC_ORIGINAL')
    }
  }
  expect(await stored(page)).toEqual(before)
  await switchDemo(page, false)
  await page.goto('/#/dashboard')
  await expect.poll(() => page.locator('.stat-value').allTextContents()).toEqual(realStats)
  await page.goto('/#/transactions')
  await expect(page.getByText('AUD006合成真实商户', { exact: true })).toHaveAttribute('title', 'AUD006合成真实商户｜原始：消费 AUD006合成真实商户')
  await expect(page.getByText(transactionDisplayDescription(confirmed), { exact: true })).toHaveCount(0)
  await switchDemo(page, true)
  await review(page)
  await expect(rowFor(page, confirmed)).toHaveCount(0)
  await expect(rowFor(page, excluded)).toHaveCount(0)
  await expect(page.getByText('AUD006_DEMO_NOTE', { exact: true })).toBeVisible()
  await expect(page.getByText('AUD006_REAL_PRIVATE_NOTE', { exact: true })).toHaveCount(0)
  await page.goto('/#/transactions')
  await page.getByTestId('transaction-search').fill(confirmed.description)
  await expect(categoryFor(page, confirmed)).toHaveValue('旅行')
  await page.goto('/#/settings')
  await page.getByRole('button', { name: '重新生成演示数据' }).click()
  await review(page)
  await expect(rowFor(page, confirmed)).toHaveCount(1)
  await expect(rowFor(page, excluded)).toHaveCount(1)
  await expect(page.getByText('AUD006_DEMO_NOTE', { exact: true })).toHaveCount(0)
  await page.goto('/#/transactions')
  await page.getByTestId('transaction-search').fill(confirmed.description)
  await expect(categoryFor(page, confirmed)).toHaveValue(confirmed.category)
  await review(page)
  await rowFor(page, confirmed).getByRole('button', { name: '确认', exact: true }).click()
  await expect(rowFor(page, confirmed)).toHaveCount(0)
  await page.goto('/#/transactions')
  await page.getByTestId('transaction-search').fill(confirmed.description)
  await categoryFor(page, confirmed).selectOption('旅行')
  await expect(categoryFor(page, confirmed)).toHaveValue('旅行')
  await page.reload()
  await page.getByTestId('transaction-search').fill(confirmed.description)
  await expect(categoryFor(page, confirmed)).toHaveValue(confirmed.category)
  await review(page)
  await expect(rowFor(page, confirmed)).toHaveCount(1)
  await rowFor(page, confirmed).getByRole('button', { name: '排除', exact: true }).click()
  await expect(rowFor(page, confirmed)).toHaveCount(0)
  const reopened = await context.newPage()
  await review(reopened)
  await expect(rowFor(reopened, confirmed)).toHaveCount(1)
  await reopened.close()
  expect(await stored(page)).toEqual(before)
  await switchDemo(page, false)
  await review(page)
  await expect(page.getByText('AUD006_REAL_PRIVATE_NOTE', { exact: true })).toBeVisible()
  await expect(page.getByText('AUD006_ORPHAN_PRIVATE_NOTE', { exact: true })).toBeVisible()
  await page.getByTestId('review-table').getByRole('button', { name: '确认', exact: true }).click()
  await expect(page.getByText('没有需要复核的交易')).toBeVisible()
  const peer = await context.newPage()
  await peer.goto('/#/transactions')
  await expect(peer.getByLabel('AUD006合成真实商户 分类', { exact: true })).toHaveValue(before.snapshot.transactions[0].category)
  await page.goto('/#/transactions')
  await page.getByLabel('AUD006合成真实商户 分类', { exact: true }).selectOption('旅行')
  await expect(peer.getByLabel('AUD006合成真实商户 分类', { exact: true })).toHaveValue('旅行')
  await peer.close()
  await page.reload()
  await expect(page.getByLabel('AUD006合成真实商户 分类', { exact: true })).toHaveValue('旅行')
  const after = await stored(page)
  expect(after.snapshot.transactions[0]).toMatchObject({ reviewStatus: 'confirmed', category: '旅行' })
  expect(after.notes).toEqual(before.notes)
  expect(after.attachments).toEqual(before.attachments)
})
