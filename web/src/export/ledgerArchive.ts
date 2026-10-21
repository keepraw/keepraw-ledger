import { transactionDisplayDescription } from '../core/descriptionNormalizer'
/**
 * Human-readable ledger archive (XLSX).
 *
 * Separate from JSON backup:
 * - JSON backup (`exportDataBackup`) = complete restore format.
 * - XLSX archive here = human-readable, externally viewable format.
 *
 * Workbook structure (two sheets):
 * - Sheet 1 `交易明细` (default): human-readable rows resembling the original
 *   credit card statement. No internal identifiers; a user can open the file
 *   and read transactions immediately.
 * - Sheet 2 `Technical Metadata`: per-transaction audit rows for migration and
 *   reconciliation (IDs, fingerprint, occurrence, source, import timestamp).
 *
 * Guarantees:
 * - Reuses the existing TypeScript data model (`Transaction`, `Statement`).
 * - Preserves exact stored values: no recalculation, no currency conversion.
 * - Amounts are rendered from integer minor units via `minorToDecimalString`
 *   and stored as text so Excel/LibreOffice never lose precision to floats.
 *   Negative values, multi-currency legs and zero-decimal currencies (JPY)
 *   are kept verbatim.
 * - Rows are ordered by transaction date, then posting date (stable id
 *   tiebreaker for determinism).
 * - No database schema change, no ID change, no import logic change,
 *   no JSON backup change, no Python change.
 */

import { minorToDecimalString } from '../core/money'
import { TRANSACTION_TYPE_LABELS, bankName, type Statement, type Transaction } from '../core/types'
import { triggerDownload } from './tabular'

export const LEDGER_ARCHIVE_HUMAN_SHEET = '交易明细'
export const LEDGER_ARCHIVE_METADATA_SHEET = 'Technical Metadata'

/** @deprecated Use {@link LEDGER_ARCHIVE_HUMAN_SHEET}. Kept for compatibility. */
export const LEDGER_ARCHIVE_TRANSACTION_SHEET = LEDGER_ARCHIVE_HUMAN_SHEET
/** @deprecated Use {@link LEDGER_ARCHIVE_METADATA_SHEET}. Kept for compatibility. */
export const LEDGER_ARCHIVE_STATEMENT_SHEET = LEDGER_ARCHIVE_METADATA_SHEET

/**
 * Sheet 1 headers, in task order (11 columns):
 * 银行 / 卡尾号 / 交易日 / 入账日 / 说明 / 交易类型 / 方向 /
 * 交易币种 / 交易金额 / 结算币种 / 结算金额
 */
export const LEDGER_HUMAN_HEADERS = [
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
] as const

/**
 * Sheet 2 headers (original six audit columns plus raw description):
 * transaction ID / statement ID / fingerprint / duplicate occurrence /
 * source statement (original source file name) / import timestamp
 * (`imported_at`, resolved from the linked statement).
 */
export const LEDGER_METADATA_HEADERS = [
  'transaction_id',
  'statement_id',
  'fingerprint',
  'duplicate_occurrence',
  'source_statement',
  'imported_at',
  'raw_description',
] as const

export type LedgerArchiveCell = string | number | null

/** Strip characters that are illegal in XLSX XML so the file opens in Excel/LibreOffice. */
export function sanitizeArchiveText(value: string): string {
  // Same class Python exporter strips: C0 controls except \t \n \r, plus surrogates.
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uD800-\uDFFF]/g, '')
}

function text(value: string | null | undefined): string {
  if (value === null || value === undefined) return ''
  return sanitizeArchiveText(value)
}

function directionLabel(direction: Transaction['direction']): string {
  // Same convention as the Transactions page XLSX export: debit=借, credit=贷.
  return direction === 'credit' ? '贷' : '借'
}

/**
 * One human-readable row, resembling the original statement format:
 * - 银行 uses the Chinese bank name (`bankName`); the raw bank id is
 *   recoverable via the fixed bank map and is not needed for reading.
 * - 交易类型 uses the fixed Chinese type label (`TRANSACTION_TYPE_LABELS`);
 *   the mapping is one-to-one with the stored enum, no recalculation.
 * - 方向 uses 借/贷; same convention as the existing XLSX export.
 * - Currencies are stored codes; amounts are exact decimal strings from
 *   integer minor units (no float math, no FX conversion). Stored as text.
 */
