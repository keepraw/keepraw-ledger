import { transactionDisplayDescription } from '../core/descriptionNormalizer'
/**
 * CSV export.
 *
 * Amounts are written from integer minor units, never from floats, and every text
 * field is escaped. Cells that start with `= + - @` are prefixed with a quote so a
 * spreadsheet cannot execute statement text as a formula.
 */

import { minorToDecimalString } from '../core/money'
import { TRANSACTION_TYPE_LABELS, bankName, type Transaction } from '../core/types'

export const EXPORT_COLUMNS = [
  { key: 'bank', header: '银行' },
  { key: 'cardLast4', header: '卡尾号' },
  { key: 'transactionDate', header: '交易日' },
  { key: 'postingDate', header: '入账日' },
  { key: 'description', header: '交易描述' },
  { key: 'transactionCurrency', header: '交易币种' },
  { key: 'transactionAmountMinor', header: '交易金额' },
  { key: 'settlementCurrency', header: '入账币种' },
  { key: 'settlementAmountMinor', header: '入账金额' },
  { key: 'type', header: '交易类型' },
  { key: 'direction', header: '借贷方向' },
  { key: 'category', header: '分类' },
  { key: 'reviewStatus', header: '复核状态' },
  { key: 'sourceFileName', header: '来源文件' },
  { key: 'sourceFileHash', header: '文件指纹' },
  { key: 'sourcePage', header: '来源页' },
  { key: 'rawText', header: '原始片段' },
  { key: 'id', header: '交易标识' },
  { key: 'fingerprint', header: '业务指纹' },
  { key: 'occurrence', header: '重复序号' },
  { key: 'rawDescription', header: '原始描述' },
] as const

export function escapeCsvCell(value: string): string {
  let text = value ?? ''
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`
  if (/[",\n\r]/.test(text)) text = `"${text.replace(/"/g, '""')}"`
  return text
}

export function transactionToRow(transaction: Transaction): string[] {
  return [
    bankName(transaction.bank),
    transaction.cardLast4,
    transaction.transactionDate ?? '',
    transaction.postingDate ?? '',
    transactionDisplayDescription(transaction),
    transaction.transactionCurrency,
    minorToDecimalString(transaction.transactionAmountMinor, transaction.transactionCurrency),
    transaction.settlementCurrency,
    minorToDecimalString(transaction.settlementAmountMinor, transaction.settlementCurrency),
    TRANSACTION_TYPE_LABELS[transaction.type],
    transaction.direction === 'debit' ? '借' : '贷',
    transaction.category,
    transaction.reviewStatus,
    transaction.sourceFileName,
    transaction.sourceFileHash,
    transaction.sourcePage === null ? '' : String(transaction.sourcePage),
    transaction.rawText,
    transaction.id,
    transaction.fingerprint,
    String(transaction.occurrence),
    transaction.rawDescription,
  ]
}

export function buildCsv(transactions: Transaction[]): string {
  const header = EXPORT_COLUMNS.map((column) => escapeCsvCell(column.header)).join(',')
  const body = transactions.map((transaction) => transactionToRow(transaction).map(escapeCsvCell).join(','))
  return [header, ...body].join('\r\n')
}

/** UTF-8 BOM keeps Excel from mangling Chinese text on Windows. */
export function downloadCsv(fileName: string, transactions: Transaction[]): void {
  const blob = new Blob([`\uFEFF${buildCsv(transactions)}`], { type: 'text/csv;charset=utf-8' })
  triggerDownload(blob, fileName)
}

export async function downloadXlsx(fileName: string, transactions: Transaction[]): Promise<void> {
  const XLSX = await import('xlsx')
  const sheet = XLSX.utils.aoa_to_sheet([
    [...EXPORT_COLUMNS.map((column) => column.header)],
    ...transactions.map((transaction) => transactionToRow(transaction)),
  ])
  sheet['!cols'] = EXPORT_COLUMNS.map((column) => ({ wch: Math.max(10, column.header.length * 2) }))
  const book = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(book, sheet, '交易明细')
  const buffer = XLSX.write(book, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer
  triggerDownload(new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), fileName)
}

export function triggerDownload(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
