import { parseDateInput } from '../core/dates'
import { extractMerchant, classifyTransactionType, extractSourceTypeToken, signForDirection } from '../core/classify'
import { parseAmountToMinor } from '../core/money'
import type { BankId, Direction, NamedAmount, StatementSummary } from '../core/types'
import { assertCreditSign, emptySummary, ParseError, requireTransactionAmount, requireTransactionRow, type BankParser, type ParsedStatement, type ParsedTransaction, type SourceDocument } from './types'

const PARSER_ID = 'ccb_eml'
const PARSER_VERSION = '1.0.0'

/**
 * China Construction Bank e-mailed HTML statement.
 *
 * Direction comes from the signed amount cells (`-` prefix = credit /
 * repayment, per the bank's own 说明) and never from the merchant text.
 * Currency and amount arrive in separate cells (`CURR | AMT`), unlike ABC/ICBC.
 */

const FOOTER_MARKERS = /结束|The End|用卡小贴士|利息收费标准|违约金|安全用卡|在线客服|客服热线/
const ENGLISH_HEADER = /T-Date|P-Date|Card Number|Description|Trans\.Curr|Sett\.Curr/

export interface CcbTxnTable {
  tableIndex: number
  headerRowIndex: number
}

export const ccbParser: BankParser = {
  id: PARSER_ID,
  version: PARSER_VERSION,
  bank: 'ccb',
  sourceTypes: ['eml', 'html'],

  match(doc) {
    const haystack = `${doc.email?.subject ?? ''}\n${doc.email?.from ?? ''}\n${doc.text.slice(0, 30000)}`
    const namesBank = /建设银行|China Construction Bank|\bCCB\b/.test(haystack)
    const namesProduct = /龙卡信用卡|信用卡电子账单|信用卡账户/.test(haystack)
    const hasCycle = /账单周期|Statement Cycle|交易明细/.test(haystack)
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
    const transactions = collectTransactions(doc, txnTable, cardLast4)
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
      bank: 'ccb' as BankId,
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

const CYCLE_LABELLED =
  /账单周期\s*Statement Cycle\s*(\d{4})[/.](\d{1,2})[/.](\d{1,2})\s*[-–—~至到]\s*(\d{4})[/.](\d{1,2})[/.](\d{1,2})/
const CYCLE_BARE = /(\d{4})[/.](\d{1,2})[/.](\d{1,2})\s*[-–—~至到]\s*(\d{4})[/.](\d{1,2})[/.](\d{1,2})/

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

export function locateDueDate(doc: SourceDocument): string | null {
  const haystack = `${doc.text}\n${doc.tables.flatMap((t) => t.rows).map((r) => r.join(' ')).join('\n')}`
  const match =
    /本期到期还款日\s*Payment Due Date\s*(\d{4})[/.](\d{1,2})[/.](\d{1,2})/.exec(haystack) ??
    /到期还款日\D*(\d{4})[/.](\d{1,2})[/.](\d{1,2})/.exec(haystack)
  if (!match) return null
  return parseDateInput(`${match[1]}-${match[2]}-${match[3]}`)
}

export function locateCardLast4(doc: SourceDocument): string {
  for (const table of doc.tables) {
    for (const row of table.rows) {
      const joined = row.join(' ')
      if (/信用卡卡号/.test(joined)) {
        for (const cell of row) {
          const masked = /\*+\s*(\d{4})/.exec(cell)
          if (masked) return masked[1]!
        }
      }
    }
  }
  const haystack = `${doc.email?.subject ?? ''}\n${doc.text}`
  const masked = /\*+\s*(\d{4})/.exec(haystack)
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

const TXN_HEADER_CELL = /交易日|银行记账日|卡号后四位|交易描述|交易币|结算币/

export function locateTxnTable(doc: SourceDocument): CcbTxnTable | null {
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
        row.filter((cell) => /上期全部应还款额|消费\/取现\/其它费用|还款\/退货\/费用返还|本期全部应还款额/.test(cell))
          .length >= 3,
    )
    if (headerIndex === -1) continue
    for (let i = headerIndex + 1; i < table.rows.length; i++) {
      const row = table.rows[i]!
      if (row.length < 5) continue
      if (!/人民币|CNY/.test(row[0] ?? '')) continue
      const prev = parseAmountToMinor(row[1] ?? '')
      const debit = parseAmountToMinor(row[2] ?? '')
      const credit = parseAmountToMinor(row[3] ?? '')
      const current = parseAmountToMinor(row[4] ?? '')
      if (prev && summary.previousBalanceMinor === null) {
        summary.previousBalanceMinor = Math.abs(prev.minor)
        components.push({ label: '上期全部应还款额 Last Statement Balance', minor: summary.previousBalanceMinor, currency: 'CNY' })
      }
      if (debit && summary.newDebitMinor === null) {
        summary.newDebitMinor = Math.abs(debit.minor)
        components.push({ label: '消费/取现/其它费用 New Spending', minor: summary.newDebitMinor, currency: 'CNY' })
      }
      if (credit && summary.newCreditMinor === null) {
        summary.newCreditMinor = Math.abs(credit.minor)
        components.push({ label: '还款/退货/费用返还 Payment/Credit', minor: summary.newCreditMinor, currency: 'CNY' })
      }
      if (current && summary.currentBalanceMinor === null) {
        summary.currentBalanceMinor = current.negativeByFormat ? -Math.abs(current.minor) : Math.abs(current.minor)
        components.push({ label: '本期全部应还款额 New Balance', minor: summary.currentBalanceMinor, currency: 'CNY' })
      }
      break
    }
    if (summary.previousBalanceMinor !== null) break
  }

  for (const table of doc.tables) {
    for (const row of table.rows) {
      const minimumIndex = row.findIndex((cell) => /最低还款额/.test(cell) && cell.length < 30)
      if (minimumIndex !== -1) {
        const next = table.rows[table.rows.indexOf(row) + 1]
        if (next) {
          const currencyIndex = row.findIndex((cell) => /账户币种/.test(cell))
          void currencyIndex
          const valueIndex = minimumIndex
          const parsed = parseAmountToMinor(next[valueIndex + 1] ?? next[valueIndex] ?? '')
          if (parsed && summary.minimumPaymentMinor === null) {
            summary.minimumPaymentMinor = Math.abs(parsed.minor)
            components.push({ label: '最低还款额 Min.Payment', minor: summary.minimumPaymentMinor, currency: 'CNY' })
          }
        }
      }
    }
  }

  // Fallback: 人民币 row of the 4-col 账单信息 table.
  for (const table of doc.tables) {
    const headerIndex = table.rows.findIndex(
      (row) => row.filter((cell) => /账户币种|本期全部应还款额|最低还款额/.test(cell)).length >= 3,
    )
    if (headerIndex === -1) continue
    const header = table.rows[headerIndex]!
    const balanceIndex = header.findIndex((cell) => /本期全部应还款额/.test(cell))
    const minimumIndex = header.findIndex((cell) => /最低还款额/.test(cell))
    const valueRow = table.rows[headerIndex + 1]
    if (!valueRow || !/人民币|CNY/.test(valueRow[0] ?? '')) continue
    if (balanceIndex !== -1 && summary.currentBalanceMinor === null) {
      const parsed = parseAmountToMinor(valueRow[balanceIndex] ?? '')
      if (parsed) summary.currentBalanceMinor = Math.abs(parsed.minor)
    }
    if (minimumIndex !== -1 && summary.minimumPaymentMinor === null) {
      const parsed = parseAmountToMinor(valueRow[minimumIndex] ?? '')
      if (parsed) summary.minimumPaymentMinor = Math.abs(parsed.minor)
    }
  }

  summary.components = components
  return summary
}

const CURRENCY_MAP: Record<string, string> = {
  CNY: 'CNY',
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

export function cleanDescription(text: string): string {
  let value = (text ?? '').replace(/[\u00a0\u3000]/g, ' ').replace(/\s+/g, ' ').trim()
  value = value.replace(/\s*\/\s*$/, '').trim()
  return value
}

export function extractBankToken(description: string): string {
  return extractSourceTypeToken(description)
}

function collectTransactions(
  doc: SourceDocument,
  located: CcbTxnTable,
  fallbackCardLast4: string,
): ParsedTransaction[] {
  const table = doc.tables.find((entry) => entry.index === located.tableIndex)
  if (!table) return []
  const transactions: ParsedTransaction[] = []
  for (let i = located.headerRowIndex + 1; i < table.rows.length; i++) {
    const cells = table.rows[i]!
    const joined = cells.join(' ')
    // CCB dates occupy the first two columns. Handle candidates before text.
    const candidate = cells.slice(0, 2).some(cell => /^\d{4}[-/.]?\d/.test(cell)) ||
      (cells.length >= 6 && /^\d{4}$/.test(cells[2] ?? ''))
    if (candidate) {
      const parsed = requireTransactionRow(cells.length === 8 ? parseEightColRow(cells, i, fallbackCardLast4)
        : cells.length === 6 ? parseSixColRow(cells, i, fallbackCardLast4) : null, i)
      transactions.push({ ...parsed, sourceRow: transactions.length })
      continue
    }
    if (cells.length <= 2 && FOOTER_MARKERS.test(joined)) break
    if (cells.filter(cell => ENGLISH_HEADER.test(cell) || TXN_HEADER_CELL.test(cell)).length >= 5) continue
    if (cells.length === 1) continue
    if (cells.length === 3 && /\[.*账户\]|上期账单余额|Previous Balance/.test(joined)) continue
  }
  return transactions
}

function parseEightColRow(cells: string[], rowIndex: number, fallbackCardLast4: string): ParsedTransaction | null {
  const transactionDate = parseDateInput((cells[0] ?? '').trim())
  const postingDate = parseDateInput((cells[1] ?? '').trim()) ?? transactionDate
  if (!transactionDate) return null
  const cardCell = (cells[2] ?? '').trim()
  const cardLast4 = /^\d{4}$/.test(cardCell) ? cardCell : fallbackCardLast4
  if (!cardLast4) return null

  const rawDescription = (cells[3] ?? '').replace(/\s+/g, ' ').trim()
  const txnCurrency = normalizeCurrency(cells[4] ?? '')
  const txnParsed = requireTransactionAmount(parseAmountToMinor(cells[5] ?? '', txnCurrency), rowIndex)
  const settleCurrency = normalizeCurrency(cells[6] ?? '')
  const settleParsed = requireTransactionAmount(parseAmountToMinor(cells[7] ?? '', settleCurrency), rowIndex)

  const direction: Direction = settleParsed.negativeByFormat ? 'credit' : 'debit'
  assertCreditSign(txnParsed.negativeByFormat, direction, rowIndex)
  const transactionAmountMinor = signForDirection(txnParsed.minor, direction)
  const settlementAmountMinor = signForDirection(settleParsed.minor, direction)

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
    transactionCurrency: txnCurrency,
    transactionAmountMinor,
    settlementCurrency: settleCurrency,
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

function parseSixColRow(cells: string[], rowIndex: number, fallbackCardLast4: string): ParsedTransaction | null {
  const transactionDate = parseDateInput((cells[0] ?? '').trim())
  const postingDate = parseDateInput((cells[1] ?? '').trim()) ?? transactionDate
  if (!transactionDate) return null
  const cardCell = (cells[2] ?? '').trim()
  const cardLast4 = /^\d{4}$/.test(cardCell) ? cardCell : fallbackCardLast4
  if (!cardLast4) return null
  const rawDescription = (cells[3] ?? '').replace(/\s+/g, ' ').trim()
  const txnSplit = requireTransactionAmount(parseCombinedAmount(cells[4] ?? ''), rowIndex)
  const settleSplit = requireTransactionAmount(parseCombinedAmount(cells[5] ?? ''), rowIndex)
  const direction: Direction = settleSplit.negative ? 'credit' : 'debit'
  assertCreditSign(txnSplit.negative, direction, rowIndex)
  const transactionAmountMinor = signForDirection(txnSplit.minor, direction)
  const settlementAmountMinor = signForDirection(settleSplit.minor, direction)
  const bankToken = extractBankToken(rawDescription)
  const classification = classifyTransactionType(bankToken, direction, settlementAmountMinor)
  const type = classification.type
  const cleaned = cleanDescription(rawDescription)
  return {
    cardLast4,
    transactionDate,
    postingDate: postingDate ?? transactionDate,
    rawDescription,
    description: cleaned || '未识别交易',
    merchant: extractMerchant(cleaned || rawDescription),
    transactionCurrency: txnSplit.currency,
    transactionAmountMinor,
    settlementCurrency: settleSplit.currency,
    settlementAmountMinor,
    type,
    typeUncertain: classification.requiresReview,
    direction,
    bankToken,
    confidence: 0.85,
    sourcePage: null,
    sourceRow: rowIndex,
    rawText: cells.join(' | '),
  }
}

export function parseCombinedAmount(cell: string): { currency: string; minor: number; negative: boolean } | null {
  const text = cell.trim()
  if (!text || text === '-' || /^-+$/.test(text)) return null
  const parts = text.split('/')
  if (parts.length > 2) return null
  if (parts.length === 2) {
    const amountPart = parts[0]!.trim()
    const currencyPart = parts[1]!.trim()
    const parsed = parseAmountToMinor(amountPart, normalizeCurrency(currencyPart))
    if (!parsed) return null
    return { currency: normalizeCurrency(currencyPart), minor: Math.abs(parsed.minor), negative: parsed.negativeByFormat }
  }
  const parsed = parseAmountToMinor(text)
  if (!parsed) return null
  return { currency: parsed.currency ?? 'CNY', minor: Math.abs(parsed.minor), negative: parsed.negativeByFormat }
}
