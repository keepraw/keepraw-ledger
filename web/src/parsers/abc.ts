import { cleanSourceDescription } from '../core/sourceDescription'
import { addDays, isIsoDate, parseDateInput, type IsoDate } from '../core/dates'
import { classifyTransactionType, extractSourceTypeToken, signForDirection } from '../core/classify'
import { parseAmountToMinor } from '../core/money'
import type { BankId, Direction, NamedAmount, StatementSummary } from '../core/types'
import { emptySummary, ParseError, requireTransactionAmount, requireTransactionRow, type BankParser, type ParsedStatement, type ParsedTransaction, type SourceDocument } from './types'

const PARSER_ID = 'abc_eml'
const PARSER_VERSION = '1.0.0'

/**
 * Agricultural Bank of China 金穗信用卡 e-mailed HTML statement.
 *
 * Direction comes from the section marker row (`● 还款/退货 = credit`,
 * `● 消费/取现 = debit`) confirmed by the settlement sign (`支出为-`),
 * never from the merchant text. Dates are compact `MMDD` and are resolved
 * against the statement cycle.
 */

const FOOTER_MARKERS = /温馨提示|安全用卡|客服热线|刷卡金余额|积分|公告|声明/
const SECTION_RE = /●\s*(还款|退货|消费|取现|费用|利息|调整|刷卡金|分期)/

export interface AbcSections {
  headerTableIndex: number
  headerRowIndex: number
}

