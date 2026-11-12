import * as XLSX from 'xlsx'
import { transactionFingerprint } from '../../src/core/identity'
import { transactionId } from '../../src/core/dedupe'
import type { Transaction } from '../../src/core/types'

// Independent frozen contract, intentionally not imported from the adapter/exporter.
export const NATIVE_HEADERS = ['银行', '卡尾号', '交易日', '入账日', '交易描述', '交易币种', '交易金额',
  '入账币种', '入账金额', '交易类型', '借贷方向', '分类', '复核状态', '来源文件', '文件指纹',
  '来源页', '原始片段', '交易标识', '业务指纹', '重复序号']

export function nativeTransaction(occurrence = 1, changes: Partial<Transaction> = {}): Transaction {
  const fields = { bank: 'boc' as const, cardLast4: '0012', transactionDate: '2024-01-05', postingDate: '2024-01-06',
    description: 'Synthetic Store', rawDescription: 'Synthetic Store', transactionCurrency: 'USD', transactionAmountMinor: 1234,
    settlementCurrency: 'HKD', settlementAmountMinor: 9625, type: 'purchase' as const, direction: 'debit' as const, ...changes }
  const fingerprint = transactionFingerprint(fields)
  return { statementId: 'synthetic-statement', category: '购物', confidence: 0.97, flags: ['uncategorized'],
    reviewStatus: 'confirmed', sourceFileName: 'synthetic-original.eml', sourceFileHash: 'synthetic-source-hash',
    sourcePage: 3, sourceRow: 45, rawText: 'Synthetic source fragment\nsecond line', isDemo: false,
    ...fields, fingerprint, occurrence, id: transactionId(fingerprint, occurrence) }
}

export function nativeCells(occurrence = 1): unknown[] {
  const tx = nativeTransaction(occurrence)
  return ['中国银行', '0012', '2024-01-05', '2024-01-06', 'Synthetic Store', 'USD', '12.34', 'HKD', '96.25',
    '消费', '借', '购物', 'confirmed', 'synthetic-original.eml', 'synthetic-source-hash', '3',
    'Synthetic source fragment\nsecond line', tx.id, tx.fingerprint, String(occurrence)]
}

// Display text retained by old exports can change if normalized a second time.
export const NATIVE_DISPLAY_CASES = [
  ['消费 支付宝-联东U谷餐厅', '支付宝-联东U谷餐厅'],
  ['消费 支付宝-上海拉扎斯信息科技有限公司', '支付宝-上海拉扎斯信息科技有限公司'],
  ['网上消费 财付通，合成商户', '财付通-合成商户'],
] as const

export function nativeDisplayCells(description: string = NATIVE_DISPLAY_CASES[0][0], occurrence = 1): unknown[] {
  const tx = nativeTransaction(occurrence, { description, rawDescription: description })
  const row = nativeCells(occurrence)
  row[4] = description
  row[17] = tx.id
  row[18] = tx.fingerprint
  return row
}

export function nativeWorkbook(rows = [nativeCells(1), nativeCells(3)], headers = NATIVE_HEADERS): ArrayBuffer {
  const book = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([headers, ...rows]), '交易明细')
  return XLSX.write(book, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer
}
