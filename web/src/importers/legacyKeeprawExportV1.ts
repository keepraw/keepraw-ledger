import { inferCategory, classifyTransactionType, extractSourceTypeToken } from '../core/classify'
import type { ReviewFlag } from '../core/types'
import type { LegacyAnomaly, NormalizedLegacyRow } from './types'
import {
  normalizeHeader,
  normalizeLegacyBank,
  normalizeLegacyCard,
  normalizeLegacyCurrency,
  parseLegacyAmount,
  parseLegacyDate,
} from './legacyPythonExportV1'

/**
 * Adapter for `legacy-keepraw-export-v1`: the user-maintained
 * `2026信用卡账单.xlsx` workbook, sheet `交易明细`.
 *
 * Fixed columns only (no generic Excel import):
 *
 *   银行 | 卡尾号 | 交易日 | 入账日 | 说明 | 交易币种 | 交易金额 | 结算币种 | 结算金额
 *
 * A file missing any of these columns is rejected, never guessed.
 * There is no statement-period column in this format, so `cycleStart` /
 * `cycleEnd` are always null and rows group by bank + card.
 */

export const LEGACY_KEEPRAW_SHEET = '交易明细'

export const LEGACY_KEEPRAW_COLUMNS = [
  '银行',
  '卡尾号',
  '交易日',
  '入账日',
  '说明',
  '交易币种',
  '交易金额',
  '结算币种',
  '结算金额',
] as const

const REQUIRED_COLUMNS: ReadonlySet<string> = new Set<string>(LEGACY_KEEPRAW_COLUMNS as readonly string[])

export interface KeeprawSheetShape {
  columnIndex: Map<string, number>
}

/**
 * Strict shape check: every fixed column must be present.
 * Extra columns are ignored; a missing one rejects the file.
 */
export function detectKeeprawShape(headerRow: unknown[]): KeeprawSheetShape | null {
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

function collapseSpaces(text: string): string {
  return text.replace(/\u3000/g, ' ').replace(/\s+/g, ' ').trim()
}

export interface KeeprawParseResult {
  rows: NormalizedLegacyRow[]
  anomalies: LegacyAnomaly[]
  /** Non-empty data rows seen (valid + anomalous). */
  totalRows: number
}

export function parseKeeprawRows(dataRows: unknown[][], shape: KeeprawSheetShape): KeeprawParseResult {
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

    const rawDescription = collapseSpaces(String(at(row, '说明') ?? ''))
    if (!rawDescription) {
      anomalies.push({ rowNumber, kind: 'missing_field', detail: '说明为空' })
      continue
    }

    const rawTransactionDate = parseLegacyDate(at(row, '交易日'))
    const rawPostingDate = parseLegacyDate(at(row, '入账日'))
    if (!rawTransactionDate && !rawPostingDate) {
      anomalies.push({ rowNumber, kind: 'date_unparseable', detail: '交易日与入账日均无法解析' })
      continue
    }
    const transactionDate = rawTransactionDate ?? rawPostingDate
    const postingDate = rawPostingDate ?? rawTransactionDate

    const settlementCurrency = normalizeLegacyCurrency(at(row, '结算币种'))
    const settlementAmountMinor = parseLegacyAmount(at(row, '结算金额'), settlementCurrency)
    if (settlementAmountMinor === null) {
      anomalies.push({ rowNumber, kind: 'amount_unparseable', detail: '结算金额无法解析' })
      continue
    }
    const transactionCurrency = normalizeLegacyCurrency(at(row, '交易币种'))
    const transactionAmountMinor = parseLegacyAmount(at(row, '交易金额'), transactionCurrency)
    if (transactionAmountMinor === null) {
      anomalies.push({ rowNumber, kind: 'amount_unparseable', detail: '交易金额无法解析，不以结算金额替代' })
      continue
    }

    const bank = normalizeLegacyBank(at(row, '银行'))
    const cardLast4 = normalizeLegacyCard(at(row, '卡尾号'))
    const direction = settlementAmountMinor < 0 ? 'credit' : 'debit'
    const classification = classifyTransactionType(extractSourceTypeToken(rawDescription), direction, settlementAmountMinor)
    const type = classification.type
    // This format carries no parser-confidence signal. Valid rows default to
    // 0.9 so they import as `ok`; only structural problems flag review.
    const confidence = 0.9

    const flags: ReviewFlag[] = []
    if (classification.requiresReview || (transactionAmountMinor < 0) !== (settlementAmountMinor < 0)) flags.push('transaction_type_unclear')
    if (!rawTransactionDate || !rawPostingDate) flags.push('date_missing')
    if (cardLast4 === '????') flags.push('card_missing')
    if (transactionAmountMinor === 0 || settlementAmountMinor === 0) flags.push('amount_missing')

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
      rawText: rawDescription,
      sourceRow: rowNumber,
      cycleStart: null,
      cycleEnd: null,
    })
  }

  return { rows, anomalies, totalRows }
}
