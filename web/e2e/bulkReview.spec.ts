import { expect, test, type Page } from '@playwright/test'
import { reviewBatchFixture } from '../tests/fixtures/reviewBatch'
import type { Transaction } from '../src/core/types'

async function stored(page: Page) {
  return page.evaluate(async () => {
    const url = '/src/db/db.ts', { db } = await import(url)
    return { transactions: await db.transactions.toArray() as Transaction[], statements: await db.statements.toArray(),
      notes: await db.reviewNotes.toArray(), imports: await db.imports.toArray(), attachments: await db.attachments.toArray() }
  })
}
async function review(page: Page, total: number) {
  await page.goto('/#/review')
  await page.getByRole('button', { name: `交易复核 ${total}`, exact: true }).click()
}
async function seed(page: Page, count: number) {
  await page.goto('/#/settings')
  await page.getByTestId('demo-toggle').uncheck()
  await page.evaluate(async fixture => {
    const url = '/src/db/db.ts', { db } = await import(url)
    await db.transaction('rw', db.transactions, db.statements, db.imports, db.reviewNotes, async () => {
      await db.statements.bulkPut(fixture.statements); await db.transactions.bulkPut(fixture.transactions)
      await db.imports.bulkPut(fixture.imports); await db.reviewNotes.bulkPut(fixture.notes)
    })
  }, reviewBatchFixture(count))
  await page.reload()
}
const visibleRows = (page: Page) => page.getByTestId('review-table').locator(':scope > tbody > tr')

test('18,286 rows: bounded DOM, cross-page selection, atomic confirmation/exclusion, persistence and unchanged financial fields', async ({ page, context }) => {
  test.setTimeout(240_000)
  await seed(page, 18_286)
  const before = await stored(page)
  await review(page, 18_286)
  await expect(visibleRows(page)).toHaveCount(100)
  const pagination = page.getByRole('navigation', { name: '交易复核分页' })
  await expect(pagination).toContainText('1–100 / 18,286')
  await pagination.getByRole('button', { name: '下一页', exact: true }).click()
  await expect(pagination).toContainText('101–200 / 18,286')
  await page.getByRole('checkbox', { name: '全选当前页', exact: true }).check()
  await expect(page.getByTestId('review-selection-count')).toHaveText('已选择 100 笔')
  await pagination.getByRole('button', { name: '首页', exact: true }).click()
  await page.getByRole('button', { name: '全选全部待复核 18,286 笔', exact: true }).click()
  await expect(page.getByTestId('review-selection-count')).toHaveText('已选择 18,286 笔')
  const unselected = await visibleRows(page).first().getByRole('checkbox').getAttribute('value')
  await visibleRows(page).first().getByRole('checkbox').uncheck()
  await pagination.getByRole('button', { name: '下一页', exact: true }).click()
  await expect(page.getByTestId('review-selection-count')).toHaveText('已选择 18,285 笔')
  await page.getByRole('button', { name: '清空选择', exact: true }).click()
  await expect(page.getByTestId('review-selection-count')).toHaveText('已选择 0 笔')
  await page.getByRole('button', { name: '全选全部待复核 18,286 笔', exact: true }).click()
  await pagination.getByRole('button', { name: '首页', exact: true }).click()
  await visibleRows(page).first().getByRole('checkbox').uncheck()
  await page.getByRole('button', { name: '批量确认', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '批量确认交易' })
  await expect(dialog).toContainText('18,285')
  await expect(dialog).toContainText('清除疑似重复标记')
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  expect(await stored(page)).toEqual(before)
  await pagination.getByRole('button', { name: '末页', exact: true }).click()
  await page.getByRole('button', { name: '批量确认', exact: true }).click()
  await dialog.getByRole('button', { name: '确定批量确认', exact: true }).click()
  await expect(page.getByRole('button', { name: '交易复核 1', exact: true })).toBeVisible({ timeout: 60_000 })
  await expect(visibleRows(page)).toHaveCount(1)
  await expect(pagination).toContainText('第 1 / 1 页')
  await expect(page.getByTestId('review-selection-count')).toHaveText('已选择 0 笔')
  const confirmed = await stored(page)
  const expected = before.transactions.map(tx => tx.reviewStatus === 'pending' && tx.id !== unselected
    ? { ...tx, reviewStatus: 'confirmed', flags: [] } : tx)
  expect(confirmed.transactions).toEqual(expected)
  expect(confirmed.notes).toEqual(before.notes)
  const remaining = confirmed.transactions.find(tx => tx.id === unselected)!
  await page.getByRole('button', { name: '全选全部待复核 1 笔', exact: true }).click()
  await page.getByRole('button', { name: '批量排除', exact: true }).click()
  await page.getByRole('dialog', { name: '批量排除交易' }).getByRole('button', { name: '确定批量排除', exact: true }).click()
  await expect(page.getByRole('button', { name: '交易复核 0', exact: true })).toBeVisible()
  const after = await stored(page)
  expect(after.transactions).toEqual(expected.map(tx => tx.id === unselected ? { ...remaining, reviewStatus: 'rejected' } : tx))
  for (const key of ['notes', 'imports', 'attachments'] as const) expect(after[key]).toEqual(before[key])
  await page.reload()
  expect(await stored(page)).toEqual(after)
  await page.close()
  const reopened = await context.newPage()
  await reopened.goto('/#/review')
  await expect(reopened.getByRole('button', { name: '交易复核 0', exact: true })).toBeVisible()
  expect(await stored(reopened)).toEqual(after)
  console.info('bulk review: 18,286 pending; 100 DOM rows; confirm 18,285, reject 1; all other fields/notes preserved after refresh/reopen')
})

