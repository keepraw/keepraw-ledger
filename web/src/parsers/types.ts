import type { IsoDate } from '../core/dates'
import type { BankId, Direction, StatementSummary, TransactionType } from '../core/types'

export type SourceType = 'pdf' | 'eml' | 'html' | 'text' | 'unknown'

export interface PdfTextItem {
  text: string
  /** distance from the left edge of the page */
  x: number
  /** distance from the top edge of the page */
  y: number
  width: number
  height: number
}

export interface PdfPage {
  pageNumber: number
  width: number
  height: number
  items: PdfTextItem[]
}

export interface PdfDocument {
  numPages: number
  pages: PdfPage[]
}

export interface HtmlTable {
  index: number
  rows: string[][]
}

export interface SourceDocument {
  fileName: string
  fileSize: number
  fileHash: string
  sourceType: SourceType
  pdf: PdfDocument | null
  /** Sanitized HTML: scripts, styles, images and form controls removed. */
  html: string | null
  tables: HtmlTable[]
  text: string
  email: { subject: string; from: string; date: IsoDate | null } | null
}

export interface ParsedTransaction {
  cardLast4: string
  transactionDate: IsoDate | null
  postingDate: IsoDate | null
  rawDescription: string
  description: string
  merchant: string
  transactionCurrency: string
  /** Signed minor units: positive = expense, negative = credit. */
  transactionAmountMinor: number
  settlementCurrency: string
  settlementAmountMinor: number
  type: TransactionType
  /** Missing or contradictory authoritative type evidence; persist as review, never a guess. */
  typeUncertain?: boolean
  direction: Direction
  /** The bank's own structured type token when the statement provides one. */
  bankToken: string
  confidence: number
  sourcePage: number | null
  sourceRow: number
  rawText: string
}

export interface ParsedStatement {
  bank: BankId
  cardLast4: string
  cycleStart: IsoDate | null
  cycleEnd: IsoDate | null
  dueDate: IsoDate | null
  summary: StatementSummary
  transactions: ParsedTransaction[]
  confidence: number
  parserId: string
  parserVersion: string
  warnings: string[]
}

export interface BankParser {
  id: string
  version: string
  bank: BankId
  sourceTypes: SourceType[]
  /** 0 = definitely not this bank, 1 = certain. */
  match(doc: SourceDocument): number
  parse(doc: SourceDocument): ParsedStatement
}

export class ParseError extends Error {
  constructor(
    message: string,
    readonly reason: string,
  ) {
    super(message)
    this.name = 'ParseError'
  }
}

/** A structurally recognized transaction must never vanish from a successful parse. */
export function requireTransactionRow<T>(row: T | null, rowIndex: number): T {
  if (row === null) throw new ParseError(`第 ${rowIndex + 1} 行交易行结构或交易日期无效，整份账单未导入`, 'invalid_transaction_row')
  return row
}

/** A recognized transaction must not disappear or borrow the other monetary leg. */
export function requireTransactionAmount<T>(amount: T | null, rowIndex: number): T {
  if (amount === null) {
    throw new ParseError(`第 ${rowIndex + 1} 行交易金额无效：格式、币种或精度无法安全解析，整份账单未导入`, 'invalid_transaction_amount')
  }
  return amount
}

/** For banks whose minus means credit, reject an explicit minus that would be lost. */
export function assertCreditSign(negative: boolean, direction: 'credit' | 'debit', rowIndex: number): void {
  if (negative && direction === 'debit') {
    throw new ParseError(`第 ${rowIndex + 1} 行金额符号与交易方向冲突，整份账单未导入`, 'amount_direction_conflict')
  }
}

export function emptySummary(): StatementSummary {
  return {
    previousBalanceMinor: null,
    newDebitMinor: null,
    newCreditMinor: null,
    chargeMinor: null,
    interestMinor: null,
    currentBalanceMinor: null,
    minimumPaymentMinor: null,
    creditLimitMinor: null,
    dueDate: null,
    components: [],
  }
}
