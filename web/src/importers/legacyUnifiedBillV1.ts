import { extractMerchant, inferCategory, classifyTransactionType, extractSourceTypeToken } from '../core/classify'
import type { ReviewFlag } from '../core/types'
import {
  normalizeHeader, normalizeLegacyBank, normalizeLegacyCard, normalizeLegacyCurrency,
  parseLegacyAmount, parseLegacyDate,
} from './legacyPythonExportV1'
import type { LegacyAnomaly, LegacyPreview, NormalizedLegacyRow } from './types'

/** The named historical sheet accepted by Python, with its complete fixed header. */
export const LEGACY_UNIFIED_BILL_SHEET = '统一账单'
export const LEGACY_UNIFIED_BILL_COLUMNS = [
  '银行名称', '卡号', '交易日期', '入账日期', '交易详情', '交易币种', '交易金额', '入账币种', '入账金额',
] as const

export function detectUnifiedBillShape(header: unknown[]): Map<string, number> | null {
  const columns = new Map<string, number>()
  for (const [index, value] of header.entries()) {
    const name = normalizeHeader(value)
    if (!name) continue
    if (columns.has(name)) return null
    columns.set(name, index)
  }
  return LEGACY_UNIFIED_BILL_COLUMNS.every((name) => columns.has(name)) ? columns : null
}

export function parseUnifiedBillRows(data: unknown[][], columns: Map<string, number>, today = new Date().toISOString().slice(0, 10)) {
  const rows: NormalizedLegacyRow[] = []
  const anomalies: LegacyAnomaly[] = []
  const reviewIssues: NonNullable<LegacyPreview['reviewIssues']> = []
  let totalRows = 0
  for (const [offset, cells] of data.entries()) {
    if (cells.every((value) => value == null || String(value).trim() === '')) continue
    totalRows += 1
    const rowNumber = offset + 2
    const at = (name: string) => cells[columns.get(name)!]
    const description = String(at('交易详情') ?? '').replace(/\s+/g, ' ').trim()
    const bank = normalizeLegacyBank(at('银行名称'))
    const rawCard = at('卡号')
    if (typeof rawCard === 'number' && (!Number.isSafeInteger(rawCard) || rawCard < 0 || rawCard >= 1e15)) {
      anomalies.push({ rowNumber, kind: 'missing_field', detail: '数字卡号超过 Excel 的精确位数，请核实后使用文本卡号或末四位' })
      continue
    }
    const cardLast4 = normalizeLegacyCard(at('卡号'))
    if (!description || bank === 'unknown' || cardLast4 === '????') {
      anomalies.push({ rowNumber, kind: 'missing_field', detail: '银行、卡号或交易详情缺失或无法识别' })
      continue
    }
    const transactionDate = parseLegacyDate(at('交易日期'))
    const postingCell = at('入账日期')
    const postingMissing = postingCell == null || String(postingCell).trim() === ''
    const postingDate = postingMissing ? transactionDate : parseLegacyDate(postingCell)
    if (!transactionDate || !postingDate) {
      anomalies.push({ rowNumber, kind: 'date_unparseable', detail: '交易日期或入账日期无法解析，未修改年份' })
      continue
    }
    const transactionCurrency = normalizeLegacyCurrency(at('交易币种'))
    const settlementCurrency = normalizeLegacyCurrency(at('入账币种'))
    if (![at('交易币种'), at('入账币种')].every((value) => value != null && String(value).trim()) ||
      ![transactionCurrency, settlementCurrency].every((value) => /^[A-Z]{3}$/.test(value))) {
      anomalies.push({ rowNumber, kind: 'missing_field', detail: '币种缺失或无法识别' })
      continue
    }
    const transactionAmountMinor = parseLegacyAmount(at('交易金额'), transactionCurrency)
    const settlementAmountMinor = parseLegacyAmount(at('入账金额'), settlementCurrency)
    if (transactionAmountMinor === null || settlementAmountMinor === null) {
      anomalies.push({ rowNumber, kind: 'amount_unparseable', detail: '交易金额或入账金额无法精确转换为最小货币单位' })
      continue
    }
    const flags: ReviewFlag[] = []
    if (postingMissing) flags.push('date_missing')
    if (transactionDate > today || postingDate > today) {
      reviewIssues.push({ rowNumber, detail: `日期晚于导入日（${transactionDate} / ${postingDate}），原值保留，请核实年份` })
      flags.push('low_confidence')
    }
    const direction = settlementAmountMinor < 0 ? 'credit' : 'debit'
    if ((transactionAmountMinor < 0) !== (settlementAmountMinor < 0)) flags.push('amount_direction_unclear')
    if (transactionAmountMinor === 0 || settlementAmountMinor === 0) flags.push('amount_missing')
    const classification = classifyTransactionType(extractSourceTypeToken(description), direction, settlementAmountMinor)
    const type = classification.type
    if (classification.requiresReview || flags.includes('amount_direction_unclear')) flags.push('transaction_type_unclear')
    rows.push({
      bank, cardLast4, transactionDate, postingDate, description, rawDescription: description,
      merchant: extractMerchant(description), transactionCurrency, transactionAmountMinor,
      settlementCurrency, settlementAmountMinor, type, direction, category: inferCategory(description, type),
      confidence: flags.includes('low_confidence') ? 0.5 : 0.9, flags,
      rawText: JSON.stringify(LEGACY_UNIFIED_BILL_COLUMNS.map(at)), sourceRow: rowNumber,
      cycleStart: null, cycleEnd: null,
    })
  }
  return { rows, anomalies, totalRows, reviewIssues }
}
