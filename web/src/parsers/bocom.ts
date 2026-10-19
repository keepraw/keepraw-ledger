import { parseDateInput, resolveShortDate } from '../core/dates'
import { extractMerchant, inferTransactionType, signForDirection } from '../core/classify'
import { parseAmountToMinor } from '../core/money'
import type { BankId, NamedAmount, StatementSummary } from '../core/types'
import { assertCreditSign, emptySummary, ParseError, requireTransactionAmount, requireTransactionRow, type BankParser, type ParsedStatement, type ParsedTransaction, type SourceDocument } from './types'

const PARSER_ID = 'bocom_eml'
const PARSER_VERSION = '2.0.0'

/**
 * Bank of Communications e-mailed HTML statement.
 *
 * Direction comes from the section the row lives in
 * (还款、退货、费用返还 = credit, 消费、取现、其他费用 = debit) and never from the
 * merchant text. Dates are `MM/DD` and are resolved against the statement cycle so a
 * cycle that crosses a year boundary is handled correctly.
 */

const CREDIT_SECTION = /还款[、,，]?\s*退货[、,，]?\s*费用返还明细/
const DEBIT_SECTION = /消费[、,，]?\s*取现[、,，]?\s*其他费用明细/
const SHORT_DATE_CELL = /^\d{1,2}\/\d{1,2}$/

const FOOTER_MARKERS = /除以上账单显示交易外|温馨提示|分期时间|风险与安全|风险提示|客服热线|温馨贴士|风险提示与安全信息/

// HTML e-mails often drop the whitespace around <br>, so the labels below tolerate
// any separator between the Chinese and the English half of each caption.
const SUMMARY_LABELS: Array<{ key: keyof StatementSummary; re: RegExp; absolute: boolean }> = [
  { key: 'currentBalanceMinor', re: /^本期应还款[\s\S]{0,24}Statement\s*Balance/i, absolute: false },
  { key: 'previousBalanceMinor', re: /^上期应还款[\s\S]{0,24}Last\s*Statement\s*Balance/i, absolute: false },
  { key: 'newCreditMinor', re: /还款[\s、,，]*退货[\s、,，]*费用返还[\s\S]{0,24}Payment/i, absolute: true },
  { key: 'newDebitMinor', re: /消费[\s、,，]*取现[\s\S]{0,24}New\s*Spending/i, absolute: true },
  { key: 'chargeMinor', re: /^费用[\s\S]{0,24}Charges/i, absolute: true },
  { key: 'interestMinor', re: /^利息[\s\S]{0,24}Interest/i, absolute: true },
]

const HEADER_CELL =
  /交易\s*日期|记账\s*日期|卡末\s*四位|交易\s*说明|交易\s*金额|入账\s*金额|Transaction Date|Posting Date|Card Number \(Last 4 digits\)|Description of Transaction|Transaction Curr\/Amt|Payment Curr\/Amt/

interface RowRef {
  tableIndex: number
  rowIndex: number
  cells: string[]
}

export interface BocomSections {
  headerRowIndex: number
  creditRows: RowRef[]
  debitRows: RowRef[]
}

