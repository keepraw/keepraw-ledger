import { fireEvent, render, screen, within } from '@testing-library/react'
import JSZip from 'jszip'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AppProvider, useApp } from '../src/app/AppStore'
import { DATABASE_JSON, buildFullBackupZip, restoreFullBackupZip } from '../src/backup/archive'
import { readArchiveBytes } from '../src/backup/zipSafety'
import { groupBy, groupByBank, monthlyTrend, summarize } from '../src/core/analytics'
import {
  applyBulkReviewDecision,
  applyReviewPatch,
  effectiveAmountForDirection,
  effectiveCurrencyForDirection,
  effectiveDirection,
  hasResolvedDirection,
  hasUnresolvedDirection,
  isPostedTransaction,
  validDirectionMetadata,
} from '../src/core/direction'
import { formatMinor } from '../src/core/money'
import { reconcileStatement } from '../src/core/reconcile'
import { reconcileManyStatements, reconcileStatementTransactions } from '../src/core/reconciliation'
import type { Transaction } from '../src/core/types'
import { db } from '../src/db/db'
import { readLedgerRevision } from '../src/db/ledgerRevision'
import {
  exportDataBackup,
  importBackup,
  patchTransaction,
  readSnapshot,
  reviewTransactions,
} from '../src/db/repository'
import * as demoStore from '../src/demo/demoStore'
import { EXPORT_COLUMNS, transactionToRow } from '../src/export/tabular'
import { planLegacyImport, previewLegacyWorkbook } from '../src/importers/legacyImport'
import { DashboardPage } from '../src/ui/pages/DashboardPage'
import { ReconciliationPage } from '../src/ui/pages/ReconciliationPage'
import { ReviewPage } from '../src/ui/pages/ReviewPage'
import { EMPTY_SNAPSHOT } from './fixtures/identity'
import { nativeTransaction, nativeWorkbook } from './fixtures/nativeLedger'
import { mixedDirectionReviewBatchFixture } from './fixtures/reviewBatch'

beforeEach(async () => {
  vi.restoreAllMocks()
  await db.delete()
  await db.open()
})

const IMMUTABLE_RAW_KEYS = [
  'id',
  'statementId',
  'bank',
  'cardLast4',
  'transactionDate',
  'postingDate',
  'description',
  'rawDescription',
  'transactionCurrency',
  'transactionAmountMinor',
  'settlementCurrency',
  'settlementAmountMinor',
  'type',
  'direction',
  'directionEvidence',
  'bankColumnAmounts',
  'postingExclusion',
  'category',
  'confidence',
  'sourceFileName',
  'sourceFileHash',
  'sourcePage',
  'sourceRow',
  'rawText',
  'fingerprint',
  'occurrence',
  'isDemo',
  'origin',
  'sourceId',
] as const

function expectImmutableRawFields(before: Transaction, after: Transaction) {
  for (const key of IMMUTABLE_RAW_KEYS) {
    expect(after[key]).toEqual(before[key])
  }
}

