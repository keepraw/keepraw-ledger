import { cleanSourceDescription } from '../core/sourceDescription'
import { parseDateInput } from '../core/dates'
import { extractMerchant, classifyTransactionType, extractSourceTypeToken, signForDirection } from '../core/classify'
import { parseAmountToMinor } from '../core/money'
import type { BankId, Direction, NamedAmount, StatementSummary } from '../core/types'
import { assertCreditSign, emptySummary, ParseError, requireTransactionAmount, requireTransactionRow, type BankParser, type ParsedStatement, type ParsedTransaction, type SourceDocument } from './types'

const PARSER_ID = 'citic_eml'
const PARSER_VERSION = '1.0.0'

/**
 * China CITIC Bank e-mailed HTML statement (动卡空间 / ecitic template).
 *
 * Direction comes from the signed amount cells (`-` prefix = credit /
 * repayment-or-refund, per the bank's own layout) and never from the merchant
 * text. The transaction table uses compact `YYYYMMDD` dates and a
 * `CNY <amount>` currency/amount pair for both the transaction and the
 * posting leg.
 *
 * Note on the bank's own subtotals: 中信 nets refunds and cashbacks into
 * 本期新增金额 (New Charge) instead of counting them toward 上期已还款额
 * (Payments). The parser reports the bank-stated lines verbatim; a cycle
 * containing refunds therefore routes to manual review under the shared
 * detail checks instead of being silently redefined. The balance equation
 * (上期应还款额 − 上期已还款额 + 本期新增金额 = 账户账单金额) always holds.
 */

const FOOTER_MARKERS = /温馨提示|安全用卡|客服热线|征信|积分过期|用卡指南|还款指引/

export interface CiticTxnTable {
  tableIndex: number
  headerRowIndex: number
}

export const citicParser: BankParser = {
  id: PARSER_ID,
  version: PARSER_VERSION,
  bank: 'citic',
  sourceTypes: ['eml', 'html'],

  match(doc) {
    const haystack = `${doc.email?.subject ?? ''}\n${doc.email?.from ?? ''}\n${doc.text.slice(0, 30000)}`
    const namesBank = /中信银行|CITIC|ecitic|动卡空间/i.test(haystack)
    const namesProduct = /信用卡电子账单|信用卡/.test(haystack)
    const hasCycle = /账单.*已产生|账单周期|交易明细|Statement/.test(haystack)
    if (namesBank && namesProduct && hasCycle) return 1
    if (namesBank && hasCycle) return 0.8
    return 0
  },

  parse(doc) {
    if (!doc.tables.length) throw new ParseError('邮件中没有可解析的 HTML 表格', 'no_tables')
    const txnTable = locateTxnTable(doc)
    if (!txnTable) throw new ParseError('未找到交易明细表头', 'no_transaction_table')

    const cycle = locateCycle(doc)
    const dueDate = locateDueDate(doc)
    const summary = parseSummary(doc, dueDate)
    const cardLast4 = locateCardLast4(doc)
    const transactions = collectTransactions(doc, cardLast4)
    if (transactions.length === 0) {
      throw new ParseError('未在账单中找到交易明细行', 'no_transactions_found')
    }

    const warnings: string[] = []
    if (!cardLast4) warnings.push('missing_card_last4')
    if (!cycle.start || !cycle.end) warnings.push('missing_statement_period')
    if (summary.currentBalanceMinor === null) warnings.push('missing_current_balance')
    if (summary.previousBalanceMinor === null) warnings.push('missing_previous_balance')
    if (summary.newDebitMinor === null) warnings.push('missing_new_debit')
    if (summary.newCreditMinor === null) warnings.push('missing_new_credit')

    return {
      bank: 'citic' as BankId,
      cardLast4,
      cycleStart: cycle.start,
      cycleEnd: cycle.end,
      dueDate: summary.dueDate,
      summary,
      transactions,
      confidence: cardLast4 && cycle.start && summary.currentBalanceMinor !== null ? 0.93 : 0.65,
      parserId: PARSER_ID,
      parserVersion: PARSER_VERSION,
      warnings,
    } satisfies ParsedStatement
  },
}

export interface Cycle {
  start: string | null
  end: string | null
}