export const bocomParser: BankParser = {
  id: PARSER_ID,
  version: PARSER_VERSION,
  bank: 'bocom',
  sourceTypes: ['eml', 'html'],

  match(doc) {
    const haystack = `${doc.email?.subject ?? ''}\n${doc.text.slice(0, 30000)}`
    const namesBank = /交通银行|Bank of Communications|BOCOM|bankcomm/i.test(haystack)
    const namesProduct = /个人信用卡|Pacific Credit Card|太平洋信用卡/.test(haystack)
    const hasCycle = /账单周期|Statement Cycle/i.test(haystack)
    if (namesBank && namesProduct && hasCycle) return 1
    if (namesBank && hasCycle) return 0.8
    return 0
  },

  parse(doc) {
    if (!doc.tables.length) throw new ParseError('邮件中没有可解析的 HTML 表格', 'no_tables')

    const sections = locateSections(doc)
    if (!sections) throw new ParseError('未找到交易明细表头', 'no_transaction_table')

    const cycle = locateCycle(doc)
    const summary = parseSummary(doc)
    const fallbackYear = cycle.end ? Number(cycle.end.slice(0, 4)) : undefined
    const transactions = collectTransactions(doc, sections, cycle, fallbackYear)
    if (transactions.length === 0) {
      throw new ParseError('未在账单中找到交易明细行', 'no_transactions_found')
    }

    const cardLast4 = locateCardLast4(doc, sections)
    const plans = locateInstallmentPlans(doc)
    const warnings: string[] = []
    if (!cardLast4) warnings.push('missing_card_last4')
    if (!cycle.start || !cycle.end) warnings.push('missing_statement_period')
    if (summary.currentBalanceMinor === null) warnings.push('missing_current_balance')
    if (summary.previousBalanceMinor === null) warnings.push('missing_previous_balance')
    if (summary.newDebitMinor === null) warnings.push('missing_new_debit')
    if (summary.newCreditMinor === null) warnings.push('missing_new_credit')
    if (plans.length > 0) warnings.push(`installment_plans:${plans.length}`)

    return {
      bank: 'bocom' as BankId,
      cardLast4,
      cycleStart: cycle.start,
      cycleEnd: cycle.end,
      dueDate: summary.dueDate,
      summary,
      transactions: markInstallmentOriginals(transactions, plans),
      confidence: cardLast4 && cycle.start && summary.currentBalanceMinor !== null ? 0.93 : 0.65,
      parserId: PARSER_ID,
      parserVersion: PARSER_VERSION,
      warnings,
    } satisfies ParsedStatement
  },
}

/**
 * Installment plans printed by the bank (`分期时间 / 分期产品描述 / 剩余本金 / 剩余期数`).
 *
 * They are the structural evidence needed to tell an original installment purchase
 * apart from the per-cycle posting: the original row carries the plan's total amount
 * and mentions the plan product, while the per-cycle row carries the bank's explicit
 * `分期扣款` token.
 */
export interface InstallmentPlan {
  product: string
  totalMinor: number | null
  remainingMinor: number | null
  remainingCount: number | null
  totalCount: number | null
}

const INSTALLMENT_HEADER_CELL = /分期\s*时间|分期\s*产品描述|剩余本金|剩余期数|剩余利息/
const COUNT_CELL = /^(\d+)\s*\/\s*(\d+)$/

export function locateInstallmentPlans(doc: SourceDocument): InstallmentPlan[] {
  const plans: InstallmentPlan[] = []
  for (const table of doc.tables) {
    const headerIndex = table.rows.findIndex((row) => row.filter((cell) => INSTALLMENT_HEADER_CELL.test(cell)).length >= 2)
    if (headerIndex === -1) continue
    for (let i = headerIndex + 1; i < table.rows.length; i++) {
      const row = table.rows[i]!
      if (row.length < 4) break
      if (!/^\d{4}-\d{1,2}-\d{1,2}$/.test(row[0] ?? '')) break
      const ratio = row.find((cell) => COUNT_CELL.test(cell))
      const amounts = row.filter((cell) => /^\s*[\u00a5¥$￥]?[\d,]+\.\d{2}\s*\/\s*[\u00a5¥$￥]?[\d,]+\.\d{2}/.test(cell))
      const principal = amounts[0] ?? ''
      const count = ratio ? COUNT_CELL.exec(ratio) : null
      plans.push({
        product: row[1] ?? '',
        totalMinor: parseRatioAmount(principal, 1),
        remainingMinor: parseRatioAmount(principal, 0),
        remainingCount: count ? Number(count[1]) : null,
        totalCount: count ? Number(count[2]) : null,
      })
    }
    if (plans.length) break
  }
  return plans
}

function parseRatioAmount(cell: string, index: number): number | null {
  const parts = cell.split('/')
  if (parts.length <= index) return null
  const parsed = parseAmountToMinor(parts[index]!)
  return parsed ? parsed.minor : null
}

/**
 * Tag the original installment purchase. The bank counts only the per-cycle posting
 * in 新增消费, so adding both rows would double count the spending.
 */
export function markInstallmentOriginals(
  transactions: ParsedTransaction[],
  plans: InstallmentPlan[],
): ParsedTransaction[] {
  if (plans.length === 0) return transactions
  return transactions.map((tx) => {
    if (tx.type !== 'purchase') return tx
    const plan = plans.find(
      (candidate) =>
        candidate.totalMinor !== null &&
        candidate.totalMinor === tx.transactionAmountMinor &&
        candidate.product.length > 0 &&
        tx.description.includes(candidate.product),
    )
    if (!plan) return tx
    return { ...tx, type: 'installment_original' as const, bankToken: `${tx.bankToken}|installment_original` }
  })
}