test('UI failure rolls back the entire batch, retains selection, and retry preserves a concurrent edit and synchronizes another page', async ({ page, context }) => {
  await seed(page, 12)
  await review(page, 12)
  await page.getByRole('checkbox', { name: '全选当前页', exact: true }).check()
  const peer = await context.newPage()
  await peer.goto('/#/review')
  await expect(peer.getByRole('button', { name: '交易复核 12', exact: true })).toBeVisible()
  const before = await stored(page)
  await page.evaluate(async () => {
    const url = '/src/db/db.ts', { db } = await import(url)
    let attempts = 0
    const fail = (modifications: Partial<Transaction>) => {
      if (modifications.reviewStatus === 'confirmed' && ++attempts === 2) throw new Error('synthetic batch write failure')
    }
    db.transactions.hook('updating', fail)
    ;(window as typeof window & { removeReviewFailure?: () => void }).removeReviewFailure = () => db.transactions.hook('updating').unsubscribe(fail)
  })
  await page.getByRole('button', { name: '批量确认', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: '确定批量确认', exact: true }).click()
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('synthetic batch write failure')
  await expect(page.getByTestId('review-selection-count')).toHaveText('已选择 12 笔')
  expect(await stored(page)).toEqual(before)
  await page.evaluate(async () => {
    (window as typeof window & { removeReviewFailure?: () => void }).removeReviewFailure?.()
    const url = '/src/db/db.ts', { db } = await import(url)
    const target = (await db.transactions.toArray()).find((row: Transaction) => row.reviewStatus === 'pending')!
    await db.transactions.update(target.id, { category: '旅行', description: 'Synthetic concurrent description', confidence: 0.41 })
  })
  const latest = await stored(page)
  await page.getByRole('dialog').getByRole('button', { name: '确定批量确认', exact: true }).click()
  await expect(page.getByRole('button', { name: '交易复核 0', exact: true })).toBeVisible()
  await expect(peer.getByRole('button', { name: '交易复核 0', exact: true })).toBeVisible()
  const after = await stored(page)
  expect(after.transactions).toEqual(latest.transactions.map(row => row.reviewStatus === 'pending'
    ? { ...row, flags: [], reviewStatus: 'confirmed' } : row))
  expect(after.notes).toEqual(before.notes)
  await peer.close()
})

test('Demo bulk review stays in memory and never changes real records, notes, evidence or ledger revision', async ({ page }) => {
  await seed(page, 10)
  await page.goto('/#/settings')
  await page.getByTestId('demo-toggle').check()
  await expect.poll(() => page.evaluate(async () => { const url = '/src/db/db.ts'; return (await import(url)).loadSettings().then((s: {demoMode: boolean}) => s.demoMode) })).toBe(true)
  const before = await stored(page)
  const revision = await page.evaluate(async () => { const url = '/src/db/ledgerRevision.ts'; return (await import(url)).readLedgerRevision() })
  await page.goto('/#/review')
  await page.getByRole('button', { name: /交易复核/ }).click()
  await page.getByRole('button', { name: /^全选全部待复核/ }).click()
  await page.getByRole('button', { name: '批量排除', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: '确定批量排除', exact: true }).click()
  await expect(page.getByRole('button', { name: '交易复核 0', exact: true })).toBeVisible()
  expect(await stored(page)).toEqual(before)
  expect(await page.evaluate(async () => { const url = '/src/db/ledgerRevision.ts'; return (await import(url)).readLedgerRevision() })).toEqual(revision)
  await page.reload()
  await expect(page.getByRole('button', { name: /交易复核 [1-9]/ })).toBeVisible()
  expect(await stored(page)).toEqual(before)
})

test('50/100/200 page sizes and multi-row exclusion preserve original flags and unselected rows', async ({ page }) => {
  await seed(page, 251)
  const before = await stored(page)
  await review(page, 251)
  const size = page.getByRole('combobox', { name: '交易复核每页笔数' })
  for (const count of [50, 100, 200]) {
    await size.selectOption(String(count))
    await expect(visibleRows(page)).toHaveCount(count)
  }
  const pagination = page.getByRole('navigation', { name: '交易复核分页' })
  await pagination.getByRole('button', { name: '末页', exact: true }).click()
  await expect(visibleRows(page)).toHaveCount(51)
  await page.getByRole('checkbox', { name: '全选当前页', exact: true }).check()
  const selected = new Set(await visibleRows(page).getByRole('checkbox').evaluateAll(inputs => inputs.map(input => (input as HTMLInputElement).value)))
  await page.getByRole('button', { name: '批量排除', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: '确定批量排除', exact: true }).click()
  await expect(page.getByRole('button', { name: '交易复核 200', exact: true })).toBeVisible()
  await expect(pagination).toContainText('第 1 / 1 页')
  await expect(visibleRows(page)).toHaveCount(200)
  const after = await stored(page)
  expect(after.transactions).toEqual(before.transactions.map(row => selected.has(row.id) ? { ...row, reviewStatus: 'rejected' } : row))
  expect(after.notes).toEqual(before.notes)
})
