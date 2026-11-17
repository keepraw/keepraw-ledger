import { expect, test, type Page } from '@playwright/test'
import { SYNTHETIC_CCB_HTML } from '../tests/fixtures/ccbEml'

/**
 * Key user flows.
 *
 * The suite never touches a real statement. A dedicated spec
 * (`realStatement.spec.ts`) reads the two private samples from environment
 * variables when the developer points at them.
 */

async function goto(page: Page, hash: string): Promise<void> {
  await page.goto(`/#/${hash}`)
  await expect(page.locator('h1')).toBeVisible()
}

/** Exercise edits on imported synthetic data: the in-memory demo is regenerated. */
async function importSynthetic(page: Page, mismatch = false): Promise<void> {
  await goto(page, 'settings')
  await page.getByTestId('demo-toggle').uncheck()
  await goto(page, 'import')
  await expect(page.getByTestId('dropzone')).toBeEnabled()
  const html = mismatch ? SYNTHETIC_CCB_HTML.replace('2300.00', '2301.00') : SYNTHETIC_CCB_HTML
  await page.setInputFiles('[data-testid="file-input"]', { name: 'synthetic.html', mimeType: 'text/html', buffer: Buffer.from(html) })
  await expect(page.getByTestId('import-row').first()).toContainText(mismatch ? '待复核' : '解析成功')
}

test.describe('Demo Mode', () => {
  test('boots into demo mode with clearly labelled fictional data', async ({ page }) => {
    await goto(page, 'dashboard')

    await expect(page.locator('.notice-warn').first()).toContainText('演示模式')
    await expect(page.getByText('演示数据').first()).toBeVisible()
    await expect(page.locator('.stat-value').first()).not.toBeEmpty()

    // Demo card suffixes are obviously fake, never four random real digits.
    await goto(page, 'transactions')
    await expect(page.locator('tbody tr').first()).toContainText(/0000|9999/)
  })

  test('hides real data and blocks imports while demo mode is on', async ({ page }) => {
    await goto(page, 'import')
    await expect(page.getByTestId('dropzone')).toBeDisabled()
    await expect(page.locator('.notice-warn').first()).toContainText('演示模式已开启')
  })
})

test.describe('Dashboard', () => {
  test('shows debit, credit, net and reconciliation status', async ({ page }) => {
    await goto(page, 'dashboard')
    const stats = page.locator('.stat')
    await expect(stats.nth(0)).toContainText('借记总额')
    await expect(stats.nth(1)).toContainText('贷记总额')
    await expect(stats.nth(2)).toContainText('账单入账净额')
    await expect(stats.nth(3)).toContainText('交易笔数')
    await expect(page.locator('.bar-col').first()).toBeVisible()
    await expect(page.locator('.hbar').first()).toBeVisible()
    // The demo dataset deliberately contains one statement that does not balance.
    await expect(page.locator('.notice-warn').filter({ hasText: '未通过对账' })).toBeVisible()
  })

  test('filters by month', async ({ page }) => {
    await goto(page, 'dashboard')
    const before = await page.locator('.stat-value').first().textContent()
    const select = page.locator('select').first()
    const options = await select.locator('option').all()
    expect(options.length).toBeGreaterThan(2)
    await select.selectOption({ index: 1 })
    await expect(page.locator('.stat-value').first()).not.toHaveText(before ?? '')
  })

  test('keeps the dashboard within phone, tablet and desktop viewport widths', async ({ page }) => {
    await goto(page, 'dashboard')
    for (const width of [360, 768, 1280]) {
      await page.setViewportSize({ width, height: 900 })
      await expect(page.locator('.bar-chart-scroll')).toBeVisible()
      const layout = await page.evaluate(() => ({
        viewportWidth: window.innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        chartViewportWidth: document.querySelector('.bar-chart-scroll')?.clientWidth ?? 0,
        chartContentWidth: document.querySelector('.bar-chart-scroll')?.scrollWidth ?? 0,
      }))
      expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth)
      expect(layout.chartContentWidth).toBeGreaterThanOrEqual(layout.chartViewportWidth)
    }
  })
})