function flattenRows(doc: SourceDocument): RowRef[] {
  const rows: RowRef[] = []
  for (const table of doc.tables) {
    table.rows.forEach((cells, rowIndex) => {
      rows.push({ tableIndex: table.index, rowIndex, cells })
    })
  }
  return rows
}

function countDateCells(cells: string[]): number {
  return cells.filter((cell) => SHORT_DATE_CELL.test(cell)).length
}

function countHeaderCells(cells: string[]): number {
  return cells.filter((cell) => HEADER_CELL.test(cell)).length
}

/**
/**
 * Locate the two transaction sections with a single forward pass.
 *
 * Both the 还款 section and the 消费 section repeat the same table header, so the
 * section is tracked as state: the explicit 还款/退货 marker switches to credit and
 * the next header row switches back to debit. Direction therefore comes from the
 * statement structure, never from the merchant text.
 */
export function locateSections(doc: SourceDocument): BocomSections | null {
  const rows = flattenRows(doc)
  const creditRows: RowRef[] = []
  const debitRows: RowRef[] = []
  let section: 'credit' | 'debit' | null = null
  let headerRowIndex = -1
  let headerCount = 0
  let headerTableIndex = -1

  rows.forEach((ref, index) => {
    const text = ref.cells.join(' ')
    // Dates in transaction rows outrank words in their merchant descriptions.
    if (section !== null && (countDateCells(ref.cells) > 0 ||
      (ref.cells.some(cell => /^\d{4}$/.test(cell)) && ref.cells.filter(cell => /^[A-Z]{3}\s*[-\d]/i.test(cell)).length === 2))) {
      if (section === 'credit') creditRows.push(ref)
      else debitRows.push(ref)
      return
    }
    if (ref.cells.length <= 3 && CREDIT_SECTION.test(text)) {
      section = 'credit'
      return
    }
    if (ref.cells.length <= 3 && DEBIT_SECTION.test(text)) {
      section = 'debit'
      return
    }
    if (countHeaderCells(ref.cells) >= 5) {
      if (headerRowIndex === -1) headerRowIndex = index
      headerCount += 1
      // The first header row belongs to the section named right above it; a repeated
      // header row means the statement moved on to the 消费 section.
      if (headerCount > 1 && ref.tableIndex !== headerTableIndex) section = 'debit'
      else if (section === null) section = 'debit'
      headerTableIndex = ref.tableIndex
      return
    }
    if (ref.cells.length <= 3 && FOOTER_MARKERS.test(text)) {
      section = null
      return
    }
    if (section === null || countDateCells(ref.cells) < 2) return
    if (section === 'credit') creditRows.push(ref)
    else debitRows.push(ref)
  })

  if (headerRowIndex === -1) return null
  if (creditRows.length === 0 && debitRows.length === 0) return null
  return { headerRowIndex, creditRows, debitRows }
}

export interface Cycle {
  start: string | null
  end: string | null
}

