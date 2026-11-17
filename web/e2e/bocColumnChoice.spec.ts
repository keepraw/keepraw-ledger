import { test, expect, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { bocAmountColumns } from '../tests/fixtures/directionConflicts'
import { encodeBocPdf } from '../tests/fixtures/bocCurrencyPdf'

const CASES = [
  ['152.00', '12.34', 'debit', 15200], ['152.00', '12.34', 'credit', -1234],
  ['12.34', '152.00', 'debit', 1234], ['12.34', '152.00', 'credit', -15200],
] as const
async function realLedger(page: Page) { await page.goto('/#/settings'); await page.getByTestId('demo-toggle').uncheck() }
async function state(page: Page) {
  return page.evaluate(async () => {
    const dbUrl = '/src/db/db.ts', financeUrl = '/src/core/analytics.ts', detailUrl = '/src/core/reconcile.ts', totalUrl = '/src/core/reconciliation.ts'
    const { db } = await import(dbUrl), { summarize, monthlyTrend, groupByBank, groupBy } = await import(financeUrl)
    const { reconcileStatement } = await import(detailUrl), { reconcileStatementTransactions } = await import(totalUrl)
    const rows = await db.transactions.toArray(), statement = (await db.statements.toArray())[0]
    return { rows, summary: summarize(rows), trend: monthlyTrend(rows), bank: groupByBank(rows), categories: groupBy(rows, () => '全部'), statement,
      detail: reconcileStatement({ summary: statement.summary, transactions: rows }), total: reconcileStatementTransactions(statement, rows) }
  })
}
async function restoreXlsx(page: Page, bytes: Buffer) {
  await realLedger(page); await page.goto('/#/import')
  await page.getByTestId('legacy-file-input').setInputFiles({ name: 'synthetic-columns.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: bytes })
  await expect(page.getByTestId('legacy-preview-summary')).toContainText('可导入 7 笔')
  await page.getByTestId('legacy-confirm').click(); await expect(page.getByTestId('legacy-preview')).toHaveCount(0)
}
async function exportXlsx(page: Page) {
  await page.goto('/#/transactions')
  const downloaded = page.waitForEvent('download'); await page.getByTestId('export-xlsx').click()
  return readFile((await (await downloaded).path())!)
}
for (const reverse of [false, true]) for (const [debit, credit, direction, expected] of CASES) {
  test(`BOC PDF order reverse=${reverse}, ${debit}/${credit}, choose ${direction} uses ${expected} and survives native/backup recovery`, async ({ page, browser }) => {
    const pdf = bocAmountColumns(debit, credit, reverse)
    const expectedDebit = 104800 + (direction === 'debit' ? expected : 0), expectedCredit = 560000 + (direction === 'credit' ? -expected : 0)
    const expectedBalance = 500000 + expectedDebit - expectedCredit
    const decimal = (minor: number) => `${minor < 0 ? '-' : ''}${Math.floor(Math.abs(minor) / 100)}.${String(Math.abs(minor) % 100).padStart(2, '0')}`
    for (const item of pdf.pages[0]!.items) {
      if (item.text === '1200.00') item.text = decimal(expectedDebit)
      if (item.text === '5600.00') item.text = decimal(expectedCredit)
      if (item.text === '600.00') item.text = decimal(expectedBalance)
      if (item.text === '欠款/DEBT 600.00') item.text = `欠款/DEBT ${decimal(expectedBalance)}`
    }
    await realLedger(page); await page.goto('/#/import')
    await page.getByTestId('file-input').setInputFiles({ name: 'synthetic-columns.pdf', mimeType: 'application/pdf', buffer: Buffer.from(encodeBocPdf(pdf)) })
    await expect(page.getByTestId('import-row').first()).toContainText('解析到 7 笔')
    const before = await state(page), original = before.rows.find((tx: { rawDescription: string }) => tx.rawDescription === '示例超市-东门店')
    expect(original.bankColumnAmounts).toMatchObject({ debit: { rawText: debit, currency: 'CNY' }, credit: { rawText: credit, currency: 'CNY' } })
    expect(before.summary).toMatchObject({ billingDebitMinor: 104800, billingCreditMinor: 560000, transactionCount: 6 })
    expect(before.detail.status).toBe('mismatch'); expect(before.total.status).toBe('mismatch')
    const unresolvedBytes = await exportXlsx(page)
    await page.goto('/#/review'); await page.getByRole('button', { name: /交易复核/ }).click()
    const row = page.getByTestId('review-table').locator('tbody tr').filter({ has: page.getByRole('checkbox', { name: `选择交易 ${original.id}`, exact: true }) })
    await expect(row.getByTestId('direction-review')).toContainText(`银行支出列（借记）：CNY ${debit}`)
    await expect(row.getByTestId('direction-review')).toContainText(`银行存入列（贷记）：CNY ${credit}`)
    await expect(row.getByRole('button', { name: '确认', exact: true })).toBeDisabled()
    await expect(row.getByRole('combobox', { name: '选择入账方向' })).toHaveValue('')
    await row.getByRole('combobox', { name: '选择入账方向' }).selectOption(direction)
    await expect(row.getByTestId('direction-review')).toContainText(`入账 ${direction === 'credit' ? '-' : ''}${direction === 'debit' ? debit : credit}`)
    await row.getByRole('button', { name: '按所选方向入账' }).click()
    await expect(row.getByTestId('direction-review')).toHaveCount(0)
    const after = await state(page), selected = after.rows.find((tx: { id: string }) => tx.id === original.id)
    expect(selected.directionResolution).toEqual({ method: 'user_choice', direction, amountSource: `${direction}_column` })
    expect(selected).toMatchObject({ id: original.id, fingerprint: original.fingerprint, occurrence: original.occurrence,
      transactionAmountMinor: original.transactionAmountMinor, settlementAmountMinor: original.settlementAmountMinor,
      rawText: original.rawText, bankColumnAmounts: original.bankColumnAmounts })
    const totals = { billingDebitMinor: expectedDebit, billingCreditMinor: expectedCredit, netMinor: expectedDebit - expectedCredit, transactionCount: 7 }
    expect(after.summary).toEqual(totals)
    expect(after.trend).toEqual([{ month: '2026-08', debit: expectedDebit, credit: expectedCredit }])
    expect(after.bank).toEqual([{ label: 'boc', value: expectedDebit }])
    expect(after.categories).toEqual([{ label: '全部', value: expectedDebit }])
    expect(after.detail.status).toBe('passed'); expect(after.total).toMatchObject({ status: 'passed', transactionCount: 7, transactionTotalMinor: totals.netMinor })
    expect(after.statement.reconciliation.status).toBe('passed')
    await row.getByRole('button', { name: '确认', exact: true }).click()
    await expect(row).toHaveCount(0)
    expect((await state(page)).summary).toEqual(totals)
    await page.goto('/#/dashboard')
    await expect(page.locator('.stat').filter({ hasText: '账单入账净额' })).toContainText(decimal(totals.netMinor).replace(/\B(?=(\d{3})+(?!\d))/g, ','))
    const resolvedBytes = await exportXlsx(page)
    for (const [bytes, resolved] of [[unresolvedBytes, false], [resolvedBytes, true]] as const) {
      const context = await browser.newContext()
      try {
        const restored = await context.newPage(); await restoreXlsx(restored, bytes)
        const observed = await state(restored), recovered = observed.rows.find((tx: { id: string }) => tx.id === original.id)
        expect(recovered).toMatchObject({ id: original.id, fingerprint: original.fingerprint, occurrence: original.occurrence,
          transactionAmountMinor: original.transactionAmountMinor, settlementAmountMinor: original.settlementAmountMinor,
          bankColumnAmounts: original.bankColumnAmounts, rawText: original.rawText })
        expect(observed.summary).toEqual(resolved ? totals : before.summary)
        if (resolved) {
          expect(recovered).toMatchObject({ directionResolution: selected.directionResolution, flags: [], reviewStatus: 'confirmed' })
          const statuses = await restored.evaluate(async summary => {
            const dbUrl = '/src/db/db.ts', detailUrl = '/src/core/reconcile.ts', totalUrl = '/src/core/reconciliation.ts'
            const { db } = await import(dbUrl), { reconcileStatement } = await import(detailUrl), { reconcileStatementTransactions } = await import(totalUrl)
            const rows = await db.transactions.toArray(), statement = (await db.statements.toArray())[0]
            return [reconcileStatement({ summary, transactions: rows }).status, reconcileStatementTransactions({ ...statement, summary }, rows).status]
          }, after.statement.summary)
          expect(statuses).toEqual(['passed', 'passed'])
        }
        else expect(recovered).toMatchObject({ flags: original.flags, reviewStatus: 'pending' })
        await restored.goto('/#/review'); await restored.getByRole('button', { name: /交易复核/ }).click()
        const pending = restored.getByTestId('review-table').locator('tbody tr').filter({ has: restored.getByRole('checkbox', { name: `选择交易 ${original.id}`, exact: true }) })
        await expect(pending.getByTestId('direction-review')).toHaveCount(resolved ? 0 : 1)
      } finally { await context.close() }
    }
    // Exercise actual browser JSON V1/V2 and full ZIP transport for the unequal credit choice.
    if (!reverse && direction === 'credit' && expected === -1234) {
      const backups = await page.evaluate(async () => {
        const repoUrl = '/src/db/repository.ts', zipUrl = '/src/backup/archive.ts'
        const { exportDataBackup } = await import(repoUrl), { buildFullBackupZip } = await import(zipUrl)
        return { payload: await exportDataBackup(), zip: [...new Uint8Array(await (await buildFullBackupZip()).blob.arrayBuffer())] }
      })
      for (const format of ['V1', 'V2', 'ZIP']) {
        const context = await browser.newContext()
        try {
          const restored = await context.newPage(); await realLedger(restored)
          await restored.evaluate(async ({ backups, format }) => {
            const repoUrl = '/src/db/repository.ts', zipUrl = '/src/backup/archive.ts'
            if (format === 'ZIP') { const { restoreFullBackupZip } = await import(zipUrl); await restoreFullBackupZip(new Blob([new Uint8Array(backups.zip)])); return }
            const { importBackup } = await import(repoUrl), payload = structuredClone(backups.payload)
            if (format === 'V1') { payload.version = 1; delete payload.reviewNotes }
            await importBackup(payload); await importBackup(payload)
          }, { backups, format })
          const observed = await state(restored), recovered = observed.rows.find((tx: { id: string }) => tx.id === original.id)
          expect(recovered).toMatchObject({ directionResolution: selected.directionResolution, bankColumnAmounts: original.bankColumnAmounts,
            id: original.id, fingerprint: original.fingerprint, rawText: original.rawText })
          expect(observed.summary).toEqual(totals); expect(observed.detail.status).toBe('passed'); expect(observed.total.status).toBe('passed')
        } finally { await context.close() }
      }
    }
  })
}
