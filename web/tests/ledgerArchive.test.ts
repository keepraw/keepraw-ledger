import * as XLSX from 'xlsx'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '../src/db/db'
import { readSnapshot } from '../src/db/repository'
import { minorToDecimalString } from '../src/core/money'
import { TRANSACTION_TYPE_LABELS, bankName, type Statement, type Transaction } from '../src/core/types'
import { emptySummary } from '../src/parsers/types'
import {
  LEDGER_ARCHIVE_HUMAN_SHEET,
  LEDGER_ARCHIVE_METADATA_SHEET,
  LEDGER_HUMAN_HEADERS,
  LEDGER_METADATA_HEADERS,
  buildLedgerArchiveBuffer,
  ledgerArchiveFileName,
} from '../src/export/ledgerArchive'

beforeEach(async () => {
  await db.delete()
  await db.open()
})

function syntheticTransaction(overrides: Partial<Transaction> & { id: string }): Transaction {
  return {
    statementId: 'synthetic-stmt-1',
    bank: 'boc',
    cardLast4: '1234',
    transactionDate: '2024-01-05',
    postingDate: '2024-01-06',
    description: '消费 合成商户',
    rawDescription: '消费 合成商户',
    transactionCurrency: 'CNY',
    transactionAmountMinor: 12880,
    settlementCurrency: 'CNY',
    settlementAmountMinor: 12880,
    type: 'purchase',
    direction: 'debit',
    category: '未分类',
    confidence: 1,
    flags: [],
    reviewStatus: 'ok',
    sourceFileName: 'synthetic.txt',
    sourceFileHash: 'synthetic-hash',
    sourcePage: null,
    sourceRow: 1,
    rawText: 'synthetic row',
    fingerprint: 'synthetic-fp',
    occurrence: 1,
    isDemo: false,
    ...overrides,
  }
}

function syntheticStatement(overrides: Partial<Statement> & { id: string }): Statement {
  return {
    statementKey: `key-${overrides.id}`,
    bank: 'boc',
    cardLast4: '1234',
    cycleStart: '2024-01-01',
    cycleEnd: '2024-01-31',
    dueDate: null,
    summary: emptySummary(),
    reconciliation: { status: 'passed', checks: [], computedBalanceMinor: 0 },
    status: 'reconciled',
    parserId: 'synthetic',
    parserVersion: '1',
    transactionCount: 0,
    sourceFileName: 'synthetic.txt',
    sourceFileHash: 'synthetic-hash',
    importedAt: '2024-02-01T00:00:00.000Z',
    isDemo: false,
    ...overrides,
  }
}

