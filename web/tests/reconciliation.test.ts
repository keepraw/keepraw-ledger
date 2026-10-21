import { describe, expect, it } from 'vitest'
import {
  createReconciliationCache,
  getStatementExpectedTotal,
  groupTransactionsByStatement,
  reconcileManyStatements,
  reconcileStatementTransactions,
  toReconciliationResult,
} from '../src/core/reconciliation'
import { buildDataQualityReport } from '../src/core/dataQuality'
import { emptySummary } from '../src/parsers/types'
import type { Statement, StatementSummary, Transaction } from '../src/core/types'

let seq = 0

function summaryWith(overrides: Partial<StatementSummary>): StatementSummary {
  return { ...emptySummary(), ...overrides }
}

function makeStatement(id: string, summary: StatementSummary): Statement {
  return {
    id,
    statementKey: id,
    bank: 'boc',
    cardLast4: '1234',
    cycleStart: '2024-01-01',
    cycleEnd: '2024-01-31',
    dueDate: null,
    summary,
    reconciliation: { status: 'passed', checks: [], computedBalanceMinor: null },
    status: 'imported',
    parserId: 'boc_pdf',
    parserVersion: '1.0.0',
    transactionCount: 0,
    sourceFileName: 'bill.pdf',
    sourceFileHash: `hash-${id}`,
    importedAt: new Date().toISOString(),
    isDemo: false,
  }
}

function makeTx(statementId: string, amountMinor: number, overrides: Partial<Transaction> = {}): Transaction {
  seq += 1
  const direction = amountMinor < 0 ? 'credit' : 'debit'
  return {
    id: `tx-${statementId}-${seq}`,
    statementId,
    bank: 'boc',
    cardLast4: '1234',
    transactionDate: '2024-01-05',
    postingDate: '2024-01-06',
    description: '消费 示例商户',
    rawDescription: '消费 示例商户',
    transactionCurrency: 'CNY',
    transactionAmountMinor: amountMinor,
    settlementCurrency: 'CNY',
    settlementAmountMinor: amountMinor,
    type: direction === 'debit' ? 'purchase' : 'payment',
    direction,
    category: '未分类',
    confidence: 0.95,
    flags: [],
    reviewStatus: 'ok',
    sourceFileName: 'bill.pdf',
    sourceFileHash: `hash-${seq}`,
    sourcePage: 1,
    sourceRow: seq,
    rawText: 'raw',
    fingerprint: `fp-${seq}`,
    occurrence: 1,
    isDemo: false,
    ...overrides,
  }
}

describe('reconciliation pure function', () => {
  it('reports passed when amounts match (detail source)', () => {
    const statement = makeStatement(
      'stmt-passed',
      summaryWith({
        newDebitMinor: 30000,
        newCreditMinor: 10000,
        chargeMinor: 0,
        interestMinor: 0,
        components: [{ label: '本期新增支出', minor: 30000, currency: 'CNY' }],
      }),
    )
    // Net bank movement: 30000 - 10000 = 20000.
    const txs = [makeTx('stmt-passed', 15000), makeTx('stmt-passed', 15000), makeTx('stmt-passed', -10000)]
    const before = JSON.stringify({ statement, txs })

    const result = reconcileStatementTransactions(statement, txs)

    expect(result.status).toBe('passed')
    expect(result.transactionCount).toBe(3)
    expect(result.transactionTotalMinor).toBe(20000)
    expect(result.expectedTotalMinor).toBe(20000)
    expect(result.differenceMinor).toBe(0)
    expect(result.bankTotalAvailable).toBe(true)
    // Pure: inputs untouched.
    expect(JSON.stringify({ statement, txs })).toBe(before)
  })

  it('reports mismatch when amounts differ', () => {
    const statement = makeStatement(
      'stmt-mismatch',
      summaryWith({
        newDebitMinor: 30000,
        newCreditMinor: 5000,
        components: [{ label: '本期新增支出', minor: 30000, currency: 'CNY' }],
      }),
    )
    const txs = [makeTx('stmt-mismatch', 10000), makeTx('stmt-mismatch', 5000)]
    const result = reconcileStatementTransactions(statement, txs)

    expect(result.status).toBe('mismatch')
    expect(result.transactionTotalMinor).toBe(15000)
    expect(result.expectedTotalMinor).toBe(25000)
    expect(result.differenceMinor).toBe(10000)
    expect(result.reason).toContain('差额')
  })

  it('reports insufficient when the bank total is missing (never faked)', () => {
    const statement = makeStatement('stmt-missing', emptySummary())
    const txs = [makeTx('stmt-missing', 10000)]
    const result = reconcileStatementTransactions(statement, txs)

    expect(result.status).toBe('insufficient')
    expect(result.expectedTotalMinor).toBeNull()
    expect(result.differenceMinor).toBeNull()
    expect(result.bankTotalAvailable).toBe(false)
    expect(result.reason).toContain('缺少')
  })

  it('falls back to the balance source when detail is absent', () => {
    const statement = makeStatement(
      'stmt-balance',
      summaryWith({ previousBalanceMinor: 50000, currentBalanceMinor: 70000 }),
    )
    expect(getStatementExpectedTotal(statement)).toMatchObject({ source: 'balance', expectedMinor: 20000 })
    const result = reconcileStatementTransactions(statement, [makeTx('stmt-balance', 20000)])
    expect(result.status).toBe('passed')
    expect(result.expectedSource).toBe('balance')
  })
})