export const abcParser: BankParser = {
  id: PARSER_ID,
  version: PARSER_VERSION,
  bank: 'abc',
  sourceTypes: ['eml', 'html'],

  match(doc) {
    const haystack = `${doc.email?.subject ?? ''}\n${doc.email?.from ?? ''}\n${doc.text.slice(0, 30000)}`
    const namesBank = /农业银行|Agricultural Bank|ABChina|农行/.test(haystack)
    const namesProduct = /金穗信用卡|电子对账单|信用卡/.test(haystack)
    const hasCycle = /账单周期|Statement Cycle|交易明细/.test(haystack)
    if (namesBank && namesProduct && hasCycle) return 1
    if (namesBank && hasCycle) return 0.8
    return 0
  },

  parse(doc) {
    if (!doc.tables.length) throw new ParseError('邮件中没有可解析的 HTML 表格', 'no_tables')
    const header = locateTxnHeader(doc)
    if (!header) throw new ParseError('未找到交易明细表头', 'no_transaction_table')

    const cycle = locateCycle(doc)
    const dueDate = locateDueDate(doc)
    const summary = parseSummary(doc, dueDate)
    const cardLast4 = locateCardLast4(doc)
    const transactions = collectTransactions(doc, cycle, cardLast4)
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
      bank: 'abc' as BankId,
      cardLast4,
      cycleStart: cycle.start,
      cycleEnd: cycle.end,
      dueDate: summary.dueDate,
      summary,
      transactions,
      confidence: cardLast4 && cycle.start && summary.currentBalanceMinor !== null ? 0.9 : 0.6,
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
    /到期还款日\s*Payment Due Date\s*(\d{4})[/.](\d{1,2})[/.](\d{1,2})/.exec(haystack) ??
    /到期还款日\D*(\d{4})[/.](\d{1,2})[/.](\d{1,2})/.exec(haystack)
  if (!match) return null
  return parseDateInput(`${match[1]}-${match[2]}-${match[3]}`)
}

export function locateCardLast4(doc: SourceDocument): string {
  const haystack = `${doc.email?.subject ?? ''}\n${doc.text}`
  const masked = /\*+\s*(\d{4})/.exec(haystack)
  if (masked) return masked[1]!
  for (const table of doc.tables) {
    for (const row of table.rows) {
      if (row.length === 6 && /^\d{4}$/.test(row[2] ?? '')) return row[2]!
    }
  }
  return ''
}

const TXN_HEADER_CELL = /交易日期|入账日期|卡号|交易描述|交易金额|入账金额/

export function locateTxnHeader(doc: SourceDocument): AbcSections | null {
  for (const table of doc.tables) {
    for (let r = 0; r < table.rows.length; r++) {
      const row = table.rows[r]!
      if (row.filter((cell) => TXN_HEADER_CELL.test(cell)).length >= 4) {
        return { headerTableIndex: table.index, headerRowIndex: r }
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
    for (const row of table.rows) {
      if (row.length === 2 && /本期应还款额/.test(row[0] ?? '')) {
        const parsed = parseAmountToMinor(row[1] ?? '')
        if (parsed && summary.currentBalanceMinor === null) {
          summary.currentBalanceMinor = parsed.minor
          components.push({ label: '本期应还款额 New Balance', minor: parsed.minor, currency: 'CNY' })
        }
      }
      if (row.length === 2 && /信用额度/.test(row[0] ?? '')) {
        const parsed = parseAmountToMinor(row[1] ?? '')
        if (parsed && summary.creditLimitMinor === null) {
          summary.creditLimitMinor = Math.abs(parsed.minor)
        }
      }
    }
  }

  const equationHeaderIndex = doc.tables.findIndex((table) =>
    table.rows.some(
      (row) =>
        row.filter((cell) => /本期应还金额|上期账单\s*应还金额|本期账单金额|本期还款/.test(cell)).length >= 3,
    ),
  )
  if (equationHeaderIndex !== -1) {
    const headerTable = doc.tables[equationHeaderIndex]!
    const headerRow = headerTable.rows.find(
      (row) => row.filter((cell) => /本期应还金额|上期账单\s*应还金额|本期账单金额|本期还款/.test(cell)).length >= 3,
    )
    const valueTable = doc.tables.slice(equationHeaderIndex + 1).find((table) =>
      table.rows.some((row) => row.filter((cell) => /-?\d+\.\d{2}/.test(cell)).length >= 3),
    )
    if (headerRow && valueTable) {
      const valueRow = valueTable.rows.find(
        (row) => row.filter((cell) => /-?\d+\.\d{2}/.test(cell)).length >= 3,
      )
      if (valueRow) {
        if (valueRow.length === headerRow.length) {
          const currentIndex = headerRow.findIndex((cell) => /本期应还金额/.test(cell))
          const previousIndex = headerRow.findIndex((cell) => /上期账单\s*应还金额/.test(cell))
          const chargeIndex = headerRow.findIndex((cell) => /本期账单金额/.test(cell))
          const paymentsIndex = headerRow.findIndex((cell) => /本期还款/.test(cell))
          const currentParsed = currentIndex !== -1 ? parseAmountToMinor(valueRow[currentIndex] ?? '') : null
          const previousParsed = previousIndex !== -1 ? parseAmountToMinor(valueRow[previousIndex] ?? '') : null
          const chargeParsed = chargeIndex !== -1 ? parseAmountToMinor(valueRow[chargeIndex] ?? '') : null
          const paymentsParsed = paymentsIndex !== -1 ? parseAmountToMinor(valueRow[paymentsIndex] ?? '') : null
          if (currentParsed && summary.currentBalanceMinor === null) {
            summary.currentBalanceMinor = currentParsed.minor
            components.push({ label: '本期应还金额 New Balance', minor: currentParsed.minor, currency: 'CNY' })
          }
          if (previousParsed && summary.previousBalanceMinor === null) {
            summary.previousBalanceMinor = previousParsed.minor
            components.push({ label: '上期账单应还金额 Previous Balance', minor: previousParsed.minor, currency: 'CNY' })
          }
          if (chargeParsed && summary.newDebitMinor === null) {
            summary.newDebitMinor = Math.abs(chargeParsed.minor)
            components.push({ label: '本期账单金额 New Charge', minor: summary.newDebitMinor, currency: 'CNY' })
          }
          if (paymentsParsed && summary.newCreditMinor === null) {
            summary.newCreditMinor = Math.abs(paymentsParsed.minor)
            components.push({ label: '本期还款、退货金额 Payments', minor: summary.newCreditMinor, currency: 'CNY' })
          }
        } else if (valueRow.length === 8) {
          // Real statements compress the 14-column header (with -/=/+ operators)
          // into 8 value columns: curr, current, deposit, previous, prevDeposit,
          // newCharge, payments, adjustment.
          // Equation: current - deposit = previous - prevDeposit + charge - payments - adjustment.
          // Store net balances so the shared reconciler holds.
          const currentParsed = parseAmountToMinor(valueRow[1] ?? '')
          const depositParsed = parseAmountToMinor(valueRow[2] ?? '')
          const previousParsed = parseAmountToMinor(valueRow[3] ?? '')
          const prevDepositParsed = parseAmountToMinor(valueRow[4] ?? '')
          const chargeParsed = parseAmountToMinor(valueRow[5] ?? '')
          const paymentsParsed = parseAmountToMinor(valueRow[6] ?? '')
          const adjustmentParsed = parseAmountToMinor(valueRow[7] ?? '')
          const deposit = depositParsed ? Math.abs(depositParsed.minor) : 0
          const prevDeposit = prevDepositParsed ? Math.abs(prevDepositParsed.minor) : 0
          const adjustment = adjustmentParsed ? Math.abs(adjustmentParsed.minor) : 0
          if (currentParsed && previousParsed && summary.currentBalanceMinor === null) {
            const netCurrent = currentParsed.minor - deposit
            const netPrevious = previousParsed.minor - prevDeposit
            summary.currentBalanceMinor = netCurrent
            summary.previousBalanceMinor = netPrevious
            components.push({ label: '本期应还金额 New Balance (net)', minor: netCurrent, currency: 'CNY' })
            components.push({ label: '上期账单应还金额 Previous Balance (net)', minor: netPrevious, currency: 'CNY' })
            if (deposit !== 0 || prevDeposit !== 0 || adjustment !== 0) {
              components.push({ label: '溢缴/调整 Deposit/Adjustment', minor: deposit + prevDeposit + adjustment, currency: 'CNY' })
            }
          } else {
            if (currentParsed && summary.currentBalanceMinor === null) {
              summary.currentBalanceMinor = currentParsed.minor
              components.push({ label: '本期应还金额 New Balance', minor: currentParsed.minor, currency: 'CNY' })
            }
            if (previousParsed && summary.previousBalanceMinor === null) {
              summary.previousBalanceMinor = previousParsed.minor
              components.push({ label: '上期账单应还金额 Previous Balance', minor: previousParsed.minor, currency: 'CNY' })
            }
          }
          if (chargeParsed && summary.newDebitMinor === null) {
            summary.newDebitMinor = Math.abs(chargeParsed.minor)
            components.push({ label: '本期账单金额 New Charge', minor: summary.newDebitMinor, currency: 'CNY' })
          }
          if (paymentsParsed && summary.newCreditMinor === null) {
            summary.newCreditMinor = Math.abs(paymentsParsed.minor)
            components.push({ label: '本期还款、退货金额 Payments', minor: summary.newCreditMinor, currency: 'CNY' })
          }
          if (adjustment !== 0) {
            components.push({ label: '本期调整金额 Adjustment', minor: adjustment, currency: 'CNY' })
          }
        }
      }
    }
    void headerRow
  }

  // Minimum payment: look for 最低还款/最低应还 nearby.
  const fullText = `${doc.text}\n${doc.tables.flatMap((t) => t.rows).map((r) => r.join(' ')).join('\n')}`
  const minimumMatch =
    /最低(?:还款额|应还)[\s\S]{0,24}?(-?[\d,]+\.\d{2})/.exec(fullText) ??
    /Min Payment[\s\S]{0,24}?(-?[\d,]+\.\d{2})/.exec(fullText)
  if (minimumMatch && summary.minimumPaymentMinor === null) {
    const parsed = parseAmountToMinor(minimumMatch[1])
    if (parsed) summary.minimumPaymentMinor = Math.abs(parsed.minor)
  }

  summary.components = components
  return summary
}

/**
 * Resolve `YYMMDD` / `MMDD` / `MM/DD` / ISO dates against the statement cycle.
 * ABC prints compact dates without separators: 4-digit `MMDD` in some
 * statements, 6-digit `YYMMDD` in others.
 */
export function resolveAbcDate(raw: string, cycle: Cycle, posting = false): IsoDate | null {
  const text = raw.trim()
  const explicit = parseDateInput(text)
  if (explicit) return explicit
  const yymmdd = /^(\d{2})(\d{2})(\d{2})$/.exec(text)
  if (yymmdd) return parseDateInput(`20${yymmdd[1]}-${yymmdd[2]}-${yymmdd[3]}`)

  const short = /^(\d{2})(\d{2})$/.exec(text) ?? /^(\d{1,2})[/.](\d{1,2})$/.exec(text)
  if (!short || !cycle.start || !cycle.end || !isIsoDate(cycle.start) || !isIsoDate(cycle.end) || cycle.start > cycle.end) return null
  // Resolve all plausible years, including a posting just after a December close.
  // A bounded seven-day posting window is evidence; nearest-date guessing is not.
  const end = posting ? addDays(cycle.end, 7) : cycle.end
  const candidates: IsoDate[] = []
  for (let year = Number(cycle.start.slice(0, 4)); year <= Number(end.slice(0, 4)); year++) {
    const candidate = parseDateInput(`${short[1]}/${short[2]}`, year)
    if (candidate && candidate >= cycle.start && candidate <= end) candidates.push(candidate)
  }
  return candidates.length === 1 ? candidates[0]! : null
}

export function cleanDescription(text: string): string {
  return cleanSourceDescription(text, 'abc')
}

export function extractBankToken(description: string): string {
  return extractSourceTypeToken(description)
}

export function directionFromSection(section: string): Direction | null {
  if (/还款|退货|退款|返现|刷卡金/.test(section)) return 'credit'
  if (/消费|取现|费用|利息|分期/.test(section)) return section.includes('还款') ? 'credit' : 'debit'
  return null
}

function collectTransactions(doc: SourceDocument, cycle: Cycle, fallbackCardLast4: string): ParsedTransaction[] {
  const transactions: ParsedTransaction[] = []
  let section: string | null = null
  let inTxnArea = false

  for (const table of doc.tables) {
    for (const row of table.rows) {
      const joined = row.join(' ')
      if (row.filter((cell) => TXN_HEADER_CELL.test(cell)).length >= 4) {
        inTxnArea = true
        section = null
        continue
      }
      if (!inTxnArea) continue
      // ABC uses MMDD (or slash dates), with section markers in separate rows.
      const candidate = row.length > 3 && (row.slice(0, 2).some(cell => /^\d{4}$|^\d{1,4}[-/.]\d/.test(cell)) ||
        (row.length >= 5 && /^\d{4}$/.test(row[2] ?? '') && /\/[A-Z]{3}/i.test(row[4] ?? '')))
      if (candidate) {
        const parsed = requireTransactionRow(row.length === 6 ? parseRow(row, section, cycle, fallbackCardLast4, transactions.length) : null, transactions.length)
        transactions.push(parsed)
        continue
      }
      if (row.length <= 3 && FOOTER_MARKERS.test(joined)) {
        inTxnArea = false
        break
      }
      const sectionMatch = SECTION_RE.exec(joined)
      if (sectionMatch && row.length <= 3) {
        section = sectionMatch[1]!
        continue
      }
    }
  }
  return transactions
}

function parseRow(
  cells: string[],
  section: string | null,
  cycle: Cycle,
  fallbackCardLast4: string,
  sourceRow: number,
): ParsedTransaction | null {
  const transactionDate = resolveAbcDate(cells[0] ?? '', cycle)
  const postingText = (cells[1] ?? '').trim()
  const postingDate = !postingText || /^[-—]+$/.test(postingText) ? transactionDate : resolveAbcDate(postingText, cycle, true)
  if (!transactionDate || !postingDate) return null
  const cardCell = (cells[2] ?? '').trim()
  const cardLast4 = /^\d{4}$/.test(cardCell) ? cardCell : fallbackCardLast4
  if (!cardLast4) return null

  const rawDescription = (cells[3] ?? '').replace(/\s+/g, ' ').trim()
  const txnSplit = requireTransactionAmount(parseSlashAmount(cells[4] ?? ''), sourceRow)
  const settleSplit = requireTransactionAmount(parseSlashAmount(cells[5] ?? ''), sourceRow)

  // Settlement convention is `支出为-`: negative = expense.
  const settleIsExpense = settleSplit.negative
  let direction: Direction | null = section ? directionFromSection(section) : null
  if (!direction) {
    direction = settleIsExpense ? 'debit' : 'credit'
  }

  const transactionAmountMinor = signForDirection(txnSplit.minor, direction)
  const settlementAmountMinor = signForDirection(settleSplit.minor, direction)

  const bankToken = extractBankToken(rawDescription)
  const classification = classifyTransactionType(bankToken || section || '', direction, settlementAmountMinor)
  let type = classification.type
  if (section && /还款/.test(section) && direction === 'credit' && type === 'payment') {
    // keep payment
  }
  if (section && /退货|退款/.test(section) && direction === 'credit' && type === 'payment') {
    type = 'refund'
  }

  const cleaned = cleanDescription(rawDescription)
  const description = cleaned || '未识别交易'

  return {
    cardLast4,
    transactionDate,
    postingDate: postingDate ?? transactionDate,
    rawDescription,
    description,
    transactionCurrency: txnSplit.currency,
    transactionAmountMinor,
    settlementCurrency: settleSplit.currency,
    settlementAmountMinor,
    type,
    typeUncertain: classification.requiresReview,
    direction,
    bankToken: bankToken || section || '',
    confidence: cleaned && cleaned !== '未识别交易' ? 0.9 : 0.6,
    sourcePage: null,
    sourceRow,
    rawText: cells.join(' | '),
  }
}

export function parseSlashAmount(cell: string): { currency: string; minor: number; negative: boolean } | null {
  const text = cell.trim()
  if (!text || text === '-' || /^-+$/.test(text)) return null
  const parts = text.split('/')
  if (parts.length > 2) return null
  const amountPart = (parts[0] ?? text).trim()
  const currencyPart = (parts[1] ?? 'CNY').trim().toUpperCase()
  const currency = currencyPart === 'RMB' ? 'CNY' : currencyPart || 'CNY'
  const parsed = parseAmountToMinor(amountPart, currency)
  if (!parsed) return null
  return { currency, minor: Math.abs(parsed.minor), negative: parsed.negativeByFormat }
}
