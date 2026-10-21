import type { IsoDate } from './dates'

export const BANKS = {
  boc: { id: 'boc', name: '中国银行', short: '中行' },
  bocom: { id: 'bocom', name: '交通银行', short: '交行' },
  icbc: { id: 'icbc', name: '工商银行', short: '工行' },
  ccb: { id: 'ccb', name: '建设银行', short: '建行' },
  abc: { id: 'abc', name: '农业银行', short: '农行' },
  citic: { id: 'citic', name: '中信银行', short: '中信' },
  unknown: { id: 'unknown', name: '未识别银行', short: '未知' },
} as const

export type BankId = keyof typeof BANKS

export function bankName(id: BankId): string {
  return BANKS[id]?.name ?? '未识别银行'
}

/**
 * Business type of a transaction. Kept independent from the signed amount so a
 * refund can never be mistaken for a purchase because of a merchant keyword.
 */
export const TRANSACTION_TYPES = [
  'purchase',
  'cash_advance',
  'refund',
  'payment',
  'cashback',
  'fee',
  'interest',
  'installment_original',
  'installment_payment',
  'adjustment',
] as const

export type TransactionType = (typeof TRANSACTION_TYPES)[number]

export const TRANSACTION_TYPE_LABELS: Record<TransactionType, string> = {
  purchase: '消费',
  cash_advance: '取现',
  refund: '退款',
  payment: '还款',
  cashback: '返现',
  fee: '手续费',
  interest: '利息',
  installment_original: '分期原始消费',
  installment_payment: '分期每期入账',
  adjustment: '其他调整',
}

/** Bank-stated debit/credit direction. Positive amount always means money leaves the card. */
export type Direction = 'debit' | 'credit'

export const CATEGORIES = [
  '未分类',
  '餐饮',
  '交通出行',
  '购物',
  '生活缴费',
  '医疗健康',
  '教育',
  '住房',
  '旅行',
  '订阅服务',
  '还款',
  '退款',
  '其他',
] as const

export type Category = (typeof CATEGORIES)[number]

export const REVIEW_FLAGS = [
  'transaction_type_unclear',
  'statement_mismatch',
  'missing_summary',
  'amount_direction_unclear',
  'description_unparsed',
  'low_confidence',
  'suspected_duplicate',
  'uncategorized',
  'amount_missing',
  'date_missing',
  'card_missing',
] as const

export type ReviewFlag = (typeof REVIEW_FLAGS)[number]

export const REVIEW_FLAG_LABELS: Record<ReviewFlag, string> = {
  transaction_type_unclear: '交易类型待确认',
  statement_mismatch: '账单对账存在差额',
  missing_summary: '缺少必要汇总信息',
  amount_direction_unclear: '借贷方向不确定',
  description_unparsed: '交易描述无法识别',
  low_confidence: '解析置信度低',
  suspected_duplicate: '疑似重复交易',
  uncategorized: '未完成分类',
  amount_missing: '金额缺失',
  date_missing: '日期缺失',
  card_missing: '卡尾号缺失',
}

export type ReviewStatus = 'ok' | 'pending' | 'confirmed' | 'rejected'

export interface Transaction {
  /** Stable identity: fingerprint + occurrence index. */
  id: string
  statementId: string
  bank: BankId
  cardLast4: string
  transactionDate: IsoDate | null
  postingDate: IsoDate | null
  /** Source-cleaned identity text. UI/export use transactionDisplayDescription; never persist that projection. */
  description: string
  /** Raw description straight from the statement, kept for traceability. */
  rawDescription: string
  transactionCurrency: string
  /** Signed minor units, positive = expense, negative = credit/refund/repayment. */
  transactionAmountMinor: number
  settlementCurrency: string
  settlementAmountMinor: number
  type: TransactionType
  direction: Direction
  category: Category
  confidence: number
  flags: ReviewFlag[]
  reviewStatus: ReviewStatus
  sourceFileName: string
  sourceFileHash: string
  sourcePage: number | null
  sourceRow: number
  rawText: string
  /** Fingerprint before the occurrence index disambiguates identical rows. */
  fingerprint: string
  occurrence: number
  isDemo: boolean
  isSynthetic?: boolean
  /**
   * Provenance of this row. Absent means a bank-parser import.
   * `legacy_import` = migrated from a historical system via a Legacy Adapter
   * (see `src/importers/`). Never set by bank parsers.
   */
  origin?: 'parser' | 'legacy_import'
  /**
   * Adapter that produced this row, e.g. `legacy-python-export-v1`.
   * Absent means a bank parser. Preserved so the source is never lost.
   */
  sourceId?: string
}

export interface NamedAmount {
  label: string
  minor: number | null
  currency: string
}

export interface StatementSummary {
  previousBalanceMinor: number | null
  /** New charges (本期新增支出 / New Spending). */
  newDebitMinor: number | null
  /** Payments and other credits (本期存入 / 还款、退货、费用返还). */
  newCreditMinor: number | null
  /** Charges / 费用. */
  chargeMinor: number | null
  /** Interest / 利息. */
  interestMinor: number | null
  /** 本期应还 / Statement Balance. */
  currentBalanceMinor: number | null
  minimumPaymentMinor: number | null
  creditLimitMinor: number | null
  dueDate: IsoDate | null
  components: NamedAmount[]
}

export type ReconciliationStatus = 'passed' | 'mismatch' | 'insufficient'
export type CheckStatus = 'passed' | 'mismatch' | 'missing' | 'skipped'

export interface ReconciliationCheck {
  id: string
  label: string
  status: CheckStatus
  expectedMinor: number | null
  actualMinor: number | null
  differenceMinor: number | null
  detail: string
}

export interface ReconciliationResult {
  status: ReconciliationStatus
  checks: ReconciliationCheck[]
  computedBalanceMinor: number | null
}

export type StatementStatus = 'reconciled' | 'needs_review' | 'failed' | 'imported'

export interface Statement {
  id: string
  /** bank + card + cycle: identifies the billing period of one card. */
  statementKey: string
  bank: BankId
  cardLast4: string
  cycleStart: IsoDate | null
  cycleEnd: IsoDate | null
  dueDate: IsoDate | null
  summary: StatementSummary
  reconciliation: ReconciliationResult
  status: StatementStatus
  parserId: string
  parserVersion: string
  transactionCount: number
  sourceFileName: string
  sourceFileHash: string
  importedAt: string
  isDemo: boolean
}

export type ImportStatus = 'parsed' | 'needs_review' | 'duplicate' | 'failed' | 'unsupported' | 'imported'

export interface ImportRecord {
  id: string
  fileName: string
  fileSize: number
  fileHash: string
  sourceType: 'pdf' | 'eml' | 'html' | 'text' | 'xlsx' | 'unknown'
  bank: BankId
  detectedBank: BankId
  cardLast4: string
  cycleStart: IsoDate | null
  cycleEnd: IsoDate | null
  status: ImportStatus
  message: string
  statementId: string | null
  transactionCount: number
  duplicateOf: string | null
  parserId: string
  importedAt: string
  isDemo: boolean
}

export interface AppSettings {
  theme: 'light' | 'dark' | 'system'
  demoMode: boolean
  locale: 'zh-CN'
}