export function transactionToHumanRow(transaction: Transaction): LedgerArchiveCell[] {
  return [
    text(bankName(transaction.bank)),
    text(transaction.cardLast4),
    text(transaction.transactionDate ?? ''),
    text(transaction.postingDate ?? ''),
    text(transactionDisplayDescription(transaction)),
    text(TRANSACTION_TYPE_LABELS[transaction.type] ?? transaction.type),
    text(directionLabel(transaction.direction)),
    text(transaction.transactionCurrency),
    text(minorToDecimalString(transaction.transactionAmountMinor, transaction.transactionCurrency)),
    text(transaction.settlementCurrency),
    text(minorToDecimalString(transaction.settlementAmountMinor, transaction.settlementCurrency)),
  ]
}

/**
 * One metadata row preserves the full audit identity verbatim:
 * - IDs, fingerprint and occurrence are stored exactly as in IndexedDB,
 *   so duplicate occurrences (same fingerprint, occurrence 1..n) stay
 *   distinct and re-importable for inspection.
 * - `source_statement` is the original source file name for traceability.
 * - `imported_at` is the linked statement's import timestamp (empty when
 *   the statement row is unavailable); never recomputed.
 */
export function transactionToMetadataRow(
  transaction: Transaction,
  importedAt: string,
): LedgerArchiveCell[] {
  return [
    text(transaction.id),
    text(transaction.statementId),
    text(transaction.fingerprint),
    transaction.occurrence,
    text(transaction.sourceFileName),
    text(importedAt),
    text(transaction.rawDescription),
  ]
}

function sortTransactions(rows: Transaction[]): Transaction[] {
  return [...rows].sort((a, b) => {
    const byDate = (a.transactionDate ?? '').localeCompare(b.transactionDate ?? '')
    if (byDate !== 0) return byDate
    const byPosting = (a.postingDate ?? '').localeCompare(b.postingDate ?? '')
    if (byPosting !== 0) return byPosting
    return a.id.localeCompare(b.id)
  })
}

export interface LedgerArchiveContent {
  humanRows: LedgerArchiveCell[][]
  metadataRows: LedgerArchiveCell[][]
}

/** Deterministic row order; values themselves are never recalculated. */
export function buildLedgerArchiveContent(
  transactions: Transaction[],
  statements: Statement[],
): LedgerArchiveContent {
  const sorted = sortTransactions(transactions)
  const importedAtByStatement = new Map(statements.map((statement) => [statement.id, statement.importedAt]))
  return {
    humanRows: sorted.map(transactionToHumanRow),
    metadataRows: sorted.map((transaction) =>
      transactionToMetadataRow(transaction, importedAtByStatement.get(transaction.statementId) ?? ''),
    ),
  }
}

/** Build an independently openable XLSX buffer with 交易明细 + Technical Metadata. */
export async function buildLedgerArchiveBuffer(
  transactions: Transaction[],
  statements: Statement[],
): Promise<ArrayBuffer> {
  const XLSX = await import('xlsx')
  const { humanRows, metadataRows } = buildLedgerArchiveContent(transactions, statements)
  const humanSheet = XLSX.utils.aoa_to_sheet([
    [...LEDGER_HUMAN_HEADERS],
    ...humanRows,
  ])
  const metadataSheet = XLSX.utils.aoa_to_sheet([
    [...LEDGER_METADATA_HEADERS],
    ...metadataRows,
  ])
  humanSheet['!cols'] = [...LEDGER_HUMAN_HEADERS].map((header) => ({
    wch: Math.min(48, Math.max(14, header.length * 4 + 6)),
  }))
  metadataSheet['!cols'] = [...LEDGER_METADATA_HEADERS].map((header) => ({
    wch: Math.min(48, Math.max(14, header.length + 4)),
  }))
  const book = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(book, humanSheet, LEDGER_ARCHIVE_HUMAN_SHEET)
  XLSX.utils.book_append_sheet(book, metadataSheet, LEDGER_ARCHIVE_METADATA_SHEET)
  return XLSX.write(book, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer
}

export function ledgerArchiveFileName(now = new Date()): string {
  return `keepraw-ledger-export-${now.toISOString().slice(0, 10)}.xlsx`
}

/** Download the current ledger as a human-readable workbook (not a restore file). */
export async function downloadLedgerArchive(
  fileName: string,
  transactions: Transaction[],
  statements: Statement[],
): Promise<void> {
  const buffer = await buildLedgerArchiveBuffer(transactions, statements)
  triggerDownload(
    new Blob([buffer], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    }),
    fileName,
  )
}
