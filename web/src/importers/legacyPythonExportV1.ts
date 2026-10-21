import { inferCategory, classifyTransactionType, extractSourceTypeToken } from '../core/classify'
import { type IsoDate, parseDateInput } from '../core/dates'
import { isSupportedCurrency, parseAmountToMinor } from '../core/money'
import type { BankId, ReviewFlag } from '../core/types'
import type { LegacyAnomaly, NormalizedLegacyRow } from './types'

/**
 * Adapter for `legacy-python-export-v1`: the `标准字段` sheet of the
 * `unified_transactions.xlsx` produced by the old Python pipeline
 * (`src/ccparser/exporters.py::UNIFIED_COLUMNS`).
 *
 * That exporter writes exactly these snake_case columns; anything else
 * (a friendly-only sheet, `review.xlsx`, a hand-made 统一账单表) is NOT
 * this format and must be rejected, not guessed.
 */
export const LEGACY_STANDARD_SHEET = '标准字段'

export const LEGACY_UNIFIED_COLUMNS = [
  'bank',
  'card_last4',
  'statement_start',
  'statement_end',
  'transaction_date',
  'posting_date',
  'description',
  'transaction_currency',
  'transaction_amount',
  'settlement_currency',
  'settlement_amount',
  'source_file_name',
  'source_file_hash',
  'confidence',
  'raw_text',
] as const

const REQUIRED_COLUMNS: ReadonlySet<string> = new Set<string>(LEGACY_UNIFIED_COLUMNS as readonly string[])

/** Chinese bank names used by the old Python parsers -> current BankId. */
const BANK_MAP: Record<string, BankId> = {
  中国银行: 'boc',
  交通银行: 'bocom',
  工商银行: 'icbc',
  中国工商银行: 'icbc',
  农业银行: 'abc',
  中国农业银行: 'abc',
  建设银行: 'ccb',
  中国建设银行: 'ccb',
  中信银行: 'citic',
}

const BANK_IDS: ReadonlySet<string> = new Set(['boc', 'bocom', 'icbc', 'ccb', 'abc', 'citic', 'unknown'])

export function normalizeHeader(value: unknown): string {
  return String(value ?? '').replace(/\u00a0/g, '').trim()
}

export function normalizeLegacyBank(value: unknown): BankId {
  const text = normalizeHeader(value)
  if (BANK_MAP[text]) return BANK_MAP[text]!
  const lower = text.toLowerCase()
  if (BANK_IDS.has(lower)) return lower as BankId
  return 'unknown'
}

export function normalizeLegacyCard(value: unknown): string {
  if (value === null || value === undefined) return '????'
  let text = String(value).trim()
  if (text.endsWith('.0')) text = text.slice(0, -2)
  const digits = text.replace(/\D/g, '')
  if (!digits) return '????'
  return digits.slice(-4).padStart(4, '0')
}

export function normalizeLegacyCurrency(value: unknown): string {
  const text = String(value ?? '').replace(/\u3000/g, ' ').trim().toUpperCase()
  if (!text || text === 'RMB' || text === 'CHN' || text === '人民币') return 'CNY'
  return text
}

function dateFromParts(y: number, m: number, d: number): IsoDate | null {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null
  const date = new Date(Date.UTC(y, m - 1, d))
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null
  return date.toISOString().slice(0, 10) as IsoDate
}

/**
 * Excel serial dates count days from 1899-12-30 (the same epoch the old
 * Python `parse_date` uses). Range-guarded so stray numbers never become dates.
 */
export function excelSerialToIso(serial: number): IsoDate | null {
  if (!Number.isFinite(serial) || serial < 20_000 || serial > 80_000) return null
  // The fraction is time of day, not a reason to round into the next date.
  const ms = Date.UTC(1899, 11, 30) + Math.floor(serial) * 86_400_000
  const date = new Date(ms)
  return dateFromParts(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate())
}

export function parseLegacyDate(value: unknown): IsoDate | null {
  if (value === null || value === undefined) return null
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null
    return dateFromParts(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate())
  }
  if (typeof value === 'number') return excelSerialToIso(value)
  if (typeof value === 'string') {
    const text = value.trim()
    if (!text) return null
    // An all-digit string is an Excel serial only inside the plausible serial
    // range; otherwise it may be a compact `YYYYMMDD` date.
    if (/^\d+(\.\d+)?$/.test(text)) {
      const serial = Number(text)
      if (serial >= 20_000 && serial <= 80_000) return excelSerialToIso(serial)
    }
    return parseDateInput(text)
  }
  return null
}

/**
 * Yuan-decimal (number or string, sign included) -> integer minor units.
 *
 * Real exports carry binary float dust (`10 + 1.12` reads back as
 * `11.120000000000001`): anything within 1e-6 of a whole minor unit snaps to
 * it. Genuine extra precision (e.g. `10.005`) is still refused as an anomaly
 * rather than silently rounded into money.
 */
export function parseLegacyAmount(value: unknown, currency: string): number | null {
  if (!isSupportedCurrency(currency)) return null
  try {
    // Preserve numeric cells so the shared parser handles Excel float dust.
    // String cells retain the complete strict grammar; other types are refused.
    return parseAmountToMinor(value, currency)?.minor ?? null
  } catch {
    // Unsupported embedded currencies remain row-specific historical anomalies.
    return null
  }
}