/** Synthetic ledger only: multi-currency legs plus a repeated fingerprint. */
function seedLedger(): { transactions: Transaction[]; statements: Statement[] } {
  const statements: Statement[] = [
    syntheticStatement({
      id: 'synthetic-stmt-1',
      bank: 'boc',
      cardLast4: '1234',
      cycleStart: '2024-01-01',
      cycleEnd: '2024-01-31',
      transactionCount: 3,
      importedAt: '2024-02-01T10:00:00.000Z',
      status: 'reconciled',
    }),
    syntheticStatement({
      id: 'synthetic-stmt-2',
      bank: 'icbc',
      cardLast4: '5678',
      cycleStart: '2024-02-01',
      cycleEnd: '2024-02-29',
      transactionCount: 3,
      importedAt: '2024-03-01T10:00:00.000Z',
      status: 'needs_review',
    }),
  ]
  const transactions: Transaction[] = [
    syntheticTransaction({
      id: 'synthetic-tx-cny-1',
      statementId: 'synthetic-stmt-1',
      bank: 'boc',
      cardLast4: '1234',
      transactionDate: '2024-01-05',
      postingDate: '2024-01-06',
      description: '消费 合成咖啡',
      transactionCurrency: 'CNY',
      transactionAmountMinor: 12880,
      settlementCurrency: 'CNY',
      settlementAmountMinor: 12880,
      type: 'purchase',
      direction: 'debit',
      fingerprint: 'synthetic-fp-cny-1',
      occurrence: 1,
      sourceRow: 1,
    }),
    syntheticTransaction({
      id: 'synthetic-tx-usd-1',
      statementId: 'synthetic-stmt-1',
      bank: 'boc',
      cardLast4: '1234',
      transactionDate: '2024-01-07',
      postingDate: '2024-01-08',
      description: '消费 合成书店',
      transactionCurrency: 'USD',
      transactionAmountMinor: 1800,
      settlementCurrency: 'CNY',
      settlementAmountMinor: 12960,
      type: 'purchase',
      direction: 'debit',
      fingerprint: 'synthetic-fp-usd-1',
      occurrence: 1,
      sourceRow: 2,
    }),
    syntheticTransaction({
      id: 'synthetic-tx-jpy-1',
      statementId: 'synthetic-stmt-1',
      bank: 'boc',
      cardLast4: '1234',
      transactionDate: '2024-01-09',
      postingDate: '2024-01-10',
      description: '消费 合成文具',
      transactionCurrency: 'JPY',
      transactionAmountMinor: 1200,
      settlementCurrency: 'USD',
      settlementAmountMinor: 1005,
      type: 'purchase',
      direction: 'debit',
      fingerprint: 'synthetic-fp-jpy-1',
      occurrence: 1,
      sourceRow: 3,
    }),
    syntheticTransaction({
      id: 'synthetic-tx-dup-1',
      statementId: 'synthetic-stmt-2',
      bank: 'icbc',
      cardLast4: '5678',
      transactionDate: '2024-02-07',
      postingDate: '2024-02-08',
      description: '消费 合成超市',
      transactionCurrency: 'CNY',
      transactionAmountMinor: 5000,
      settlementCurrency: 'CNY',
      settlementAmountMinor: 5000,
      type: 'purchase',
      direction: 'debit',
      fingerprint: 'synthetic-fp-dup',
      occurrence: 1,
      sourceRow: 1,
    }),
    syntheticTransaction({
      id: 'synthetic-tx-dup-2',
      statementId: 'synthetic-stmt-2',
      bank: 'icbc',
      cardLast4: '5678',
      transactionDate: '2024-02-07',
      postingDate: '2024-02-08',
      description: '消费 合成超市',
      transactionCurrency: 'CNY',
      transactionAmountMinor: 5000,
      settlementCurrency: 'CNY',
      settlementAmountMinor: 5000,
      type: 'purchase',
      direction: 'debit',
      fingerprint: 'synthetic-fp-dup',
      occurrence: 2,
      sourceRow: 2,
    }),
    syntheticTransaction({
      id: 'synthetic-tx-eur-refund-1',
      statementId: 'synthetic-stmt-2',
      bank: 'icbc',
      cardLast4: '5678',
      transactionDate: '2024-02-09',
      postingDate: '2024-02-10',
      description: '退货 合成商城',
      transactionCurrency: 'EUR',
      transactionAmountMinor: -2500,
      settlementCurrency: 'CNY',
      settlementAmountMinor: -18000,
      type: 'refund',
      direction: 'credit',
      fingerprint: 'synthetic-fp-eur-1',
      occurrence: 1,
      sourceRow: 3,
    }),
  ]
  // Keep stored statement counts exact (3 + 3 = 6 rows).
  return { transactions, statements }
}

function sheetRows(buffer: ArrayBuffer, name: string): unknown[][] {
  const workbook = XLSX.read(buffer, { type: 'array' })
  const sheet = workbook.Sheets[name]
  expect(sheet).toBeDefined()
  return XLSX.utils.sheet_to_json<unknown[]>(sheet!, { header: 1, raw: true, defval: null }) as unknown[][]
}