describe('applyBulkReviewDecision: direction acceptance and immutability rules', () => {
  it('1 & 2. confirms ordinary positive debits and ordinary negative credits without unnecessary directionResolution', () => {
    const debit = nativeTransaction(1, {
      transactionCurrency: 'CNY', settlementCurrency: 'CNY',
      transactionAmountMinor: 12880, settlementAmountMinor: 12880,
      direction: 'debit', directionEvidence: { kind: 'bank', detail: '合成借记列' },
      flags: ['uncategorized', 'low_confidence'], reviewStatus: 'pending',
    })
    const credit = nativeTransaction(2, {
      transactionCurrency: 'CNY', settlementCurrency: 'CNY',
      transactionAmountMinor: -300000, settlementAmountMinor: -300000,
      type: 'payment', direction: 'credit', directionEvidence: { kind: 'bank', detail: '合成贷记列' },
      flags: ['suspected_duplicate'], reviewStatus: 'pending',
    })
    const confirmedDebit = applyBulkReviewDecision(debit, 'confirmed')
    const confirmedCredit = applyBulkReviewDecision(credit, 'confirmed')

    expectImmutableRawFields(debit, confirmedDebit)
    expectImmutableRawFields(credit, confirmedCredit)
    expect(confirmedDebit).toMatchObject({ reviewStatus: 'confirmed', flags: [] })
    expect(confirmedDebit.directionResolution).toBeUndefined()
    expect(effectiveAmountForDirection(confirmedDebit)).toBe(12880)

    expect(confirmedCredit).toMatchObject({ reviewStatus: 'confirmed', flags: [] })
    expect(confirmedCredit.directionResolution).toBeUndefined()
    expect(effectiveAmountForDirection(confirmedCredit)).toBe(-300000)
  })

  it.each(['debit', 'credit'] as const)(
    '3. bank-evidenced %s with sign conflict records accept_bank while keeping raw amounts unchanged',
    direction => {
      const row = nativeTransaction(1, {
        transactionCurrency: 'USD', settlementCurrency: 'CNY',
        transactionAmountMinor: direction === 'debit' ? -2000 : 2000,
        settlementAmountMinor: direction === 'debit' ? -14500 : 14500,
        direction,
        directionEvidence: { kind: 'bank', detail: '合成银行账单分区' },
        flags: ['amount_direction_unclear', 'statement_mismatch'],
        reviewStatus: 'pending',
      })
      // Single-row confirmation still blocks without explicit directionResolution.
      expect(() => applyReviewPatch(row, { reviewStatus: 'confirmed', flags: [] })).toThrow(/方向/)

      const confirmed = applyBulkReviewDecision(row, 'confirmed')
      expectImmutableRawFields(row, confirmed)
      expect(confirmed.directionResolution).toEqual({ method: 'accept_bank', direction })
      expect(confirmed.flags).toEqual([])
      expect(confirmed.reviewStatus).toBe('confirmed')
      expect(hasUnresolvedDirection(confirmed)).toBe(false)
      const sign = direction === 'debit' ? 1 : -1
      expect(effectiveDirection(confirmed)).toBe(direction)
      expect(effectiveAmountForDirection(confirmed)).toBe(14500 * sign)
      expect(effectiveAmountForDirection(confirmed, 'transaction')).toBe(2000 * sign)
    },
  )

  it.each([
    ['undefined evidence, debit', undefined, 'debit', -1800, 1800, 'pending', 1800],
    ['undefined evidence, credit (migrated confirmed)', undefined, 'credit', 1800, -1800, 'confirmed', -1800],
    ['missing evidence, debit', { kind: 'missing' as const, detail: '合成缺少借贷标记' }, 'debit', 300000, 300000, 'pending', 300000],
    ['missing evidence, credit', { kind: 'missing' as const, detail: '合成缺少借贷标记' }, 'credit', 300000, 300000, 'pending', -300000],
  ] as const)(
    '4. historical/missing-evidence row (%s) records user_choice with stored direction',
    (_label, evidence, direction, txMinor, settleMinor, status, expectedEffective) => {
      const row = nativeTransaction(1, {
        transactionCurrency: 'CNY', settlementCurrency: 'CNY',
        transactionAmountMinor: txMinor, settlementAmountMinor: settleMinor,
        direction, directionEvidence: evidence,
        flags: ['amount_direction_unclear', 'suspected_duplicate'],
        reviewStatus: status,
      })
      expect(() => applyReviewPatch(row, { reviewStatus: 'confirmed', flags: [] })).toThrow(/方向/)

      const confirmed = applyBulkReviewDecision(row, 'confirmed')
      expectImmutableRawFields(row, confirmed)
      expect(confirmed.directionResolution).toEqual({ method: 'user_choice', direction })
      expect(confirmed.flags).toEqual([])
      expect(confirmed.reviewStatus).toBe('confirmed')
      expect(hasUnresolvedDirection(confirmed)).toBe(false)
      expect(effectiveAmountForDirection(confirmed)).toBe(expectedEffective)
    },
  )

  it('preserves a prior explicit human direction choice when confirming remaining flags like suspected_duplicate', () => {
    const priorResolved = nativeTransaction(1, {
      transactionCurrency: 'CNY', settlementCurrency: 'CNY',
      transactionAmountMinor: 300000, settlementAmountMinor: 300000,
      direction: 'debit',
      directionEvidence: { kind: 'missing', detail: '合成缺少方向标记' },
      directionResolution: { method: 'user_choice', direction: 'credit' },
      flags: ['suspected_duplicate'],
      reviewStatus: 'pending',
    })
    expect(hasResolvedDirection(priorResolved)).toBe(true)
    expect(hasUnresolvedDirection(priorResolved)).toBe(false)

    const confirmed = applyBulkReviewDecision(priorResolved, 'confirmed')
    expectImmutableRawFields(priorResolved, confirmed)
    expect(confirmed.directionResolution).toEqual({ method: 'user_choice', direction: 'credit' })
    expect(confirmed.flags).toEqual([])
    expect(confirmed.reviewStatus).toBe('confirmed')
    expect(effectiveDirection(confirmed)).toBe('credit')
    expect(effectiveAmountForDirection(confirmed)).toBe(-300000)
  })

  it.each([
    ['debit', 'debit_column', 15200, 'USD'],
    ['credit', 'credit_column', -1234, 'HKD'],
  ] as const)(
    '5 & 6. BOC dual-column %s selects %s and clears both amount_direction_unclear and suspected_duplicate',
    (direction, expectedSource, expectedAmount, expectedCurrency) => {
      const row = nativeTransaction(1, {
        bank: 'boc', cardLast4: '0012',
        direction,
        transactionCurrency: 'CNY', transactionAmountMinor: 15200,
        settlementCurrency: 'CNY', settlementAmountMinor: 15200,
        rawText: '2024-01-05 | 0012 | Synthetic BOC | 152.00 | 12.34',
        directionEvidence: { kind: 'missing', detail: '中国银行同一行同时出现借记和贷记金额列，无法确定唯一方向' },
        bankColumnAmounts: {
          source: 'boc_pdf',
          rowBinding: 'single_transaction_anchor',
          debit: { direction: 'debit', rawText: '152.00', amountMinor: 15200, currency: 'USD' },
          credit: { direction: 'credit', rawText: '12.34', amountMinor: 1234, currency: 'HKD' },
        },
        flags: ['amount_direction_unclear', 'suspected_duplicate'],
        reviewStatus: 'pending',
      })
      expect(() => applyReviewPatch(row, { reviewStatus: 'confirmed', flags: [] })).toThrow(/方向/)

      const confirmed = applyBulkReviewDecision(row, 'confirmed')
      expectImmutableRawFields(row, confirmed)
      expect(confirmed.directionResolution).toEqual({
        method: 'user_choice',
        direction,
        amountSource: expectedSource,
      })
      expect(confirmed.flags).toEqual([])
      expect(confirmed.reviewStatus).toBe('confirmed')
      expect(validDirectionMetadata(confirmed)).toBe(true)
      expect(effectiveAmountForDirection(confirmed)).toBe(expectedAmount)
      expect(effectiveCurrencyForDirection(confirmed)).toBe(expectedCurrency)
    },
  )

  it('reports structural direction/column errors explicitly instead of guessing', () => {
    const oldBocWithoutColumns = nativeTransaction(1, {
      bank: 'boc', direction: 'debit',
      transactionCurrency: 'CNY', transactionAmountMinor: 15200,
      settlementCurrency: 'CNY', settlementAmountMinor: 15200,
      directionEvidence: { kind: 'missing', detail: '中国银行同一行同时出现借记和贷记金额列，无法确定唯一方向' },
      flags: ['amount_direction_unclear'], reviewStatus: 'pending',
    })
    expect(() => applyBulkReviewDecision(oldBocWithoutColumns, 'confirmed')).toThrow(/双列金额来源证据/)

    const invalidDirection = { ...nativeTransaction(2, { flags: ['uncategorized'], reviewStatus: 'pending' }), direction: '' as Transaction['direction'] }
    expect(() => applyBulkReviewDecision(invalidDirection, 'confirmed')).toThrow(/缺少有效的借贷方向/)

    const corruptedMetadata = nativeTransaction(3, {
      bank: 'boc', direction: 'debit',
      directionEvidence: { kind: 'bank', detail: '合成借记列' },
      directionResolution: { method: 'accept_bank', direction: 'credit' },
      flags: ['amount_direction_unclear'], reviewStatus: 'pending',
    })
    expect(() => applyBulkReviewDecision(corruptedMetadata, 'confirmed')).toThrow(/数据结构无效/)
  })
})

