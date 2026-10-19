import { parseDateInput } from '../core/dates'
import { extractMerchant, classifyTransactionType, signForDirection } from '../core/classify'
import { parseAmountToMinor } from '../core/money'
import type { BankId, Direction, NamedAmount, StatementSummary } from '../core/types'
import { assertCreditSign, emptySummary, ParseError, requireTransactionAmount, requireTransactionRow, type BankParser, type ParsedStatement, type ParsedTransaction, type SourceDocument } from './types'

const PARSER_ID = 'icbc_eml'
const PARSER_VERSION = '1.0.0'

/**
 * Industrial and Commercial Bank of China e-mailed HTML statement (GBK).
 *
 * Direction comes from the 记账金额 suffix `(存入 = credit, 支出 = debit)` and
 * never from the merchant text. The 交易类型 column is the bank's structured
 * type token used for `inferTransactionType`.
 */

const FOOTER_MARKERS = /温馨提示|工银i豆|服务热线|网站www|余额.*豆|联名版信息/

export interface IcbcTxnTable {
  tableIndex: number
  headerRowIndex: number
}

export const icbcParser: BankParser = {
  id: PARSER_ID,
  version: PARSER_VERSION,
  bank: 'icbc',
  sourceTypes: ['eml', 'html'],

  match(doc) {
    const haystack = `${doc.email?.subject ?? ''}\n${doc.email?.from ?? ''}\n${doc.text.slice(0, 30000)}`
    const namesBank = /工商银行|ICBC|Peony Card|牡丹/.test(haystack)
    const namesProduct = /客户对账单|Bank Statement|信用卡|贷记卡/.test(haystack)
    const hasCycle = /账单周期|交易明细|Statement/.test(haystack)
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
    const transactions = collectTransactions(doc, txnTable, cardLast4 || '')
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
      bank: 'icbc' as BankId,
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

const CYCLE_CN =
  /账单周期\s*(\d{4})年(\d{1,2})月(\d{1,2})日\s*[—–\-~至到]\s*(\d{4})年(\d{1,2})月(\d{1,2})日/
const CYCLE_SLASH =
  /账单周期[\s\S]{0,24}?(\d{4})[/.](\d{1,2})[/.](\d{1,2})\s*[-–—~至到]\s*(\d{4})[/.](\d{1,2})[/.](\d{1,2})/
const CYCLE_BARE = /(\d{4})[/.](\d{1,2})[/.](\d{1,2})\s*[-–—~至到]\s*(\d{4})[/.](\d{1,2})[/.](\d{1,2})/

export function locateCycle(doc: SourceDocument): Cycle {
  const haystack = `${doc.email?.subject ?? ''}\n${doc.text}\n${doc.tables
    .flatMap((table) => table.rows)
    .map((row) => row.join(' '))
    .join('\n')}`
  const match = CYCLE_CN.exec(haystack) ?? CYCLE_SLASH.exec(haystack) ?? CYCLE_BARE.exec(haystack)
  if (!match) return { start: null, end: null }
  return {
    start: parseDateInput(`${match[1]}-${match[2]}-${match[3]}`),
    end: parseDateInput(`${match[4]}-${match[5]}-${match[6]}`),
  }
}

export function locateDueDate(doc: SourceDocument): string | null {
  const haystack = `${doc.text}\n${doc.tables.flatMap((t) => t.rows).map((r) => r.join(' ')).join('\n')}`
  let match = /贷记卡到期还款日\D*(\d{4})年(\d{1,2})月(\d{1,2})日/.exec(haystack)
  if (match) return parseDateInput(`${match[1]}-${match[2]}-${match[3]}`)
  match = /到期还款日\D*(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(haystack)
  if (match) return parseDateInput(`${match[1]}-${match[2]}-${match[3]}`)
  return null
}

export function locateCardLast4(doc: SourceDocument): string {
  for (const table of doc.tables) {
    const headerIndex = table.rows.findIndex(
      (row) =>
        row.filter((cell) => /卡号后四位|币种|应还款额|最低还款额|信用额度/.test(cell)).length >= 3,
    )
    if (headerIndex === -1) continue
    for (let i = headerIndex + 1; i < table.rows.length; i++) {
      const row = table.rows[i]!
      if (row.length === 0) continue
      const first = row[0] ?? ''
      const m = /(\d{4})/.exec(first)
      if (m && !/^合计$/.test(first)) return m[1]!
    }
  }
  for (const table of doc.tables) {
    for (const row of table.rows) {
      if (row.length === 7 && /^\d{4}$/.test(row[0] ?? '')) return row[0]!
    }
  }
  const masked = /(\d{4})\s*[（(]牡丹/.exec(doc.text)
  if (masked) return masked[1]!
  return ''
}

const TXN_HEADER_CELL = /卡号后四位|交易日|记账日|交易类型|商户名称|交易金额|记账金额/

export function locateTxnTable(doc: SourceDocument): IcbcTxnTable | null {
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
  const summary = emptySummary()
  const components: NamedAmount[] = []
  summary.dueDate = dueDate

  for (const table of doc.tables) {
    const headerIndex = table.rows.findIndex(
      (row) =>
        row.filter((cell) => /卡号后四位|币种|应还款额|最低还款额|信用额度/.test(cell)).length >= 4,
    )
    if (headerIndex === -1) continue
    const header = table.rows[headerIndex]!
    const currencyIndex = header.findIndex((cell) => /^币种$/.test(cell))
    const currentIndex = header.findIndex((cell) => /^应还款额$/.test(cell))
    const minimumIndex = header.findIndex((cell) => /^最低还款额$/.test(cell))
    const limitIndex = header.findIndex((cell) => /^信用额度$/.test(cell))
    for (let i = headerIndex + 1; i < table.rows.length; i++) {
      const row = table.rows[i]!
      if (row.length < header.length) continue
      const currency = currencyIndex !== -1 ? (row[currencyIndex] ?? '') : ''
      if (!/人民币|本位币|CNY|RMB/.test(currency)) continue
      if (/^合计$/.test(row[0] ?? '') && summary.currentBalanceMinor !== null) continue
      if (currentIndex !== -1 && summary.currentBalanceMinor === null) {
        const parsed = parseAmountToMinor(row[currentIndex] ?? '')
        if (parsed) {
          summary.currentBalanceMinor = Math.abs(parsed.minor)
          components.push({ label: '应还款额', minor: summary.currentBalanceMinor, currency: 'CNY' })
        }
      }
      if (minimumIndex !== -1 && summary.minimumPaymentMinor === null) {
        const parsed = parseAmountToMinor(row[minimumIndex] ?? '')
        if (parsed) {
          summary.minimumPaymentMinor = Math.abs(parsed.minor)
          components.push({ label: '最低还款额', minor: summary.minimumPaymentMinor, currency: 'CNY' })
        }
      }
      if (limitIndex !== -1 && summary.creditLimitMinor === null) {
        const parsed = parseAmountToMinor(row[limitIndex] ?? '')
        if (parsed) summary.creditLimitMinor = Math.abs(parsed.minor)
      }
      if (summary.currentBalanceMinor !== null) break
    }
  }

  for (const table of doc.tables) {
    const headerIndex = table.rows.findIndex(
      (row) =>
        row.filter((cell) => /卡号后四位|上期余额|本期收入|本期支出|本期余额/.test(cell)).length >= 4,
    )
    if (headerIndex === -1) continue
    const header = table.rows[headerIndex]!
    const prevIndex = header.findIndex((cell) => /^上期余额$/.test(cell))
    const incomeIndex = header.findIndex((cell) => /^本期收入$/.test(cell))
    const outgoIndex = header.findIndex((cell) => /^本期支出$/.test(cell))
    const balanceIndex = header.findIndex((cell) => /^本期余额$/.test(cell))
    for (let i = headerIndex + 1; i < table.rows.length; i++) {
      const row = table.rows[i]!
      if (row.length === 1) continue
      if (row.length < 4) continue
      if (/^合计$/.test(row[0] ?? '') && summary.previousBalanceMinor !== null) continue
      const parsedPrev = prevIndex !== -1 ? parseAmountToMinor(row[prevIndex] ?? '') : null
      const parsedIncome = incomeIndex !== -1 ? parseAmountToMinor(row[incomeIndex] ?? '') : null
      const parsedOutgo = outgoIndex !== -1 ? parseAmountToMinor(row[outgoIndex] ?? '') : null
      const parsedBalance = balanceIndex !== -1 ? parseAmountToMinor(row[balanceIndex] ?? '') : null
      if (!parsedPrev && !parsedIncome && !parsedOutgo && !parsedBalance) continue
      if (parsedPrev && summary.previousBalanceMinor === null) {
        summary.previousBalanceMinor = Math.abs(parsedPrev.minor)
        components.push({ label: '上期余额', minor: summary.previousBalanceMinor, currency: 'CNY' })
      }
      if (parsedIncome && summary.newCreditMinor === null) {
        summary.newCreditMinor = Math.abs(parsedIncome.minor)
        components.push({ label: '本期收入', minor: summary.newCreditMinor, currency: 'CNY' })
      }
      if (parsedOutgo && summary.newDebitMinor === null) {
        summary.newDebitMinor = Math.abs(parsedOutgo.minor)
        components.push({ label: '本期支出', minor: summary.newDebitMinor, currency: 'CNY' })
      }
      if (parsedBalance) {
        const balance = Math.abs(parsedBalance.minor)
        if (summary.currentBalanceMinor === null) {
          summary.currentBalanceMinor = balance
          components.push({ label: '本期余额', minor: balance, currency: 'CNY' })
        }
      }
      break
    }
    if (summary.previousBalanceMinor !== null) break
  }

  summary.components = components
  return summary
}

export interface SplitAmount {
  currency: string
  minor: number
  direction: Direction | null
}

const CURRENCY_MAP: Record<string, string> = {
  RMB: 'CNY',
  CNY: 'CNY',
  '人民币': 'CNY',
  USD: 'USD',
  美元: 'USD',
  HKD: 'HKD',
  港币: 'HKD',
  EUR: 'EUR',
  欧元: 'EUR',
}

export function parseSplitAmount(cell: string): SplitAmount | null {
  const text = cell.trim()
  if (!text || text === '/' || text === '-' || /^-+$/.test(text)) return null
  let direction: Direction | null = null
  if (/[（(]\s*存入\s*[）)]/.test(text)) direction = 'credit'
  else if (/[（(]\s*支出\s*[）)]/.test(text)) direction = 'debit'
  const withoutSuffix = text.replace(/\s*[（(]\s*(存入|支出)\s*[）)]\s*$/, '').trim()
  const parts = withoutSuffix.split('/')
  if (parts.length > 2) return null
  const amountPart = (parts[0] ?? '').trim()
  const currencyPart = (parts[1] ?? 'CNY').trim().toUpperCase()
  const currency = CURRENCY_MAP[currencyPart] ?? (currencyPart || 'CNY')
  const parsed = parseAmountToMinor(amountPart, currency)
  if (!parsed) return null
  return { currency, minor: parsed.minor, direction }
}

const CREDIT_TYPE_TOKENS = /^(退款|退货|刷卡金|返现|还款|存入|贷方|调整|冲正)/
const DEBIT_TYPE_TOKENS = /^(消费|取现|预借现金|转账扣款|手续费|年费|服务费|利息|透支利息|违约金)/

export function directionFromTypeToken(token: string): Direction | null {
  const text = token.trim()
  if (!text) return null
  if (CREDIT_TYPE_TOKENS.test(text)) return 'credit'
  if (DEBIT_TYPE_TOKENS.test(text)) return 'debit'
  if (/^转账/.test(text)) return null
  return null
}

/**
 * Description cleanup: collapse whitespace, strip a single trailing slash
 * (`财付通 /` → `财付通`) while keeping internal slashes. `rawDescription`
 * is never overwritten by this function.
 */
export function cleanDescription(text: string): string {
  let value = (text ?? '').replace(/[\u00a0\u3000]/g, ' ').replace(/\s+/g, ' ').trim()
  value = value.replace(/\s*\/\s*$/, '').trim()
  return value
}

function collectTransactions(
  doc: SourceDocument,
  located: IcbcTxnTable,
  fallbackCardLast4: string,
): ParsedTransaction[] {
  const table = doc.tables.find((entry) => entry.index === located.tableIndex)
  if (!table) return []
  const transactions: ParsedTransaction[] = []
  for (let i = located.headerRowIndex + 1; i < table.rows.length; i++) {
    const cells = table.rows[i]!
    // ICBC puts the card first, dates second/third and a separate type fourth.
    if (cells.slice(1, 3).some(cell => /^\d{4}[-/.]?\d/.test(cell)) ||
      (cells.length >= 6 && /^\d{4}$/.test(cells[0] ?? '') && /\/[A-Z]{3}/i.test(cells[5] ?? ''))) {
      const parsed = requireTransactionRow(cells.length === 7 ? parseRow(cells, i, fallbackCardLast4) : null, i)
      transactions.push({ ...parsed, sourceRow: transactions.length })
      continue
    }
    if (cells.length === 1) {
      if (FOOTER_MARKERS.test(cells[0] ?? '')) break
      continue
    }
  }
  return transactions
}

function parseRow(cells: string[], rowIndex: number, fallbackCardLast4: string): ParsedTransaction | null {
  const cardCell = (cells[0] ?? '').trim()
  const cardLast4 = /^\d{4}$/.test(cardCell) ? cardCell : fallbackCardLast4
  if (!cardLast4) return null
  const transactionDate = parseDateInput((cells[1] ?? '').trim())
  const postingDate = parseDateInput((cells[2] ?? '').trim()) ?? transactionDate
  if (!transactionDate) return null

  const bankToken = (cells[3] ?? '').trim()
  const rawDescription = (cells[4] ?? '').replace(/\s+/g, ' ').trim()
  const txnSplit = requireTransactionAmount(parseSplitAmount(cells[5] ?? ''), rowIndex)
  const settleSplit = requireTransactionAmount(parseSplitAmount(cells[6] ?? ''), rowIndex)
  const primary = settleSplit

  let direction: Direction | null = primary.direction ?? (primary.minor < 0 ? 'credit' : null) ?? directionFromTypeToken(bankToken)
  if (!direction) {
    direction = 'debit'
  }

  assertCreditSign(txnSplit.minor < 0 || settleSplit.minor < 0, direction, rowIndex)
  const txnCurrency = txnSplit.currency
  const txnMinor = signForDirection(txnSplit.minor, direction)
  const settleCurrency = settleSplit.currency
  const settleMinor = signForDirection(primary.minor, direction)

  const cleaned = cleanDescription(rawDescription)
  const classification = classifyTransactionType(bankToken, direction, settleMinor)
  const type = classification.type
  const description = cleaned || '未识别交易'

  return {
    cardLast4,
    transactionDate,
    postingDate: postingDate ?? transactionDate,
    rawDescription,
    description,
    merchant: extractMerchant(description),
    transactionCurrency: txnCurrency,
    transactionAmountMinor: txnMinor,
    settlementCurrency: settleCurrency,
    settlementAmountMinor: settleMinor,
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