function collapseSpaces(text: string): string {
  return text.replace(/\u3000/g, ' ').replace(/\s+/g, ' ').trim()
}

export interface LegacySheetShape {
  columnIndex: Map<string, number>
}

/**
 * Strict shape check: the header row must contain every known column.
 * Extra columns are ignored; a missing one rejects the file. No guessing.
 */
export function detectLegacyShape(headerRow: unknown[]): LegacySheetShape | null {
  const columnIndex = new Map<string, number>()
  headerRow.map(normalizeHeader).forEach((header, index) => {
    if (!columnIndex.has(header)) columnIndex.set(header, index)
  })
  for (const required of REQUIRED_COLUMNS) {
    if (!columnIndex.has(required)) return null
  }
  return { columnIndex }
}

function isEmptyRow(row: unknown[]): boolean {
  return row.every((cell) => cell === null || cell === undefined || (typeof cell === 'string' && cell.trim() === ''))
}

export interface LegacyParseResult {
  rows: NormalizedLegacyRow[]
  anomalies: LegacyAnomaly[]
  /** Non-empty data rows seen (valid + anomalous). */
  totalRows: number
}

export function parseLegacyRows(dataRows: unknown[][], shape: LegacySheetShape): LegacyParseResult {
  const rows: NormalizedLegacyRow[] = []
  const anomalies: LegacyAnomaly[] = []
  let totalRows = 0

  const at = (row: unknown[], name: string): unknown => {
    const index = shape.columnIndex.get(name)
    return index === undefined ? undefined : (row[index] ?? null)
  }

  for (const [offset, raw] of dataRows.entries()) {
    const rowNumber = offset + 2 // header is row 1
    const row = raw as unknown[]
    if (isEmptyRow(row)) continue
    totalRows += 1

    const rawDescription = collapseSpaces(String(at(row, 'description') ?? ''))
    if (!rawDescription) {
      anomalies.push({ rowNumber, kind: 'missing_field', detail: '交易描述为空' })
      continue
    }

    const rawTransactionDate = parseLegacyDate(at(row, 'transaction_date'))
    const rawPostingDate = parseLegacyDate(at(row, 'posting_date'))
    if (!rawTransactionDate && !rawPostingDate) {
      anomalies.push({ rowNumber, kind: 'date_unparseable', detail: '交易日与入账日均无法解析' })
      continue
    }
    // Mirror the old pipeline: a missing posting date falls back to the
    // transaction date and vice versa.
    const transactionDate = rawTransactionDate ?? rawPostingDate
    const postingDate = rawPostingDate ?? rawTransactionDate

    const settlementCurrency = normalizeLegacyCurrency(at(row, 'settlement_currency'))
    const settlementAmountMinor = parseLegacyAmount(at(row, 'settlement_amount'), settlementCurrency)
    if (settlementAmountMinor === null) {
      anomalies.push({ rowNumber, kind: 'amount_unparseable', detail: '结算金额无法解析' })
      continue
    }
    const transactionCurrency = normalizeLegacyCurrency(at(row, 'transaction_currency'))
    const transactionAmountMinor = parseLegacyAmount(at(row, 'transaction_amount'), transactionCurrency)
    if (transactionAmountMinor === null) {
      anomalies.push({ rowNumber, kind: 'amount_unparseable', detail: '交易金额无法解析，不以结算金额替代' })
      continue
    }

    const bank = normalizeLegacyBank(at(row, 'bank'))
    const cardLast4 = normalizeLegacyCard(at(row, 'card_last4'))
    const direction = settlementAmountMinor < 0 ? 'credit' : 'debit'
    const classification = classifyTransactionType(extractSourceTypeToken(rawDescription), direction, settlementAmountMinor)
    const type = classification.type
    const confidenceRaw = at(row, 'confidence')
    const confidence =
      typeof confidenceRaw === 'number' && Number.isFinite(confidenceRaw)
        ? Math.min(1, Math.max(0, confidenceRaw))
        : 0.5

    const flags: ReviewFlag[] = []
    if (classification.requiresReview || (transactionAmountMinor < 0) !== (settlementAmountMinor < 0)) flags.push('transaction_type_unclear')
    if (confidence < 0.8) flags.push('low_confidence')
    if (!rawTransactionDate || !rawPostingDate) flags.push('date_missing')
    if (cardLast4 === '????') flags.push('card_missing')
    if (transactionAmountMinor === 0 || settlementAmountMinor === 0) flags.push('amount_missing')

    const rawTextCell = at(row, 'raw_text')

    rows.push({
      bank,
      cardLast4,
      transactionDate,
      postingDate,
      description: rawDescription,
      rawDescription,
      transactionCurrency,
      transactionAmountMinor,
      settlementCurrency,
      settlementAmountMinor,
      type,
      direction,
      category: inferCategory(rawDescription, type),
      confidence,
      flags,
      rawText: typeof rawTextCell === 'string' ? rawTextCell : String(rawTextCell ?? ''),
      sourceRow: rowNumber,
      cycleStart: parseLegacyDate(at(row, 'statement_start')),
      cycleEnd: parseLegacyDate(at(row, 'statement_end')),
    })
  }

  return { rows, anomalies, totalRows }
}
