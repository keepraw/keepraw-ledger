import { describe, expect, it } from 'vitest'
import { buildDataQualityReport, scoreHealth } from '../src/core/dataQuality'
import { emptySummary } from '../src/parsers/types'
import type { ImportRecord, ReviewFlag, Statement, Transaction } from '../src/core/types'

let seq = 0

function tx(overrides: Partial<Transaction> = {}): Transaction {
  seq += 1
  return {
    id: `tx-${seq}`,
    statementId: 'stmt-1',
    bank: 'boc',
    cardLast4: '1234',
    transactionDate: '2024-01-05',
    postingDate: '2024-01-06',
    description: '消费 示例商户',
    rawDescription: '消费 示例商户',
    transactionCurrency: 'CNY',
    transactionAmountMinor: 10000,
    settlementCurrency: 'CNY',
    settlementAmountMinor: 10000,
    type: 'purchase',
    direction: 'debit',
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

function statement(overrides: Partial<Statement> = {}): Statement {
  return {
    id: 'stmt-1',
    statementKey: 'stmt-1',
    bank: 'boc',
    cardLast4: '1234',
    cycleStart: '2024-01-01',
    cycleEnd: '2024-01-31',
    dueDate: null,
    summary: emptySummary(),
    reconciliation: { status: 'passed', checks: [], computedBalanceMinor: null },
    status: 'reconciled',
    parserId: 'boc_pdf',
    parserVersion: '1.0.0',
    transactionCount: 1,
    sourceFileName: 'bill.pdf',
    sourceFileHash: 'hash-1',
    importedAt: new Date().toISOString(),
    isDemo: false,
    ...overrides,
  }
}

function record(overrides: Partial<ImportRecord> = {}): ImportRecord {
  return {
    id: 'rec-1',
    fileName: 'bill.pdf',
    fileSize: 100,
    fileHash: 'hash-1',
    sourceType: 'pdf',
    bank: 'boc',
    detectedBank: 'boc',
    cardLast4: '1234',
    cycleStart: '2024-01-01',
    cycleEnd: '2024-01-31',
    status: 'parsed',
    message: 'ok',
    statementId: 'stmt-1',
    transactionCount: 1,
    duplicateOf: null,
    parserId: 'boc_pdf',
    importedAt: new Date().toISOString(),
    isDemo: false,
    ...overrides,
  }
}

describe('dataQuality service', () => {
  it('counts totals, review status and reconciliation without changing inputs', () => {
    const transactions = [tx(), tx({ reviewStatus: 'pending', flags: ['low_confidence' as ReviewFlag] })]
    const statements = [statement(), statement({ id: 'stmt-2', status: 'needs_review', reconciliation: { status: 'mismatch', checks: [], computedBalanceMinor: null } })]
    const imports = [record()]
    const before = JSON.stringify(transactions)

    const report = buildDataQualityReport({ transactions, statements, imports, attachmentHashes: new Set(['hash-1']) })

    expect(report.totals).toEqual({ transactions: 2, statements: 2, imports: 1 })
    expect(report.review.byReviewStatus).toMatchObject({ ok: 1, pending: 1 })
    expect(report.statements.byStatus).toMatchObject({ reconciled: 1, needs_review: 1 })
    expect(report.statements.byReconciliation).toMatchObject({ passed: 1, mismatch: 1 })
    // Pure: inputs untouched.
    expect(JSON.stringify(transactions)).toBe(before)
  })
})

describe('mixed sources', () => {
  it('splits bank parser rows from legacy imports by origin/sourceId', () => {
    const transactions = [
      tx({ origin: undefined, sourceId: undefined }),
      tx({ origin: 'parser', bank: 'bocom', sourceId: undefined, sourceFileHash: 'hash-2' }),
      ...Array.from({ length: 3 }, (_, i) =>
        tx({ origin: 'legacy_import', sourceId: 'legacy-python-export-v1', bank: 'ccb', sourceFileHash: `legacy-${i}` }),
      ),
    ]
    const imports = [
      record({ id: 'r1', sourceType: 'pdf', parserId: 'boc_pdf' }),
      record({ id: 'r2', fileName: 'history.xlsx', fileHash: 'legacy-hash', sourceType: 'xlsx', status: 'imported', parserId: 'legacy-python-export-v1' }),
    ]
    const report = buildDataQualityReport({ transactions, statements: [], imports, attachmentHashes: [] })

    expect(report.origins.byOrigin).toEqual({ parser: 2, legacy_import: 3 })
    expect(report.origins.bySourceId['bank-parser']).toBe(2)
    expect(report.origins.bySourceId['legacy-python-export-v1']).toBe(3)
    expect(report.importsBySourceType).toMatchObject({ pdf: 1, xlsx: 1 })
    expect(report.origins.byBank).toMatchObject({ boc: 1, bocom: 1, ccb: 3 })
  })
})

describe('attachment status', () => {
  it('marks imports with evidence as archived and the rest as missing', () => {
    const imports = [
      record({ id: 'r1', fileName: 'a.pdf', fileHash: 'h1' }),
      record({ id: 'r2', fileName: 'b.pdf', fileHash: 'h2' }),
      record({ id: 'r3', fileName: 'history.xlsx', fileHash: 'h3', sourceType: 'xlsx', status: 'imported' }),
    ]
    const report = buildDataQualityReport({ transactions: [], statements: [], imports, attachmentHashes: new Set(['h1']) })

    expect(report.evidence.total).toBe(3)
    expect(report.evidence.archived).toBe(1)
    expect(report.evidence.missing).toBe(2)
    expect(report.evidence.missingFiles).toEqual(['b.pdf', 'history.xlsx'])
    expect(report.actions.missingAttachments).toBe(2)
  })
})

describe('flag aggregation', () => {
  it('aggregates low_confidence and related flags per transaction once', () => {
    const transactions = [
      tx({ flags: ['low_confidence', 'date_missing'], reviewStatus: 'pending' }),
      tx({ flags: ['low_confidence'], reviewStatus: 'pending' }),
      tx({ flags: ['amount_missing', 'card_missing'], reviewStatus: 'pending' }),
      tx({ flags: ['suspected_duplicate'], reviewStatus: 'pending' }),
      tx(),
    ]
    const report = buildDataQualityReport({ transactions, statements: [], imports: [] })

    expect(report.flags.flaggedTransactions).toBe(4)
    expect(report.flags.byFlag.low_confidence).toBe(2)
    expect(report.flags.byFlag.date_missing).toBe(1)
    expect(report.flags.byFlag.amount_missing).toBe(1)
    expect(report.flags.byFlag.card_missing).toBe(1)
    expect(report.flags.byFlag.suspected_duplicate).toBe(1)
    expect(report.review.unflagged).toBe(1)
    expect(report.duplicates.suspectedDuplicateTransactions).toBe(1)
  })

  it('counts duplicate files from existing import metadata only', () => {
    const imports = [
      record({ id: 'r1' }),
      record({ id: 'r2', fileName: 'copy.pdf', fileHash: 'h2', status: 'duplicate', duplicateOf: 'r1', transactionCount: 0 }),
    ]
    const report = buildDataQualityReport({ transactions: [], statements: [], imports, attachmentHashes: [] })
    expect(report.duplicates.duplicateFileImports).toBe(1)
  })
})

describe('health score', () => {
  it('scores an empty ledger as healthy and penalises issues explainably', () => {
    expect(scoreHealth({ transactionCount: 0, flagged: 0, importCount: 0, missingAttachments: 0, statementCount: 0, unreconciledStatements: 0 })).toEqual({
      score: 100,
      level: 'healthy',
    })
    const bad = scoreHealth({ transactionCount: 100, flagged: 100, importCount: 10, missingAttachments: 10, statementCount: 10, unreconciledStatements: 10 })
    expect(bad.score).toBeLessThan(30)
    expect(bad.level).toBe('critical')
  })
})

describe('dataQuality performance', () => {
  it('aggregates 50000 transactions in reasonable time', () => {
    const flags: ReviewFlag[][] = [[], ['low_confidence'], ['date_missing'], [], ['amount_missing']]
    const transactions: Transaction[] = Array.from({ length: 50_000 }, (_, i) =>
      tx({
        id: `perf-${i}`,
        fingerprint: `perf-fp-${i}`,
        bank: i % 2 === 0 ? 'boc' : 'bocom',
        origin: i % 10 === 0 ? 'legacy_import' : undefined,
        sourceId: i % 10 === 0 ? 'legacy-python-export-v1' : undefined,
        flags: flags[i % flags.length]!,
        reviewStatus: i % 5 === 0 ? 'pending' : 'ok',
        sourceFileHash: `perf-hash-${i % 500}`,
      }),
    )
    const imports: ImportRecord[] = Array.from({ length: 500 }, (_, i) =>
      record({ id: `perf-rec-${i}`, fileName: `bill-${i}.pdf`, fileHash: `perf-hash-${i}` }),
    )
    const hashes = new Set(imports.map((r) => r.fileHash))

    const started = performance.now()
    const report = buildDataQualityReport({ transactions, statements: [], imports, attachmentHashes: hashes })
    const elapsed = performance.now() - started
    // eslint-disable-next-line no-console
    console.info(`dataQuality perf: 50000 tx in ${elapsed.toFixed(0)}ms`)

    expect(report.totals.transactions).toBe(50_000)
    expect(report.origins.byOrigin.legacy_import).toBe(5_000)
    expect(report.origins.byOrigin.parser).toBe(45_000)
    expect(elapsed).toBeLessThan(5_000)
  }, 30_000)
})