describe('946-transaction realistic batch confirmation, reconciliation, rollback and Demo isolation', () => {
  it('7, 8 & 11. confirms all 946 mixed-direction transactions in one click, reconciles both engines without double-posting, and survives JSON/ZIP/XLSX round-trips', async () => {
    const fixture = mixedDirectionReviewBatchFixture(946)
    await db.settings.put({ key: 'app', value: { theme: 'system', demoMode: false, locale: 'zh-CN' } })
    await db.statements.bulkAdd(fixture.statements)
    await db.transactions.bulkAdd(fixture.transactions)
    await db.imports.bulkAdd(fixture.imports)
    await db.reviewNotes.bulkAdd(fixture.notes)

    // Before confirmation: both statements have unresolved direction conflicts -> mismatch / needs_review.
    expect(fixture.statements.every(s => s.status === 'needs_review' && s.reconciliation.status === 'mismatch')).toBe(true)
    const beforeSnapshot = await readSnapshot()
    const beforeNotes = await db.reviewNotes.toArray()
    const beforeRevision = await readLedgerRevision()

    function Harness() {
      return (
        <div>
          <ReviewPage />
          <ReconciliationPage />
          <DashboardPage />
        </div>
      )
    }
    render(
      <AppProvider>
        <Harness />
      </AppProvider>,
    )

    const txTab = await screen.findByRole('button', { name: '交易复核 946' })
    expect(screen.getByRole('button', { name: '账单对账 2' })).toBeInTheDocument()
    expect(screen.getByTestId('recon-mismatch')).toHaveTextContent('2')

    fireEvent.click(txTab)
    const pagination = screen.getByRole('navigation', { name: '交易复核分页' })
    expect(pagination).toHaveTextContent('1–100 / 946')

    // Single-row confirm button remains disabled on rows with unresolved direction.
    const unresolvedTr = screen.getAllByTestId('direction-review')[0]!.closest('tr')!
    const unresolvedId = (unresolvedTr.querySelector('input[type="checkbox"]') as HTMLInputElement).value
    expect(within(unresolvedTr).getByRole('button', { name: '确认' })).toBeDisabled()
    await expect(patchTransaction({ id: unresolvedId, reviewStatus: 'confirmed', flags: [] })).rejects.toThrow(/方向/)

    // Cross-page selection check, then select all 946 pending transactions.
    fireEvent.click(screen.getByRole('checkbox', { name: '全选当前页' }))
    expect(screen.getByTestId('review-selection-count')).toHaveTextContent('已选择 100 笔')
    fireEvent.click(within(pagination).getByRole('button', { name: '末页' }))
    expect(pagination).toHaveTextContent('901–946 / 946')
    expect(screen.getByTestId('review-selection-count')).toHaveTextContent('已选择 100 笔')

    fireEvent.click(screen.getByRole('button', { name: '全选全部待复核 946 笔' }))
    expect(screen.getByTestId('review-selection-count')).toHaveTextContent('已选择 946 笔')

    fireEvent.click(screen.getByRole('button', { name: '批量确认' }))
    const dialog = screen.getByRole('dialog', { name: '批量确认交易' })
    expect(dialog).toHaveTextContent('确定批量确认 946 笔交易吗？')
    expect(dialog).toHaveTextContent('确认后将接受所选交易当前已有的借贷方向，并清除所选交易的复核标记。交易原始金额和银行来源证据不会改变。')
    expect(dialog).not.toHaveTextContent('方向问题必须先逐笔明确解决。')
    expect(dialog).toHaveTextContent('清除疑似重复标记')

    fireEvent.click(within(dialog).getByRole('button', { name: '确定批量确认' }))

    await vi.waitFor(() => expect(dialog).not.toBeInTheDocument())
    expect(screen.getByRole('button', { name: '交易复核 0' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '账单对账 0' })).toBeInTheDocument()
    expect(screen.getByTestId('recon-passed')).toHaveTextContent('2')
    expect(screen.getByTestId('recon-mismatch')).toHaveTextContent('0')

    // Dashboard displays exact expected totals (no double-counting, no excluded-statement omission).
    expect(screen.getByText('借记总额').closest('.stat')).toHaveTextContent(`¥${formatMinor(fixture.expectedTotals.billingDebitMinor)}`)
    expect(screen.getByText('贷记总额').closest('.stat')).toHaveTextContent(`¥${formatMinor(fixture.expectedTotals.billingCreditMinor)}`)
    expect(screen.getByText('账单入账净额').closest('.stat')).toHaveTextContent(`¥${formatMinor(fixture.expectedTotals.netMinor)}`)
    expect(screen.getByText('交易笔数').closest('.stat')).toHaveTextContent(String(fixture.expectedTotals.transactionCount))
    expect(screen.queryByTestId('duplicate-summary-warning')).not.toBeInTheDocument()

    // Verify durable IndexedDB state, raw-field immutability, no duplicate rows, single revision bump.
    const afterSnapshot = await readSnapshot()
    expect(afterSnapshot.transactions).toHaveLength(beforeSnapshot.transactions.length)
    expect(afterSnapshot.imports).toEqual(beforeSnapshot.imports)
    expect(await db.reviewNotes.toArray()).toEqual(beforeNotes)
    expect((await readLedgerRevision()).version).toBe(beforeRevision.version + 1)

    const beforeById = new Map(beforeSnapshot.transactions.map(tx => [tx.id, tx]))
    const pendingSet = new Set(fixture.pendingIds)
    for (const afterTx of afterSnapshot.transactions) {
      const beforeTx = beforeById.get(afterTx.id)!
      expectImmutableRawFields(beforeTx, afterTx)
      if (!pendingSet.has(afterTx.id)) {
        expect(afterTx).toEqual(beforeTx)
        continue
      }
      expect(afterTx.reviewStatus).toBe('confirmed')
      expect(afterTx.flags).toEqual([])
      expect(hasUnresolvedDirection(afterTx)).toBe(false)
      expect(validDirectionMetadata(afterTx)).toBe(true)
      if (hasUnresolvedDirection(beforeTx)) {
        if (beforeTx.bankColumnAmounts) {
          expect(afterTx.directionResolution).toEqual({
            method: 'user_choice',
            direction: beforeTx.direction,
            amountSource: beforeTx.direction === 'debit' ? 'debit_column' : 'credit_column',
          })
        } else if (beforeTx.directionEvidence?.kind === 'bank') {
          expect(afterTx.directionResolution).toEqual({ method: 'accept_bank', direction: beforeTx.direction })
        } else {
          expect(afterTx.directionResolution).toEqual({ method: 'user_choice', direction: beforeTx.direction })
        }
      } else {
        expect(afterTx.directionResolution).toBeUndefined()
      }
    }

    // Installment original with postingExclusion remains unposted after confirmation (no double entry).
    const excludedInstallment = afterSnapshot.transactions.find(tx => tx.postingExclusion)!
    expect(excludedInstallment.reviewStatus).toBe('confirmed')
    expect(isPostedTransaction(excludedInstallment)).toBe(false)

    // Analytics & BOTH reconciliation engines agree across the entire ledger.
    expect(summarize(afterSnapshot.transactions)).toEqual(fixture.expectedTotals)
    const trend = monthlyTrend(afterSnapshot.transactions)
    expect(trend).toHaveLength(2)
    expect(trend.reduce((sum, m) => sum + m.debit, 0)).toBe(fixture.expectedTotals.billingDebitMinor)
    expect(trend.reduce((sum, m) => sum + m.credit, 0)).toBe(fixture.expectedTotals.billingCreditMinor)
    expect(groupByBank(afterSnapshot.transactions).reduce((sum, b) => sum + b.value, 0)).toBe(fixture.expectedTotals.billingDebitMinor)
    expect(groupBy(afterSnapshot.transactions, tx => tx.cardLast4).reduce((sum, c) => sum + c.value, 0)).toBe(fixture.expectedTotals.billingDebitMinor)

    const manyRecon = reconcileManyStatements(afterSnapshot.statements, afterSnapshot.transactions)
    for (const stmt of afterSnapshot.statements) {
      expect(stmt.status).toBe('reconciled')
      expect(stmt.reconciliation.status).toBe('passed')
      expect(reconcileStatement({ summary: stmt.summary, transactions: afterSnapshot.transactions.filter(tx => tx.statementId === stmt.id) }).status).toBe('passed')
      expect(reconcileStatementTransactions(stmt, afterSnapshot.transactions).status).toBe('passed')
      expect(manyRecon.get(stmt.id)?.status).toBe('passed')
    }

    // JSON V2, Full ZIP, and 27-column native XLSX round-trips preserve all 946 decisions and totals.
    const backup = await exportDataBackup()
    const zipBlob = (await buildFullBackupZip()).blob
    const zipContainer = await JSZip.loadAsync(await readArchiveBytes(zipBlob))
    expect(JSON.parse(await zipContainer.file(DATABASE_JSON)!.async('string')).transactions).toHaveLength(fixture.transactions.length)

    await db.delete()
    await db.open()
    await importBackup(backup)
    expect(summarize(await db.transactions.toArray())).toEqual(fixture.expectedTotals)

    await db.delete()
    await db.open()
    await restoreFullBackupZip(zipBlob)
    expect(summarize(await db.transactions.toArray())).toEqual(fixture.expectedTotals)

    const xlsxBytes = nativeWorkbook(afterSnapshot.transactions.map(transactionToRow), EXPORT_COLUMNS.map(c => c.header))
    const preview = await previewLegacyWorkbook(xlsxBytes, { fileName: 'synthetic-946.xlsx', fileHash: 'hash-946', fileSize: xlsxBytes.byteLength }, EMPTY_SNAPSHOT)
    expect(preview.anomalies).toEqual([])
    const recovered = planLegacyImport(preview, EMPTY_SNAPSHOT).inserted
    expect(recovered).toHaveLength(fixture.transactions.length)
    expect(summarize(recovered)).toEqual(fixture.expectedTotals)
  }, 30_000)

  it('9. rolls back the entire batch and reports clearly when one row lacks dual-column amount evidence', async () => {
    const fixture = mixedDirectionReviewBatchFixture(20)
    const unbindableBoc = nativeTransaction(999, {
      statementId: fixture.statements[0]!.id,
      bank: 'boc', cardLast4: '0012', direction: 'debit',
      transactionCurrency: 'CNY', transactionAmountMinor: 15200,
      settlementCurrency: 'CNY', settlementAmountMinor: 15200,
      directionEvidence: { kind: 'missing', detail: '中国银行同一行同时出现借记和贷记金额列，无法确定唯一方向' },
      flags: ['amount_direction_unclear'], reviewStatus: 'pending',
    })
    await db.settings.put({ key: 'app', value: { theme: 'system', demoMode: false, locale: 'zh-CN' } })
    await db.statements.bulkAdd(fixture.statements)
    await db.transactions.bulkAdd([...fixture.transactions, unbindableBoc])
    await db.imports.bulkAdd(fixture.imports)
    await db.reviewNotes.bulkAdd(fixture.notes)

    const before = await readSnapshot()
    const beforeRevision = await readLedgerRevision()

    await expect(reviewTransactions([...fixture.pendingIds, unbindableBoc.id], 'confirmed')).rejects.toThrow(/双列金额来源证据/)
    expect(await readSnapshot()).toEqual(before)
    expect(await readLedgerRevision()).toEqual(beforeRevision)
  })

  it('10. Demo Mode bulk confirmation accepts direction in memory with identical rules and never touches real IndexedDB', async () => {
    const realFixture = mixedDirectionReviewBatchFixture(10)
    await db.settings.put({ key: 'app', value: { theme: 'system', demoMode: true, locale: 'zh-CN' } })
    await db.statements.bulkAdd(realFixture.statements)
    await db.transactions.bulkAdd(realFixture.transactions)
    await db.imports.bulkAdd(realFixture.imports)
    await db.reviewNotes.bulkAdd(realFixture.notes)

    const realBefore = await readSnapshot()
    const realNotesBefore = await db.reviewNotes.toArray()
    const revisionBefore = await readLedgerRevision()

    let capturedApi!: ReturnType<typeof useApp>
    function Probe() {
      capturedApi = useApp()
      return <ReviewPage />
    }
    render(
      <AppProvider>
        <Probe />
      </AppProvider>,
    )

    await vi.waitFor(() => expect(capturedApi.state.ready).toBe(true))
    const demoPending = capturedApi.visibleTransactions.filter(
      tx => tx.reviewStatus !== 'rejected' && (tx.reviewStatus === 'pending' || tx.flags.length > 0 || hasUnresolvedDirection(tx)),
    )
    expect(demoPending.length).toBeGreaterThan(0)

    fireEvent.click(await screen.findByRole('button', { name: `交易复核 ${demoPending.length}` }))
    fireEvent.click(screen.getByRole('button', { name: `全选全部待复核 ${demoPending.length} 笔` }))
    fireEvent.click(screen.getByRole('button', { name: '批量确认' }))
    const dialog = screen.getByRole('dialog', { name: '批量确认交易' })
    expect(dialog).toHaveTextContent('确认后将接受所选交易当前已有的借贷方向，并清除所选交易的复核标记。交易原始金额和银行来源证据不会改变。')
    fireEvent.click(within(dialog).getByRole('button', { name: '确定批量确认' }))

    await vi.waitFor(() => expect(screen.getByRole('button', { name: '交易复核 0' })).toBeInTheDocument())
    for (const id of demoPending.map(tx => tx.id)) {
      const demoRow = capturedApi.visibleTransactions.find(tx => tx.id === id)!
      expect(demoRow.reviewStatus).toBe('confirmed')
      expect(demoRow.flags).toEqual([])
      expect(hasUnresolvedDirection(demoRow)).toBe(false)
    }

    // Real IndexedDB records, notes, imports and revision are 100% untouched.
    expect(await readSnapshot()).toEqual(realBefore)
    expect(await db.reviewNotes.toArray()).toEqual(realNotesBefore)
    expect(await readLedgerRevision()).toEqual(revisionBefore)
  })

  it('10b. Demo Mode with mixed unresolved-direction demo rows produces identical directionResolution and statement reconciliation as Real Mode', async () => {
    const baseFixture = mixedDirectionReviewBatchFixture(20)
    const demoFixture = {
      statements: baseFixture.statements.map(s => ({ ...s, isDemo: true })),
      transactions: baseFixture.transactions.map(t => ({ ...t, isDemo: true })),
      imports: baseFixture.imports.map(i => ({ ...i, isDemo: true })),
    }
    vi.spyOn(demoStore, 'createDemoSnapshot').mockReturnValue(demoFixture)

    const realFixture = mixedDirectionReviewBatchFixture(10)
    await db.settings.put({ key: 'app', value: { theme: 'system', demoMode: true, locale: 'zh-CN' } })
    await db.statements.bulkAdd(realFixture.statements)
    await db.transactions.bulkAdd(realFixture.transactions)
    await db.imports.bulkAdd(realFixture.imports)
    const realBefore = await readSnapshot()
    const revisionBefore = await readLedgerRevision()

    let capturedApi!: ReturnType<typeof useApp>
    function Probe() {
      capturedApi = useApp()
      return <ReviewPage />
    }
    render(
      <AppProvider>
        <Probe />
      </AppProvider>,
    )

    fireEvent.click(await screen.findByRole('button', { name: '交易复核 20' }))
    fireEvent.click(screen.getByRole('button', { name: '全选全部待复核 20 笔' }))
    fireEvent.click(screen.getByRole('button', { name: '批量确认' }))
    fireEvent.click(within(screen.getByRole('dialog', { name: '批量确认交易' })).getByRole('button', { name: '确定批量确认' }))

    await vi.waitFor(() => expect(screen.getByRole('button', { name: '交易复核 0' })).toBeInTheDocument())
    expect(screen.getByRole('button', { name: '账单对账 0' })).toBeInTheDocument()

    expect(summarize(capturedApi.visibleTransactions)).toEqual(baseFixture.expectedTotals)
    expect(capturedApi.visibleStatements.every(s => s.status === 'reconciled' && s.reconciliation.status === 'passed')).toBe(true)
    expect(capturedApi.visibleTransactions.some(tx => tx.directionResolution?.method === 'accept_bank')).toBe(true)
    expect(capturedApi.visibleTransactions.some(tx => tx.directionResolution?.amountSource === 'debit_column')).toBe(true)
    expect(capturedApi.visibleTransactions.some(tx => tx.directionResolution?.amountSource === 'credit_column')).toBe(true)

    expect(await readSnapshot()).toEqual(realBefore)
    expect(await readLedgerRevision()).toEqual(revisionBefore)
  })
})