test.describe('Transactions', () => {
  test('searches, sorts and exports', async ({ page }) => {
    await goto(page, 'transactions')
    const table = page.getByTestId('transactions-table')
    await expect(table).toBeVisible()
    const first = table.locator('tbody tr').first()

    await page.getByTestId('transaction-search').fill('示例')
    await expect(table.locator('tbody tr').first()).toBeVisible()

    await page.getByTestId('transaction-search').fill('绝对不存在的商户名称')
    await expect(page.locator('.empty')).toBeVisible()
    await page.getByTestId('transaction-search').fill('')

    const before = await first.textContent()
    await table.locator('th', { hasText: '金额' }).click()
    await expect(table.locator('tbody tr').first()).not.toHaveText(before ?? '')

    const download = page.waitForEvent('download')
    await page.getByTestId('export-csv').click()
    const file = await download
    expect(file.suggestedFilename()).toBe('交易明细.csv')
  })

  test('changes a category and persists it', async ({ page }) => {
    await importSynthetic(page)
    await goto(page, 'transactions')
    const select = page.locator('tbody select').first()
    await select.selectOption('餐饮')
    await expect(select).toHaveValue('餐饮')
    await page.reload()
    await goto(page, 'transactions')
    await expect(page.locator('tbody select').first()).toHaveValue('餐饮')
  })
})

test.describe('Review', () => {
  test('shows reconciliation differences and lets a human resolve a row', async ({ page }) => {
    await importSynthetic(page, true)
    await goto(page, 'review')

    await expect(page.getByRole('heading', { name: /对账明细/ })).toBeVisible()
    const checks = page.locator('.check')
    await expect(checks.first()).toBeVisible()
    await expect(page.locator('.check').filter({ hasText: '存在差额' }).first()).toBeVisible()

    await page.getByRole('button', { name: '交易复核' }).click()
    const table = page.getByTestId('review-table')
    await expect(table).toBeVisible()
    const rowCount = await table.locator('tbody tr').count()
    expect(rowCount).toBeGreaterThan(0)

    await table.locator('tbody tr').first().getByRole('button', { name: '确认' }).click()
    await expect(table.locator('tbody tr')).toHaveCount(rowCount - 1)

    await page.reload()
    await goto(page, 'review')
    await page.getByRole('button', { name: '交易复核' }).click()
    await expect(page.getByTestId('review-table').locator('tbody tr')).toHaveCount(rowCount - 1)
  })
})

test.describe('Settings', () => {
  test('switches theme', async ({ page }) => {
    await goto(page, 'settings')
    await page.getByTestId('theme-dark').click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await page.getByTestId('theme-light').click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  })

  test('exports and restores a backup', async ({ page }) => {
    await importSynthetic(page)
    await goto(page, 'settings')
    const download = page.waitForEvent('download')
    await page.getByTestId('backup').click()
    const file = await download
    const path = await file.path()
    expect(path).toBeTruthy()
    page.once('dialog', (dialog) => void dialog.accept())
    await page.getByTestId('clear-real').click()
    await expect(page.getByText(/真实数据 0 份账单、0 笔交易/)).toBeVisible()
    await page.setInputFiles('input[type="file"][accept*=".json"]', path!)
    await expect(page.getByText(/已恢复 14 笔交易/)).toBeVisible()
    await goto(page, 'transactions')
    await expect(page.locator('tbody tr')).toHaveCount(14)
  })
})

test.describe('Import guardrails', () => {
  test('never reports an unreadable or unknown file as a success', async ({ page }) => {
    await goto(page, 'settings')
    const toggle = page.getByTestId('demo-toggle')
    if (await toggle.isChecked()) await toggle.uncheck()

    await goto(page, 'import')
    await expect(page.getByTestId('dropzone')).toBeEnabled()

    // A file that is not a real PDF at all.
    await page.setInputFiles('[data-testid="file-input"]', {
      name: 'unknown.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4 not a statement at all'),
    })
    const brokenRow = page.getByTestId('import-row').first()
    await expect(brokenRow).toBeVisible({ timeout: 30_000 })
    await expect(brokenRow).not.toContainText('解析成功')

    // A readable but unrecognised file type.
    await page.setInputFiles('[data-testid="file-input"]', {
      name: 'notes.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('这是一份与信用卡账单无关的旅行行程单'),
    })
    const unknownRow = page.getByTestId('import-row').first()
    await expect(unknownRow).toBeVisible({ timeout: 30_000 })
    await expect(unknownRow).not.toContainText('解析成功')
  })
})