const CYCLE_LABELLED =
  /账单周期\s*(?:Statement Cycle)?\s*[|｜]?\s*(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\s*[-–—~至到]\s*(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/
const CYCLE_BARE = /(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\s*[-–—~至到]\s*(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/

export function locateCycle(doc: SourceDocument): Cycle {
  const haystack = `${doc.email?.subject ?? ''}\n${doc.text}\n${doc.tables
    .flatMap((table) => table.rows)
    .map((row) => row.join(' '))
    .join('\n')}`
  const match = CYCLE_LABELLED.exec(haystack) ?? CYCLE_BARE.exec(haystack)
  if (!match) return { start: null, end: null }
  return {
    start: parseDateInput(`${match[1]}-${match[2]}-${match[3]}`),
    end: parseDateInput(`${match[4]}-${match[5]}-${match[6]}`),
  }
}

export function locateCardLast4(doc: SourceDocument, sections: BocomSections | null): string {
  const haystack = `${doc.email?.subject ?? ''}\n${doc.text}`
  const masked = /(\d{4,6})\s*\*{2,}\s*(\d{4})/.exec(haystack)
  if (masked) return masked[2]!
  const rows = sections ? [...sections.creditRows, ...sections.debitRows] : []
  for (const ref of rows) {
    for (const cell of ref.cells) {
      if (/^\d{4}$/.test(cell)) return cell
    }
  }
  return ''
}

function locateDueDate(doc: SourceDocument): string | null {
  for (const table of doc.tables) {
    for (const row of table.rows) {
      const index = row.findIndex((cell) => /^到期还款日/.test(cell))
      if (index === -1) continue
      const match = /(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(row.slice(index + 1).join(' '))
      if (match) return parseDateInput(`${match[1]}-${match[2]}-${match[3]}`)
    }
  }
  return null
}

function parseSummary(doc: SourceDocument): StatementSummary {
  const summary = emptySummary()
  const components: NamedAmount[] = []

  // --- Overview: 到期还款日 / 本期应还款 / 最低应还款 / 信用额度 ---
  for (const table of doc.tables) {
    for (const row of table.rows) {
      const dueIndex = row.findIndex((cell) => /^到期还款日/.test(cell))
      if (dueIndex !== -1 && summary.dueDate === null) {
        summary.dueDate = locateDueDate(doc)
      }
      const balanceIndex = row.findIndex((cell) => /^本期应还款/.test(cell) && cell.length <= 12)
      if (balanceIndex !== -1 && summary.currentBalanceMinor === null) {
        const parsed = parseAmountToMinor(row[balanceIndex + 1] ?? '')
        if (parsed) {
          summary.currentBalanceMinor = parsed.minor
          components.push({ label: '本期应还款 Statement Balance', minor: parsed.minor, currency: 'CNY' })
        }
      }
      const minimumIndex = row.findIndex((cell) => /^最低应还款/.test(cell))
      if (minimumIndex !== -1 && summary.minimumPaymentMinor === null) {
        const parsed = parseAmountToMinor(row[minimumIndex + 1] ?? '')
        if (parsed) {
          summary.minimumPaymentMinor = parsed.minor
          components.push({ label: '最低应还款 Minimum Payment Due', minor: parsed.minor, currency: 'CNY' })
        }
      }
      const limitIndex = row.findIndex((cell) => /信用额度\s*Credit Limit/.test(cell))
      if (limitIndex !== -1 && summary.creditLimitMinor === null) {
        const parsed = parseAmountToMinor(row[limitIndex + 1] ?? '')
        if (parsed) summary.creditLimitMinor = parsed.minor
      }
    }
  }

  // --- Summary equation block: 本期应还款 = 上期应还款 - 还款 + 消费 + 费用 + 利息 ---
  for (const table of doc.tables) {
    const labelRowIndex = table.rows.findIndex((row) => SUMMARY_LABELS.every((spec) => row.some((cell) => spec.re.test(cell))))
    if (labelRowIndex === -1) continue
    const labelRow = table.rows[labelRowIndex]!
    const valueRow = table.rows[labelRowIndex + 1]
    if (!valueRow) break

    const columns: Array<{ key: keyof StatementSummary; absolute: boolean; index: number; label: string }> = []
    labelRow.forEach((cell, index) => {
      for (const spec of SUMMARY_LABELS) {
        if (spec.re.test(cell)) {
          columns.push({ key: spec.key, absolute: spec.absolute, index, label: cell })
          break
        }
      }
    })

    for (const column of columns) {
      const valueCell = valueRow[column.index] ?? ''
      if (!valueCell || valueCell === '-' || /^-+$/.test(valueCell)) continue
      const parsed = parseAmountToMinor(valueCell)
      if (!parsed) continue
      const minor = column.absolute ? Math.abs(parsed.minor) : parsed.minor
      const current = summary[column.key]
      if (current === null || current === undefined) {
        (summary[column.key] as number) = minor
      }
      components.push({ label: column.label, minor, currency: 'CNY' })
    }
    break
  }

  summary.components = components
  return summary
}

function collectTransactions(
  doc: SourceDocument,
  sections: BocomSections,
  cycle: Cycle,
  fallbackYear: number | undefined,
): ParsedTransaction[] {
  const transactions: ParsedTransaction[] = []
  const add = (refs: RowRef[], direction: 'credit' | 'debit'): void => {
    for (const ref of refs) {
      const parsed = requireTransactionRow(parseRow(ref, direction, cycle, fallbackYear), ref.rowIndex)
      transactions.push({ ...parsed, sourceRow: transactions.length })
    }
  }
  add(sections.creditRows, 'credit')
  add(sections.debitRows, 'debit')
  void doc
  return transactions
}

function parseRow(
  ref: RowRef,
  direction: 'credit' | 'debit',
  cycle: Cycle,
  fallbackYear: number | undefined,
): ParsedTransaction | null {
  const cells = ref.cells
  const dateIndexes = cells.map((cell, index) => (SHORT_DATE_CELL.test(cell) ? index : -1)).filter((index) => index >= 0)
  if (dateIndexes.length < 2) return null

  const transactionDate = resolveShortDate(cells[dateIndexes[0]!]!, cycle.start, cycle.end, fallbackYear)
  const postingDate = resolveShortDate(cells[dateIndexes[1]!]!, cycle.start, cycle.end, fallbackYear)
  if (!transactionDate) return null

  const cardIndex = cells.findIndex((cell, index) => index > dateIndexes[1]! && /^\d{4}$/.test(cell))
  if (cardIndex === -1) return null
  const cardLast4 = cardIndex === -1 ? '' : cells[cardIndex]!

  const amountIndexes = cells
    .map((cell, index) => (/^(?:[A-Za-z]{3}(?=\s|[-+(\d])|[¥￥$])/.test(cell.trim()) ? index : -1))
    .filter((index) => index >= 0 && index !== cardIndex && (cardIndex < 0 || index > cardIndex + 1))
  if (amountIndexes.length !== 2) requireTransactionAmount(null, ref.rowIndex)

  const transactionParsed = requireTransactionAmount(parseCurrencyAmount(cells[amountIndexes[0]!]!), ref.rowIndex)
  const settlementParsed = requireTransactionAmount(parseCurrencyAmount(cells[amountIndexes[1]!]!), ref.rowIndex)
  assertCreditSign(transactionParsed.minor < 0 || settlementParsed.minor < 0, direction, ref.rowIndex)

  const skip = new Set<number>([...dateIndexes, cardIndex, ...amountIndexes])
  const rawDescription = cells
    .map((cell, index) => (skip.has(index) ? '' : cell))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()

  const bankToken = extractBankToken(rawDescription)
  const type = inferTransactionType(bankToken, rawDescription.slice(bankToken.length).trim(), direction)
  const description = rawDescription || '未识别交易'

  return {
    cardLast4,
    transactionDate,
    postingDate: postingDate ?? transactionDate,
    rawDescription,
    description,
    merchant: extractMerchant(description),
    transactionCurrency: transactionParsed.currency,
    transactionAmountMinor: signForDirection(transactionParsed.minor, direction),
    settlementCurrency: settlementParsed.currency,
    settlementAmountMinor: signForDirection(settlementParsed.minor, direction),
    type,
    direction,
    bankToken,
    confidence: 0.93,
    sourcePage: null,
    sourceRow: ref.rowIndex,
    rawText: cells.join(' | '),
  }
}

const BANK_TOKEN_RE =
  /^(分期利息|分期手续费|分期扣款|每期入账|商户分期|信用卡还款|转账还款|还款|退货|退款|退汇|刷卡金|返现|费用返还|取现|预借现金|消费|购物|支付|利息|手续费|年费|服务费|违约金|调整|冲正|其他)/

export function extractBankToken(description: string): string {
  const match = BANK_TOKEN_RE.exec(description.trim())
  return match ? match[1]! : ''
}

interface CurrencyAmount {
  currency: string
  minor: number
}

const CURRENCY_MAP: Record<string, string> = {
  CNY: 'CNY',
  RMB: 'CNY',
  CHN: 'CNY',
  USD: 'USD',
  HKD: 'HKD',
  EUR: 'EUR',
  '¥': 'CNY',
  '￥': 'CNY',
  $: 'USD',
}

const AMOUNT_CELL_RE = /^([A-Za-z]{3}(?=\s|[-+(\d])|[¥￥$])/i

export function parseCurrencyAmount(cell: string): CurrencyAmount | null {
  const text = cell.trim()
  if (!text) return null
  const match = AMOUNT_CELL_RE.exec(text)
  if (!match) return null
  const raw = match[1]!.toUpperCase()
  const currency = CURRENCY_MAP[raw] ?? raw
  const parsed = parseAmountToMinor(text, currency)
  if (!parsed) return null
  return { currency, minor: parsed.minor }
}