describe('transaction count', () => {
  it('counts active rows and ignores rejected + installment_original amounts', () => {
    const statement = makeStatement(
      'stmt-count',
      summaryWith({ newDebitMinor: 10000, newCreditMinor: 0 }),
    )
    const txs = [
      makeTx('stmt-count', 6000),
      makeTx('stmt-count', 4000),
      makeTx('stmt-count', 99999, { reviewStatus: 'rejected' }),
      makeTx('stmt-count', 50000, { type: 'installment_original' }),
    ]
    const result = reconcileStatementTransactions(statement, txs)
    // Count excludes the rejected row; the installment original is excluded
    // from the amount but the count reflects verifiable postings.
    expect(result.transactionCount).toBe(2)
    expect(result.transactionTotalMinor).toBe(10000)
    expect(result.status).toBe('passed')
  })

  it('is insufficient when there is nothing to verify', () => {
    const statement = makeStatement(
      'stmt-empty',
      summaryWith({ newDebitMinor: 100, newCreditMinor: 0 }),
    )
    const result = reconcileStatementTransactions(statement, [])
    expect(result.status).toBe('insufficient')
    expect(result.transactionCount).toBe(0)
  })
})

describe('multiple statements', () => {
  it('reconciles each statement independently with one grouping pass', () => {
    const a = makeStatement('stmt-a', summaryWith({ newDebitMinor: 10000, newCreditMinor: 0 }))
    const b = makeStatement('stmt-b', summaryWith({ newDebitMinor: 20000, newCreditMinor: 0 }))
    const txs = [makeTx('stmt-a', 10000), makeTx('stmt-b', 15000)]
    const grouped = groupTransactionsByStatement(txs)
    expect(grouped.get('stmt-a')).toHaveLength(1)
    expect(grouped.get('stmt-b')).toHaveLength(1)

    const results = reconcileManyStatements([a, b], txs)
    expect(results.get('stmt-a')!.status).toBe('passed')
    expect(results.get('stmt-b')!.status).toBe('mismatch')
    expect(results.get('stmt-b')!.differenceMinor).toBe(5000)
  })

  it('memoizes repeated reconciliations without recomputing', () => {
    const statements = [makeStatement('stmt-m', summaryWith({ newDebitMinor: 5000, newCreditMinor: 0 }))]
    const txs = [makeTx('stmt-m', 5000)]
    const cache = createReconciliationCache()
    const first = cache.reconcile(statements, txs)
    const second = cache.reconcile(statements, txs)
    expect(second).toBe(first)
    expect(cache.stats()).toMatchObject({ hits: 1, misses: 1 })
    cache.clear()
    expect(cache.stats()).toMatchObject({ hits: 0, misses: 0 })
  })
})

