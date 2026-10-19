import { expect, test, type Page } from '@playwright/test'
import { SYNTHETIC_CCB_HTML } from '../tests/fixtures/ccbEml'

function bill(description: string) {
  return SYNTHETIC_CCB_HTML
    .replace('<td>3000.00</td><td>6500.00</td><td>7200.00</td><td>2300.00</td>', '<td>0.00</td><td>128.80</td><td>0.00</td><td>128.80</td>')
    .replace(/<table>\s*<tr><td>【交易明细】[\s\S]*?<\/table>/,
      `<table><tr><td>交易日</td><td>银行记账日</td><td>卡号后四位</td><td>交易描述</td><td>交易币</td><td>金额</td><td>结算币</td><td>金额</td></tr>
      <tr><td>2026-08-10</td><td>2026-08-10</td><td>5678</td><td>消费 ${description}</td><td>CNY</td><td>128.80</td><td>CNY</td><td>128.80</td></tr></table>`)
}
async function ready(page: Page) {
  await page.goto('/#/settings')
  const toggle = page.getByTestId('demo-toggle')
  await expect(toggle).toBeVisible()
  if (await toggle.isChecked()) await toggle.uncheck()
  await page.goto('/#/import')
}
async function pauseRead(page: Page) {
  await page.evaluate(() => {
    const runtime = window as typeof window & { importPaused?: boolean; resumeImport?: () => void }
    const original = File.prototype.arrayBuffer
    File.prototype.arrayBuffer = async function () {
      const buffer = await original.call(this)
      runtime.importPaused = true
      await new Promise<void>(resolve => { runtime.resumeImport = resolve })
      return buffer
    }
  })
}
async function release(page: Page) {
  await page.evaluate(() => (window as typeof window & { resumeImport?: () => void }).resumeImport?.())
}
async function rows(page: Page) {
  return page.evaluate(async () => {
    const url = '/src/db/repository.ts'
    return (await import(url)).readSnapshot()
  })
}

for (const identical of [false, true]) {
  test(`two native Chromium tabs safely commit ${identical ? 'identical' : 'different'} 128.80 imports planned from an empty ledger`, async ({ page, context }) => {
    const other = await context.newPage()
    await ready(page); await ready(other)
    await pauseRead(page); await pauseRead(other)
    const first = { name: 'synthetic-a.html', mimeType: 'text/html', buffer: Buffer.from(bill('合成商户A')) }
    const second = identical ? first : { name: 'synthetic-b.html', mimeType: 'text/html', buffer: Buffer.from(bill('合成商户B')) }
    await Promise.all([page.getByTestId('file-input').setInputFiles(first), other.getByTestId('file-input').setInputFiles(second)])
    await Promise.all([page.waitForFunction(() => (window as typeof window & { importPaused?: boolean }).importPaused), other.waitForFunction(() => (window as typeof window & { importPaused?: boolean }).importPaused)])
    await Promise.all([release(page), release(other)])
    // Either tab can win; the other must complete as a reviewed merge or duplicate.
    await expect(page.getByTestId('import-row').first()).toContainText(/解析到 1 笔|内容完全相同/)
    await expect(other.getByTestId('import-row').first()).toContainText(/解析到 1 笔|内容完全相同/)
    await expect.poll(async () => (await rows(page)).imports.map((record: { status: string }) => record.status).sort())
      .toEqual(identical ? ['duplicate'] : ['needs_review', 'parsed'])
    const snapshot = await rows(page)
    expect(snapshot.transactions).toHaveLength(identical ? 1 : 2)
    expect(snapshot.imports).toHaveLength(identical ? 1 : 2)
    expect(snapshot.imports.map((record: { status: string }) => record.status).sort()).toEqual(identical ? ['duplicate'] : ['needs_review', 'parsed'])
    expect(snapshot.statements[0]).toMatchObject({ transactionCount: identical ? 1 : 2,
      status: identical ? 'reconciled' : 'needs_review', reconciliation: { status: identical ? 'passed' : 'mismatch' } })
    await page.goto('/#/transactions'); await other.goto('/#/transactions')
    await expect(other.locator('tbody tr')).toHaveCount(identical ? 1 : 2)
    await page.locator('tbody tr').first().locator('select').selectOption('旅行')
    await expect(other.locator('tbody tr').first().locator('select')).toHaveValue('旅行')
    await other.reload()
    await expect(other.locator('tbody tr')).toHaveCount(identical ? 1 : 2)
    if (!identical) {
      await page.goto('/#/review')
      await page.getByRole('button', { name: /交易复核/ }).click()
      await page.getByTestId('review-table').getByRole('button', { name: '排除' }).first().click()
      await other.goto('/#/dashboard')
      await expect(other.locator('.stat-value').first()).toHaveText('¥128.80')
    }
    await other.close()
  })
}

test('a different tab clearing during a paused native file import wins without resurrected rows or evidence', async ({ page, context }) => {
  const other = await context.newPage()
  await ready(page); await ready(other); await pauseRead(page)
  await page.getByTestId('file-input').setInputFiles({ name: 'synthetic-clear.html', mimeType: 'text/html', buffer: Buffer.from(bill('合成商户')) })
  await page.waitForFunction(() => (window as typeof window & { importPaused?: boolean }).importPaused)
  await other.evaluate(async () => {
    const url = '/src/db/repository.ts'
    await (await import(url)).clearAllData({ includeDemo: true })
  })
  await release(page)
  await expect(page.getByText(/账本已被其他标签页清除/)).toBeVisible()
  expect((await rows(page)).transactions).toHaveLength(0)
  expect((await rows(page)).imports).toHaveLength(0)
  const evidence = await page.evaluate(async () => {
    const url = '/src/db/db.ts'
    return (await import(url)).db.attachments.count()
  })
  expect(evidence).toBe(0)
  await other.close()
})
