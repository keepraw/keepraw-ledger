import { expect, test, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { SYNTHETIC_ABC_HTML } from '../tests/fixtures/abcEml'
import { SYNTHETIC_ICBC_HTML } from '../tests/fixtures/icbcEml'

async function realLedger(page: Page) {
  await page.goto('/#/settings'); await page.getByTestId('demo-toggle').uncheck()
}
async function upload(page: Page, html: string, count: number) {
  await page.goto('/#/import')
  await page.getByTestId('file-input').setInputFiles({ name: 'synthetic-direction.html', mimeType: 'text/html', buffer: Buffer.from(html) })
  await expect(page.getByTestId('import-row').first()).toContainText(`解析到 ${count} 笔`)
}
async function financialState(page: Page) {
  return page.evaluate(async () => {
    const dbUrl = '/src/db/db.ts', analyticsUrl = '/src/core/analytics.ts', detailUrl = '/src/core/reconcile.ts', totalUrl = '/src/core/reconciliation.ts'
    const { db } = await import(dbUrl), { summarize } = await import(analyticsUrl)
    const { reconcileStatement } = await import(detailUrl), { reconcileStatementTransactions } = await import(totalUrl)
    const rows = await db.transactions.toArray(), statements = await db.statements.toArray()
    const statement = statements[0]
    return { rows, summary: summarize(rows), statement,
      detail: reconcileStatement({ summary: statement.summary, transactions: rows }),
      total: reconcileStatementTransactions(statement, rows) }
  })
}
async function exportNative(page: Page) {
  await page.goto('/#/transactions')
  const download = page.waitForEvent('download'); await page.getByTestId('export-xlsx').click()
  return readFile((await (await download).path())!)
}
async function restoreNative(page: Page, bytes: Buffer, count: number) {
  await realLedger(page); await page.goto('/#/import')
  await page.getByTestId('legacy-file-input').setInputFiles({ name: 'synthetic-native.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: bytes })
  await expect(page.getByTestId('legacy-preview-summary')).toContainText(`可导入 ${count} 笔`)
  await page.getByTestId('legacy-confirm').click()
  await expect(page.getByTestId('legacy-preview')).toHaveCount(0)
}
const ABC_CASES = [
  { name: 'ABC negative original and positive settlement', credit: false, original: '-68.00/CNY', settlement: '68.00/CNY', originalMinor: -6800, settlementMinor: 6800 },
  { name: 'ABC negative original and negative source settlement', credit: false, original: '-68.00/CNY', settlement: '-68.00/CNY', originalMinor: -6800, settlementMinor: -6800 },
  { name: 'ABC positive debit settlement', credit: false, original: '68.00/CNY', settlement: '68.00/CNY', originalMinor: 6800, settlementMinor: 6800 },
  { name: 'ABC credit with contradicting signs', credit: true, original: '3000.00/CNY', settlement: '-3000.00/CNY', originalMinor: 300000, settlementMinor: -300000 },
]
for (const entry of ABC_CASES) {
  test(`${entry.name}: accept bank direction, reconcile, preserve raw evidence and resolved/unresolved XLSX`, async ({ page, browser }) => {
    const description = entry.credit ? '还款 卡卡转账' : '网上消费 示例餐厅'
    const old = entry.credit ? '<td>3000.00/CNY</td><td>3000.00/CNY</td>' : '<td>68.00/CNY</td><td>-68.00/CNY</td>'
    const html = SYNTHETIC_ABC_HTML.replace(old, `<td>${entry.original}</td><td>${entry.settlement}</td>`)
    expect(html).not.toBe(SYNTHETIC_ABC_HTML)
    await realLedger(page); await upload(page, html, 14)
    const before = await financialState(page), original = before.rows.find((tx: { rawDescription: string }) => tx.rawDescription === description)
    expect(original).toMatchObject({ transactionAmountMinor: entry.originalMinor, settlementAmountMinor: entry.settlementMinor,
      directionEvidence: { kind: 'bank' }, flags: expect.arrayContaining(['amount_direction_unclear']), reviewStatus: 'pending' })
    expect(before.summary.transactionCount).toBe(12)
    expect(before.detail.status).toBe('mismatch'); expect(before.total.status).toBe('mismatch')
    const unresolvedBytes = await exportNative(page)
    await page.goto('/#/review'); await page.getByRole('button', { name: /交易复核/ }).click()
    const row = page.getByTestId('review-table').locator('tbody tr').filter({ has: page.getByRole('checkbox', { name: `选择交易 ${original.id}`, exact: true }) })
    await expect(row.getByTestId('direction-review')).toContainText('银行方向：')
    await expect(row.getByTestId('direction-review')).toContainText('原始入账')
    await expect(row.getByRole('button', { name: '确认', exact: true })).toBeDisabled()
    await row.getByRole('button', { name: entry.credit ? '接受银行贷记方向' : '接受银行借记方向' }).click()
    await expect(row.getByTestId('direction-review')).toHaveCount(0)
    const after = await financialState(page), accepted = after.rows.find((tx: { id: string }) => tx.id === original.id)
    expect(accepted).toMatchObject({ id: original.id, fingerprint: original.fingerprint, occurrence: original.occurrence,
      transactionAmountMinor: entry.originalMinor, settlementAmountMinor: entry.settlementMinor, rawText: original.rawText,
      directionResolution: { method: 'accept_bank', direction: entry.credit ? 'credit' : 'debit' } })
    expect(accepted.flags).toEqual(original.flags.filter((flag: string) => flag !== 'amount_direction_unclear'))
    expect(after.summary).toEqual({ billingDebitMinor: 650000, billingCreditMinor: 720000, netMinor: -70000, transactionCount: 13 })
    expect(after.detail.status).toBe('passed'); expect(after.total.status).toBe('passed')
    expect(after.statement.reconciliation.status).toBe('passed')
    // Reviewing an unrelated remaining reason does not add a second posting.
    await row.getByRole('button', { name: '确认', exact: true }).click()
    await expect(row).toHaveCount(0)
    expect((await financialState(page)).summary).toEqual(after.summary)
    const resolvedBytes = await exportNative(page)
    for (const [bytes, resolved] of [[unresolvedBytes, false], [resolvedBytes, true]] as const) {
      const context = await browser.newContext()
      try {
        const restored = await context.newPage(); await restoreNative(restored, bytes, 14)
        const state = await financialState(restored), recovered = state.rows.find((tx: { id: string }) => tx.id === original.id)
        expect(recovered).toMatchObject({ id: original.id, fingerprint: original.fingerprint, occurrence: original.occurrence,
          transactionAmountMinor: entry.originalMinor, settlementAmountMinor: entry.settlementMinor, rawText: original.rawText,
          directionEvidence: original.directionEvidence })
        expect(state.summary).toEqual(resolved ? after.summary : before.summary)
        if (resolved) {
          expect(recovered).toMatchObject({ directionResolution: accepted.directionResolution, reviewStatus: 'confirmed', flags: [] })
          // Native XLSX intentionally has no statement balance; use the preserved bank summary to check BOTH engines.
          const checked = await restored.evaluate(async summary => {
            const dbUrl = '/src/db/db.ts', detailUrl = '/src/core/reconcile.ts', totalUrl = '/src/core/reconciliation.ts'
            const { db } = await import(dbUrl), { reconcileStatement } = await import(detailUrl), { reconcileStatementTransactions } = await import(totalUrl)
            const rows = await db.transactions.toArray(), statement = (await db.statements.toArray())[0]
            return [reconcileStatement({ summary, transactions: rows }).status, reconcileStatementTransactions({ ...statement, summary }, rows).status]
          }, after.statement.summary)
          expect(checked).toEqual(['passed', 'passed'])
        } else expect(recovered).toMatchObject({ flags: original.flags, reviewStatus: 'pending' })
        await restored.goto('/#/review'); await restored.getByRole('button', { name: /交易复核/ }).click()
        expect(await restored.getByTestId('review-table').locator('tbody tr').filter({ has: restored.getByRole('checkbox', { name: `选择交易 ${original.id}`, exact: true }) }).getByTestId('direction-review').count()).toBe(resolved ? 0 : 1)
      } finally { await context.close() }
    }
    await page.goto('/#/dashboard')
    await expect(page.locator('.stat').filter({ hasText: '账单入账净额' })).toContainText('-700.00')
  })
}

for (const choice of ['debit', 'credit'] as const) {
  test(`ICBC missing bank marker: ordinary confirmation blocked, explicit ${choice} survives native recovery`, async ({ page, browser }) => {
    const html = SYNTHETIC_ICBC_HTML.replace('3000.00/RMB(存入)', '3000.00/RMB')
    expect(html).not.toBe(SYNTHETIC_ICBC_HTML)
    await realLedger(page); await upload(page, html, 13)
    const before = await financialState(page), original = before.rows.find((tx: { rawDescription: string }) => tx.rawDescription === '手机银行还款转入')
    expect(original).toMatchObject({ directionEvidence: { kind: 'missing' }, direction: 'debit', reviewStatus: 'pending' })
    await page.goto('/#/transactions')
    await expect(page.locator('tbody')).toContainText('手机银行还款转入')
    for (const filter of ['debit', 'credit']) {
      await page.getByRole('combobox', { name: '借贷方向筛选' }).selectOption(filter)
      await expect(page.locator('tbody')).not.toContainText('手机银行还款转入')
    }
    await page.goto('/#/review'); await page.getByRole('button', { name: /交易复核/ }).click()
    const row = page.getByTestId('review-table').locator('tbody tr').filter({ hasText: '手机银行还款转入' })
    await expect(row.getByRole('button', { name: '确认', exact: true })).toBeDisabled()
    await expect(row.getByRole('button', { name: '按所选方向入账' })).toBeDisabled()
    await expect(row.getByRole('combobox', { name: '选择入账方向' })).toHaveValue('')
    const blocked = await page.evaluate(async id => {
      const url = '/src/db/repository.ts', { patchTransaction } = await import(url)
      try { await patchTransaction({ id, reviewStatus: 'confirmed', flags: [] }); return false } catch { return true }
    }, original.id)
    expect(blocked).toBe(true)
    expect((await financialState(page)).summary).toEqual(before.summary)
    await row.getByRole('combobox', { name: '选择入账方向' }).selectOption(choice)
    await expect(row.getByTestId('direction-review')).toContainText(choice === 'debit' ? '按借记正绝对值' : '按贷记负绝对值')
    await row.getByRole('button', { name: '按所选方向入账' }).click()
    await expect(row.getByTestId('direction-review')).toHaveCount(0)
    const after = await financialState(page), chosen = after.rows.find((tx: { id: string }) => tx.id === original.id)
    expect(chosen).toMatchObject({ direction: 'debit', transactionAmountMinor: original.transactionAmountMinor,
      settlementAmountMinor: original.settlementAmountMinor, directionResolution: { method: 'user_choice', direction: choice } })
    expect(after.summary.transactionCount).toBe(before.summary.transactionCount + 1)
    expect(after.summary.netMinor - before.summary.netMinor).toBe(choice === 'debit' ? 300000 : -300000)
    expect(after.detail.status).toBe(choice === 'credit' ? 'passed' : 'mismatch')
    expect(after.total.status).toBe(after.detail.status)
    const bytes = await exportNative(page), context = await browser.newContext()
    try {
      const restored = await context.newPage(); await restoreNative(restored, bytes, 13)
      const state = await financialState(restored)
      expect(state.summary).toEqual(after.summary)
      expect(state.rows.find((tx: { id: string }) => tx.id === original.id)).toMatchObject({ directionEvidence: original.directionEvidence,
        directionResolution: chosen.directionResolution, rawText: original.rawText, settlementAmountMinor: original.settlementAmountMinor })
      await restored.goto('/#/transactions'); await restored.getByRole('combobox', { name: '借贷方向筛选' }).selectOption(choice)
      await expect(restored.locator('tbody')).toContainText('手机银行还款转入')
    } finally { await context.close() }
  })
}

test('explicit user direction survives JSON V1/V2 and full ZIP restores in fresh Chromium contexts', async ({ page, browser }) => {
  await realLedger(page)
  const id = await page.evaluate(async () => {
    const ingestUrl = '/src/core/ingest.ts', typesUrl = '/src/parsers/types.ts', repoUrl = '/src/db/repository.ts'
    const { ingestParsedStatement } = await import(ingestUrl), { emptySummary } = await import(typesUrl), { persistImportResults } = await import(repoUrl)
    const result = ingestParsedStatement({ bank: 'icbc', cardLast4: '1234', cycleStart: '2024-01-01', cycleEnd: '2024-01-31', dueDate: null,
      summary: emptySummary(), confidence: 1, parserId: 'synthetic', parserVersion: '1', warnings: [], transactions: [{
        cardLast4: '1234', transactionDate: '2024-01-05', postingDate: '2024-01-06', description: '合成未知方向', rawDescription: '合成未知方向',
        transactionCurrency: 'CNY', transactionAmountMinor: 12880, settlementCurrency: 'CNY', settlementAmountMinor: 12880,
        type: 'payment', direction: 'debit', directionEvidence: { kind: 'missing', detail: '合成金额缺少方向标记' }, amountDirectionUnclear: true,
        bankToken: '', confidence: 1, sourcePage: null, sourceRow: 1, rawText: '128.80/RMB | 合成未知方向',
      }] }, { fileName: 'synthetic.html', fileHash: 'synthetic-backup-direction', fileSize: 1, sourceType: 'html' }, { statements: [], transactions: [], imports: [] })
    result.statement.status = 'imported'; result.transactions[0].flags = ['amount_direction_unclear']
    await persistImportResults([result]); return result.transactions[0].id
  })
  await page.goto('/#/review'); await page.reload(); await page.getByRole('button', { name: /交易复核/ }).click()
  await page.getByRole('combobox', { name: '选择入账方向' }).selectOption('credit')
  await page.getByRole('button', { name: '按所选方向入账' }).click()
  await expect(page.getByTestId('direction-review')).toHaveCount(0)
  const backup = await page.evaluate(async () => {
    const repoUrl = '/src/db/repository.ts', zipUrl = '/src/backup/archive.ts'
    const { exportDataBackup } = await import(repoUrl), { buildFullBackupZip } = await import(zipUrl)
    return { payload: await exportDataBackup(), bytes: [...new Uint8Array(await (await buildFullBackupZip()).blob.arrayBuffer())] }
  })
  for (const format of ['V1', 'V2', 'ZIP']) {
    const context = await browser.newContext()
    try {
      const restored = await context.newPage(); await realLedger(restored)
      await restored.evaluate(async ({ backup, format }) => {
        const repoUrl = '/src/db/repository.ts', zipUrl = '/src/backup/archive.ts'
        if (format === 'ZIP') { const { restoreFullBackupZip } = await import(zipUrl); await restoreFullBackupZip(new Blob([new Uint8Array(backup.bytes)])); return }
        const { importBackup } = await import(repoUrl), payload = structuredClone(backup.payload)
        if (format === 'V1') { payload.version = 1; delete payload.reviewNotes }
        await importBackup(payload); await importBackup(payload)
      }, { backup, format })
      const state = await financialState(restored), tx = state.rows.find((tx: { id: string }) => tx.id === id)
      expect(state.rows).toHaveLength(1)
      expect(state.summary).toEqual({ billingDebitMinor: 0, billingCreditMinor: 12880, netMinor: -12880, transactionCount: 1 })
      expect(tx).toMatchObject({ direction: 'debit', directionEvidence: { kind: 'missing' }, directionResolution: { method: 'user_choice', direction: 'credit' },
        transactionAmountMinor: 12880, settlementAmountMinor: 12880, rawText: '128.80/RMB | 合成未知方向', flags: [], reviewStatus: 'confirmed' })
      await restored.goto('/#/review'); await restored.reload(); await restored.getByRole('button', { name: /交易复核/ }).click()
      await expect(restored.getByTestId('direction-review')).toHaveCount(0)
    } finally { await context.close() }
  }
})