const CYCLE_CN_RANGE =
  /(\d{4})年(\d{1,2})月(\d{1,2})日\s*[—–\-~至到]\s*(\d{4})年(\d{1,2})月(\d{1,2})日/
const CYCLE_BARE = /(\d{4})[/.](\d{1,2})[/.](\d{1,2})\s*[-–—~至到]\s*(\d{4})[/.](\d{1,2})[/.](\d{1,2})/

export function locateCycle(doc: SourceDocument): Cycle {
  const haystack = `${doc.email?.subject ?? ''}\n${doc.text}\n${doc.tables
    .flatMap((table) => table.rows)
    .map((row) => row.join(' '))
    .join('\n')}`
  const match = CYCLE_CN_RANGE.exec(haystack) ?? CYCLE_BARE.exec(haystack)
  if (!match) return { start: null, end: null }
  return {
    start: parseDateInput(`${match[1]}-${match[2]}-${match[3]}`),
    end: parseDateInput(`${match[4]}-${match[5]}-${match[6]}`),
  }
}

export function locateDueDate(doc: SourceDocument): string | null {
  const haystack = `${doc.text}\n${doc.tables.flatMap((t) => t.rows).map((r) => r.join(' ')).join('\n')}`
  let match = /到期还款日\D*(\d{4})年(\d{1,2})月(\d{1,2})日/.exec(haystack)
  if (match) return parseDateInput(`${match[1]}-${match[2]}-${match[3]}`)
  match = /到期还款日\D*(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(haystack)
  if (match) return parseDateInput(`${match[1]}-${match[2]}-${match[3]}`)
  return null
}

export function locateCardLast4(doc: SourceDocument): string {
  // Transaction rows carry the authoritative 4-digit suffix.
  for (const table of doc.tables) {
    for (const row of table.rows) {
      const cells = row[0] === '' ? row.slice(1) : row
      if (cells.length === 7 && /^\d{8}$/.test(cells[0] ?? '') && /^\d{4}$/.test(cells[2] ?? '')) {
        return cells[2]!
      }
    }
  }
  // Masked account numbers (`09**-****-650`) expose at most 3 trailing
  // digits, which must never be mistaken for a last-4. Only accept a full
  // 4-digit masked suffix. Never accept the leading BIN group.
  const haystack = `${doc.email?.subject ?? ''}\n${doc.text}`
  const masked = /\*+-*(\d{4})/.exec(haystack)
  if (masked) return masked[1]!
  for (const table of doc.tables) {
    for (const row of table.rows) {
      for (const cell of row) {
        if (/^\d{4}$/.test(cell)) return cell
      }
    }
  }
  return ''
}

const TXN_HEADER_CELL = /交易日|银行记账日|卡号后四位|交易描述|交易货币|记账货币|Trans Date|Post Date|Card Number|Description|Trx\.Amt|Setl\.Amt/

export function locateTxnTable(doc: SourceDocument): CiticTxnTable | null {
  for (const table of doc.tables) {
    for (let r = 0; r < table.rows.length; r++) {
      const row = table.rows[r]!
      if (row.filter((cell) => TXN_HEADER_CELL.test(cell)).length >= 5) {
        return { tableIndex: table.index, headerRowIndex: r }
      }
    }
  }
  return null
}

function parseSummary(doc: SourceDocument, dueDate: string | null): StatementSummary {
  // Balances carry explicit debt/credit signs; spending and payment totals remain magnitudes.
  const summary = emptySummary()
  const components: NamedAmount[] = []
  summary.dueDate = dueDate

  // --- 总账信息: 本期应还款总额 / 本期最低还款额 (same-row label + amount) ---
  for (const table of doc.tables) {
    for (const row of table.rows) {
      if (summary.currentBalanceMinor === null && row.some((cell) => /本期应还款总额/.test(cell))) {
        const parsed = parseFirstAmount(row)
        if (parsed) {
          summary.currentBalanceMinor = parsed.minor
          components.push({ label: '本期应还款总额 Total Payment', minor: parsed.minor, currency: 'CNY' })
        }
      }
      if (summary.minimumPaymentMinor === null && row.some((cell) => /本期最低还款额/.test(cell))) {
        const parsed = parseFirstAmount(row)
        if (parsed) {
          summary.minimumPaymentMinor = Math.abs(parsed.minor)
          components.push({ label: '本期最低还款额 Min. Payment', minor: summary.minimumPaymentMinor, currency: 'CNY' })
        }
      }
    }
  }

  // --- 卡片账单金额明细: 上期应还款额 − 上期已还款额 + 本期新增金额 = 账户账单金额 ---
  // The header row and its value row live in *different* tables (the English
  // caption row sits between them), so the value scan continues into the
  // following tables in document order.
  const flatRows = doc.tables.flatMap((table) => table.rows.map((row) => ({ table: table.index, row })))
  const headerPos = flatRows.findIndex(
    ({ row }) =>
      row.some((cell) => /上期应还款额/.test(cell)) &&
      row.some((cell) => /本期新增金额/.test(cell)) &&
      row.some((cell) => /账户账单金额/.test(cell)),
  )
  if (headerPos !== -1) {
    for (let i = headerPos + 1; i < flatRows.length; i++) {
      const amounts = rowAmounts(flatRows[i]!.row)
      if (amounts.length < 4) continue
      if (summary.previousBalanceMinor === null) {
        summary.previousBalanceMinor = amounts[0]!
        components.push({ label: '上期应还款额 Previous Balance', minor: summary.previousBalanceMinor, currency: 'CNY' })
      }
      if (summary.newCreditMinor === null) {
        summary.newCreditMinor = Math.abs(amounts[1]!)
        components.push({ label: '上期已还款额 Payments', minor: summary.newCreditMinor, currency: 'CNY' })
      }
      if (summary.newDebitMinor === null) {
        summary.newDebitMinor = Math.abs(amounts[2]!)
        components.push({ label: '本期新增金额 New Charge', minor: summary.newDebitMinor, currency: 'CNY' })
      }
      if (summary.currentBalanceMinor === null) {
        summary.currentBalanceMinor = amounts[3]!
        components.push({ label: '账户账单金额 Acct. Statement Balance', minor: summary.currentBalanceMinor, currency: 'CNY' })
      }
      if (amounts.length >= 5 && summary.minimumPaymentMinor === null) {
        summary.minimumPaymentMinor = Math.abs(amounts[4]!)
        components.push({ label: '最低还款额 Acct. Min. Payment', minor: summary.minimumPaymentMinor, currency: 'CNY' })
      }
      break
    }
  }

  summary.components = components
  return summary
}

/** First amount-like cell in a row (must contain digits + decimals, no mask stars). */
function parseFirstAmount(row: string[]): { minor: number } | null {
  for (const cell of row) {
    if (cell.includes('*')) continue
    if (!/-?[\d,]+\.\d{2}/.test(cell)) continue
    const parsed = parseAmountToMinor(cell)
    if (parsed) return { minor: parsed.minor }
  }
  return null
}

/**
 * Amounts of an equation value row in document order. Masked card cells
 * (`3780-09**-****-650`) would otherwise parse as a giant integer, so any
 * cell containing `*` is skipped and currency-only cells never match.
 */
function rowAmounts(row: string[]): number[] {
  const out: number[] = []
  for (const cell of row) {
    if (cell.includes('*')) continue
    if (!/-?[\d,]+\.\d{2}/.test(cell)) continue
    const parsed = parseAmountToMinor(cell)
    if (parsed) out.push(parsed.minor)
  }
  return out
}

const CURRENCY_MAP: Record<string, string> = {
  CNY: 'CNY',
  RMB: 'CNY',
  '人民币': 'CNY',
  USD: 'USD',
  美元: 'USD',
  HKD: 'HKD',
  港币: 'HKD',
  EUR: 'EUR',
  欧元: 'EUR',
}

export function normalizeCurrency(token: string): string {
  const text = token.trim()
  if (/人民币|CNY/i.test(text)) return 'CNY'
  const upper = text.toUpperCase()
  return CURRENCY_MAP[upper] ?? (upper || 'CNY')
}

export interface CombinedAmount {
  currency: string
  /** Absolute minor units; sign is reported separately. */
  minor: number
  /** True when the cell carries an explicit `-` (credit / repayment-or-refund). */
  negative: boolean
}

/**
 * Parse a `CNY -6714.95` / `CNY 146.00` currency/amount cell. The sign rides
 * on the amount (plain positives carry no suffix), so `parseAmountToMinor`
 * alone would misread `CNY -6714.95` — the leading currency token defeats its
 * `^-` check. Split first, then read the sign from the amount part.
 */
export function parseCombinedAmount(cell: string): CombinedAmount | null {
  const text = cell.trim()
  if (!text || text === '-' || /^-+$/.test(text)) return null
  const parsed = parseAmountToMinor(text)
  if (!parsed) return null
  return {
    currency: parsed.currency ?? 'CNY',
    minor: Math.abs(parsed.minor),
    negative: parsed.negativeByFormat || parsed.minor < 0,
  }
}

export function cleanDescription(text: string): string {
  return cleanSourceDescription(text, 'citic')
}

export function extractBankToken(description: string): string {
  return extractSourceTypeToken(description)
}

function collectTransactions(doc: SourceDocument, fallbackCardLast4: string): ParsedTransaction[] {
  const transactions: ParsedTransaction[] = []
  for (const table of doc.tables) {
    for (const row of table.rows) {
      const cells = row[0] === '' && row.length > 7 ? row.slice(1) : row
      // CITIC dates are YYYYMMDD, and some layouts add a leading empty cell.
      if (cells.length >= 3 && (cells.slice(0, 2).some(cell => /^\d{8}$/.test(cell)) ||
        (cells.length >= 6 && /^\d{4}$/.test(cells[2] ?? '') && /^[A-Z]{3}\s*[-\d]/i.test(cells[5] ?? '')))) {
        const parsed = requireTransactionRow(parseRow(row, transactions.length, fallbackCardLast4), transactions.length)
        transactions.push({ ...parsed, sourceRow: transactions.length })
        continue
      }
      if (row.length <= 3 && FOOTER_MARKERS.test(row.join(' '))) continue
    }
  }
  return transactions
}

function directionFromSignedCell(negative: boolean): Direction {
  return negative ? 'credit' : 'debit'
}

function parseRow(cells: string[], rowIndex: number, fallbackCardLast4: string): ParsedTransaction | null {
  const normalized = cells[0] === '' && cells.length > 7 ? cells.slice(1) : cells
  if (normalized.length !== 7 && normalized.length !== 8) return null
  if (!/^\d{8}$/.test(normalized[0] ?? '')) return null
  if (!/^\d{4}$/.test(normalized[2] ?? '')) return null

  const transactionDate = parseDateInput((normalized[0] ?? '').trim())
  const postingDate = parseDateInput((normalized[1] ?? '').trim()) ?? transactionDate
  if (!transactionDate) return null
  const cardLast4 = normalized[2]!.trim() || fallbackCardLast4
  if (!cardLast4) return null

  const rawDescription = (normalized[4] ?? '').replace(/\s+/g, ' ').trim()
  if (!rawDescription || TXN_HEADER_CELL.test(rawDescription)) return null
  const txnSplit = requireTransactionAmount(parseCombinedAmount(normalized[5] ?? ''), rowIndex)
  const settleSplit = requireTransactionAmount(parseCombinedAmount(normalized[6] ?? ''), rowIndex)
  const primary = settleSplit

  const direction = directionFromSignedCell(primary.negative)
  assertCreditSign(txnSplit.negative, direction, rowIndex)
  const transactionCurrency = txnSplit.currency
  const transactionAmountMinor = signForDirection(txnSplit.minor, direction)
  const settlementAmountMinor = signForDirection(primary.minor, direction)

  const bankToken = extractBankToken(rawDescription)
  const classification = classifyTransactionType(bankToken, direction, settlementAmountMinor)
  const type = classification.type
  const cleaned = cleanDescription(rawDescription)
  const description = cleaned || '未识别交易'

  return {
    cardLast4,
    transactionDate,
    postingDate: postingDate ?? transactionDate,
    rawDescription,
    description,
    merchant: extractMerchant(description),
    transactionCurrency,
    transactionAmountMinor,
    settlementCurrency: primary.currency,
    settlementAmountMinor,
    type,
    typeUncertain: classification.requiresReview,
    direction,
    bankToken,
    confidence: cleaned && cleaned !== '未识别交易' ? 0.93 : 0.6,
    sourcePage: null,
    sourceRow: rowIndex,
    rawText: cells.join(' | '),
  }
}