describe('legacy imported statements', () => {
  it('is never marked reconciled: insufficient with imported status', () => {
    const statement = makeStatement('legacy-2024-01', emptySummary())
    statement.status = 'imported'
    statement.parserId = 'legacy-python-export-v1'
    const txs = [
      makeTx('legacy-2024-01', 12880, { origin: 'legacy_import', sourceId: 'legacy-python-export-v1' }),
      makeTx('legacy-2024-01', -30000, {
        origin: 'legacy_import',
        sourceId: 'legacy-python-export-v1',
        type: 'payment',
        direction: 'credit',
      }),
    ]
    const result = reconcileStatementTransactions(statement, txs)
    expect(result.status).toBe('insufficient')
    expect(result.bankTotalAvailable).toBe(false)
    // The stored statement must stay `imported`, never `reconciled`.
    expect(statement.status).toBe('imported')
    expect(statement.reconciliation.status).not.toBe('mismatch')

    const adapted = toReconciliationResult(result)
    expect(adapted.status).toBe('insufficient')
    expect(adapted.checks.find((c) => c.id === 'statement_total')!.status).toBe('missing')
  })
})

describe('data quality integration', () => {
  it('counts passed / mismatch / insufficient from stored reconciliation status', () => {
    const statements: Statement[] = [
      { ...makeStatement('dq-1', emptySummary()), reconciliation: { status: 'passed', checks: [], computedBalanceMinor: 1 } },
      { ...makeStatement('dq-2', emptySummary()), reconciliation: { status: 'mismatch', checks: [], computedBalanceMinor: 2 } },
      { ...makeStatement('dq-3', emptySummary()), reconciliation: { status: 'insufficient', checks: [], computedBalanceMinor: null } },
    ]
    const report = buildDataQualityReport({ transactions: [], statements, imports: [], attachmentHashes: [] })
    expect(report.statements.byReconciliation).toMatchObject({ passed: 1, mismatch: 1, insufficient: 1 })
  })
})

describe('reconciliation performance', () => {
  it('handles 50000 transactions across statements without per-page recompute', () => {
    const statements: Statement[] = Array.from({ length: 20 }, (_, i) =>
      makeStatement(`perf-stmt-${i}`, summaryWith({ newDebitMinor: 250000, newCreditMinor: 0 })),
    )
    const txs: Transaction[] = []
    for (let i = 0; i < 50_000; i++) {
      const sid = `perf-stmt-${i % 20}`
      seq += 1
      txs.push({
        id: `perf-${i}`,
        statementId: sid,
        bank: 'boc',
        cardLast4: '1234',
        transactionDate: '2024-01-05',
        postingDate: '2024-01-06',
        description: '消费 性能商户',
        rawDescription: '消费 性能商户',
        transactionCurrency: 'CNY',
        transactionAmountMinor: 100,
        settlementCurrency: 'CNY',
        settlementAmountMinor: 100,
        type: 'purchase',
        direction: 'debit',
        category: '未分类',
        confidence: 0.95,
        flags: [],
        reviewStatus: 'ok',
        sourceFileName: 'bill.pdf',
        sourceFileHash: `perf-${i % 100}`,
        sourcePage: 1,
        sourceRow: i,
        rawText: 'raw',
        fingerprint: `perf-fp-${i}`,
        occurrence: 1,
        isDemo: false,
      })
    }

    const started = performance.now()
    const cache = createReconciliationCache()
    const first = cache.reconcile(statements, txs)
    const firstMs = performance.now() - started
    expect(first.size).toBe(20)

    const cachedStart = performance.now()
    const second = cache.reconcile(statements, txs)
    const cachedMs = performance.now() - cachedStart
    expect(second).toBe(first)
    // Cached path must be effectively free compared to the full pass.
    expect(cachedMs).toBeLessThan(Math.max(5, firstMs / 10))
    expect(firstMs).toBeLessThan(5_000)
    // eslint-disable-next-line no-console
    console.info(`reconciliation perf: 50000 tx / 20 statements in ${firstMs.toFixed(0)}ms, cached ${cachedMs.toFixed(2)}ms`)
  }, 30_000)
})