describe('ledger XLSX archive', () => {
  it('opens with 交易明细 and Technical Metadata sheets; first sheet has human-readable headers and matches database counts', async () => {
    const { transactions, statements } = seedLedger()
    await db.statements.bulkPut(statements)
    await db.transactions.bulkPut(transactions)
    expect(await db.transactions.count()).toBe(transactions.length)

    const snapshot = await readSnapshot()
    const buffer = await buildLedgerArchiveBuffer(snapshot.transactions, snapshot.statements)

    // Can be opened independently with exactly the two workbook sheets.
    const workbook = XLSX.read(buffer, { type: 'array' })
    expect(workbook.SheetNames).toEqual([LEDGER_ARCHIVE_HUMAN_SHEET, LEDGER_ARCHIVE_METADATA_SHEET])
    expect(LEDGER_ARCHIVE_HUMAN_SHEET).toBe('交易明细')

    const humanRows = sheetRows(buffer, LEDGER_ARCHIVE_HUMAN_SHEET)
    const metadataRows = sheetRows(buffer, LEDGER_ARCHIVE_METADATA_SHEET)
    expect(humanRows[0]).toEqual([...LEDGER_HUMAN_HEADERS])
    expect(humanRows[0]).toEqual([
      '银行',
      '卡尾号',
      '交易日',
      '入账日',
      '说明',
      '交易类型',
      '方向',
      '交易币种',
      '交易金额',
      '结算币种',
      '结算金额',
    ])
    expect(metadataRows[0]).toEqual([...LEDGER_METADATA_HEADERS])
    // Header + one row per stored record on both sheets.
    expect(humanRows.length - 1).toBe(transactions.length)
    expect(metadataRows.length - 1).toBe(transactions.length)
    // Human sheet carries no internal identifiers.
    for (const header of humanRows[0]!) {
      expect(String(header)).not.toMatch(/id|fingerprint|occurrence/i)
    }
  })

  it('keeps multi-currency amounts and currencies unchanged without conversion', async () => {
    const { transactions, statements } = seedLedger()
    await db.statements.bulkPut(statements)
    await db.transactions.bulkPut(transactions)
    const snapshot = await readSnapshot()
    const buffer = await buildLedgerArchiveBuffer(snapshot.transactions, snapshot.statements)

    const rows = sheetRows(buffer, LEDGER_ARCHIVE_HUMAN_SHEET)
    const headers = [...LEDGER_HUMAN_HEADERS]
    const bankIndex = headers.indexOf('银行')
    const cardIndex = headers.indexOf('卡尾号')
    const txnDateIndex = headers.indexOf('交易日')
    const postingIndex = headers.indexOf('入账日')
    const descIndex = headers.indexOf('说明')
    const typeIndex = headers.indexOf('交易类型')
    const dirIndex = headers.indexOf('方向')
    const txnCcyIndex = headers.indexOf('交易币种')
    const txnAmtIndex = headers.indexOf('交易金额')
    const stlCcyIndex = headers.indexOf('结算币种')
    const stlAmtIndex = headers.indexOf('结算金额')

    // Human rows are ordered by transaction date, then posting date.
    const dates = rows.slice(1).map((row) => `${String(row[txnDateIndex])} ${String(row[postingIndex])}`)
    expect([...dates].sort()).toEqual(dates)

    // Every stored transaction appears once with exact values (no FX, no recalc).
    const byDescription = new Map(rows.slice(1).map((row) => [String(row[descIndex]), row]))
    for (const tx of transactions) {
      const candidates = rows.slice(1).filter((row) => String(row[descIndex]) === tx.description)
      expect(candidates.length).toBeGreaterThanOrEqual(1)
      const match = candidates.find(
        (row) =>
          String(row[txnCcyIndex]) === tx.transactionCurrency &&
          String(row[txnAmtIndex]) === minorToDecimalString(tx.transactionAmountMinor, tx.transactionCurrency),
      )
      expect(match).toBeDefined()
      expect(String(match![stlCcyIndex])).toBe(tx.settlementCurrency)
      expect(String(match![stlAmtIndex])).toBe(
        minorToDecimalString(tx.settlementAmountMinor, tx.settlementCurrency),
      )
      expect(String(match![bankIndex])).toBe(bankName(tx.bank))
      expect(String(match![cardIndex])).toBe(tx.cardLast4)
      expect(String(match![txnDateIndex])).toBe(tx.transactionDate ?? '')
      expect(String(match![postingIndex])).toBe(tx.postingDate ?? '')
      expect(String(match![typeIndex])).toBe(TRANSACTION_TYPE_LABELS[tx.type])
      expect(String(match![dirIndex])).toBe(tx.direction === 'credit' ? '贷' : '借')
      // Amounts are stored as text so Excel never loses precision to floats.
      expect(typeof match![txnAmtIndex]).toBe('string')
      expect(typeof match![stlAmtIndex]).toBe('string')
    }
    // Spot-check zero-decimal and negative legs stay exact.
    const stationery = byDescription.get('消费 合成文具')!
    expect(String(stationery[txnCcyIndex])).toBe('JPY')
    expect(String(stationery[txnAmtIndex])).toBe('1200')
    expect(String(stationery[stlAmtIndex])).toBe('10.05')
    const refund = byDescription.get('退货 合成商城')!
    expect(String(refund[txnAmtIndex])).toBe('-25.00')
    expect(String(refund[stlAmtIndex])).toBe('-180.00')
    expect(String(refund[dirIndex])).toBe('贷')
  })

  it('keeps transaction IDs available in the metadata sheet', async () => {
    const { transactions, statements } = seedLedger()
    await db.statements.bulkPut(statements)
    await db.transactions.bulkPut(transactions)
    const snapshot = await readSnapshot()
    const buffer = await buildLedgerArchiveBuffer(snapshot.transactions, snapshot.statements)

    const rows = sheetRows(buffer, LEDGER_ARCHIVE_METADATA_SHEET)
    const headers = [...LEDGER_METADATA_HEADERS]
    expect(headers).toContain('transaction_id')
    expect(headers).toContain('statement_id')
    expect(headers).toContain('fingerprint')
    expect(headers).toContain('duplicate_occurrence')
    expect(headers).toContain('source_statement')
    const idIndex = headers.indexOf('transaction_id')
    const exportedIds = rows.slice(1).map((row) => String(row[idIndex]))
    expect(new Set(exportedIds).size).toBe(transactions.length)
    expect([...exportedIds].sort()).toEqual(transactions.map((tx) => tx.id).sort())
  })

  it('preserves duplicate fingerprint and occurrence relationships', async () => {
    const { transactions, statements } = seedLedger()
    await db.statements.bulkPut(statements)
    await db.transactions.bulkPut(transactions)
    const snapshot = await readSnapshot()
    const buffer = await buildLedgerArchiveBuffer(snapshot.transactions, snapshot.statements)

    const rows = sheetRows(buffer, LEDGER_ARCHIVE_METADATA_SHEET)
    const headers = [...LEDGER_METADATA_HEADERS]
    const byId = new Map(rows.slice(1).map((row) => [String(row[headers.indexOf('transaction_id')]), row]))
    for (const tx of transactions) {
      const row = byId.get(tx.id)!
      expect(String(row[headers.indexOf('fingerprint')])).toBe(tx.fingerprint)
      expect(Number(row[headers.indexOf('duplicate_occurrence')])).toBe(tx.occurrence)
      expect(String(row[headers.indexOf('statement_id')])).toBe(tx.statementId)
    }
    // Both occurrences of the same fingerprint survive as distinct rows.
    const dupRows = rows.slice(1).filter(
      (row) => String(row[headers.indexOf('fingerprint')]) === 'synthetic-fp-dup',
    )
    expect(dupRows.map((row) => Number(row[headers.indexOf('duplicate_occurrence')])).sort()).toEqual([1, 2])
    expect(dupRows.map((row) => String(row[headers.indexOf('transaction_id')])).sort()).toEqual(
      ['synthetic-tx-dup-1', 'synthetic-tx-dup-2'],
    )
  })

  it('preserves source statement and import timestamp per transaction', async () => {
    const { transactions, statements } = seedLedger()
    await db.statements.bulkPut(statements)
    await db.transactions.bulkPut(transactions)
    const snapshot = await readSnapshot()
    const buffer = await buildLedgerArchiveBuffer(snapshot.transactions, snapshot.statements)

    const rows = sheetRows(buffer, LEDGER_ARCHIVE_METADATA_SHEET)
    const headers = [...LEDGER_METADATA_HEADERS]
    const byId = new Map(rows.slice(1).map((row) => [String(row[headers.indexOf('transaction_id')]), row]))
    const importedAtByStatement = new Map(statements.map((st) => [st.id, st.importedAt]))
    for (const tx of transactions) {
      const row = byId.get(tx.id)!
      expect(String(row[headers.indexOf('source_statement')])).toBe(tx.sourceFileName)
      expect(String(row[headers.indexOf('imported_at')])).toBe(importedAtByStatement.get(tx.statementId) ?? '')
    }
  })

  it('names the export file keepraw-ledger-export-YYYY-MM-DD.xlsx', () => {
    expect(ledgerArchiveFileName(new Date('2026-10-14T00:00:00.000Z'))).toBe(
      'keepraw-ledger-export-2026-10-14.xlsx',
    )
  })
})
