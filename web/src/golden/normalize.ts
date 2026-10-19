/**
 * Golden normalization adapter (Task A-3.4).
 *
 * Converts already-parsed statements into golden/v1. Imports parsers and core
 * helpers read-only; changes nothing about them.
 */

import { normalizeDescription, transactionFingerprint } from '../core/identity'
import type { ParsedStatement, ParsedTransaction } from '../parsers/types'
import { GOLDEN_GENERATOR_WEB, GOLDEN_SCHEMA, type Direction, type GoldenStatement, type NormalizedTransaction } from './schema'

/** 32-bit FNV-1a hex. Must stay identical to `golden.py::fnv1a32`. */
export function fnv1a32(text: string): string {
  let digest = 0x811c9dc5
  const bytes = new TextEncoder().encode(text)
  for (const byte of bytes) {
    digest ^= byte
    digest = Math.imul(digest, 0x01000193) >>> 0
  }
  return digest.toString(16).padStart(8, '0')
}

/**
 * Leading structural tokens kept verbatim (same list and order as the Python
 * adapter so longest-prefix matching behaves identically).
 */
export const KNOWN_PREFIXES = [
  '网上消费退货',
  '网上消费',
  '手机银行',
  '按卡转账还款',
  '跨行二维码支付',
  '转账还款',
  '信用卡还款',
  '自助还款',
  '网上还款',
  '分期扣款',
  '分期利息',
  '分期手续费',
  '每期入账',
  '分期入账',
  '商户分期',
  '银联入账',
  '银联转账',
  '网银转账',
  '网银在线',
  '卡卡转账',
  '刷卡金',
  '预借现金',
  '消费',
  '取现',
  '还款',
  '退货',
  '退款',
  '退汇',
  '返现',
  '返还',
  '利息',
  '手续费',
  '年费',
  '服务费',
  '违约金',
  '调整',
  '冲正',
  '转账',
  '存入',
  '支出',
  '贷方',
  '借记',
  '贷记',
] as const

// Raw debug text has no reliable boundary between names, account identifiers
// and merchant prose. The helper returns only complete financial token pairs
// and ISO dates; shareable statements omit source debug text altogether.
const CURRENCY_TOKEN = '(?:CNY|RMB|USD|HKD|EUR|JPY|GBP|AUD|CAD|SGD|CHF)'
const DECIMAL_TOKEN = '[+-]?(?:\\d{1,3}(?:,\\d{3})+|\\d{1,12})\\.\\d{2}'
const RAW_FINANCIAL_TOKENS = new RegExp(
  `(?<![\\p{L}\\p{N}_])(?:${CURRENCY_TOKEN}\\s*${DECIMAL_TOKEN}|${DECIMAL_TOKEN}\\s*[/ ]\\s*${CURRENCY_TOKEN}|(?:19|20)\\d{2}-\\d{2}-\\d{2})(?![\\p{L}\\p{N}_])`, 'gu',
)
const BANK_IDS = new Set(['boc', 'icbc', 'abc', 'ccb', 'bocom', 'citic'])
const PARSER_IDS = new Set(['boc_pdf', 'icbc_eml', 'abc_eml', 'ccb_eml', 'bocom_eml', 'citic_eml'])
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

function requireSafeScope(valid: boolean): void {
  if (!valid) throw new Error('Golden structural field is invalid; no shareable output can be generated.')
}

function safeCard(value: string): boolean { return value === '' || /^\d{4}$/.test(value) }
function safeDate(value: string | null): boolean { return value === null || value === '' || ISO_DATE.test(value) }

function splitPrefix(description: string): [string, string] {
  for (const prefix of KNOWN_PREFIXES) {
    if (description.startsWith(prefix)) return [prefix, description.slice(prefix.length).trim()]
  }
  return ['', description.trim()]
}

/** Keep structural prefix; hash the remainder so distinct merchants stay distinct. */
export function desensitizeDescription(description: string): string {
  const text = (description ?? '').replace(/\u00a0/g, ' ').trim().replace(/\s*\/\s*$/, '').trim()
  if (!text) return text
  const [prefix, rest] = splitPrefix(text)
  if (!rest) return prefix
  const key = rest.replace(/\s+/g, ' ').trim()
  const placeholder = /^商户_[0-9a-f]{8}$/.test(key) ? key : `商户_${fnv1a32(key)}`
  return prefix ? `${prefix} ${placeholder}` : placeholder
}

/** Financial-only debug projection; no free-form CJK/Latin/digit allow-through. */
export function desensitizeRawText(rawText: string): string {
  return [...(rawText ?? '').matchAll(RAW_FINANCIAL_TOKENS)]
    .map(match => match[0].replace(/\s+/g, ' ')).join(' | ')
}

export function directionForMinor(minor: number): Direction {
  return minor < 0 ? 'credit' : 'debit'
}

export function normalizeWebTransaction(
  tx: ParsedTransaction,
  fingerprint: string,
  statementKey: string,
  seq: number,
  options: { desensitize?: boolean; bank?: string } = {},
): NormalizedTransaction {
  const desensitize = options.desensitize ?? true
  if (desensitize) {
    requireSafeScope((!options.bank || BANK_IDS.has(options.bank)) && safeCard(tx.cardLast4 ?? '') &&
      safeDate(tx.transactionDate) && safeDate(tx.postingDate) && /^[A-Za-z]{3}$/.test(tx.settlementCurrency) &&
      (fingerprint === '' || /^[0-9a-f]{16}(?:#[1-9]\d*)?$/.test(fingerprint)) &&
      /^(?:boc|icbc|abc|ccb|bocom|citic):(?:\d{4})?:(?:\d{4}-\d{2}-\d{2})?:(?:\d{4}-\d{2}-\d{2})?$/.test(statementKey))
    const expected = transactionFingerprint({ bank: options.bank ?? '', cardLast4: tx.cardLast4 || statementKey.split(':')[1] || '????',
      transactionDate: tx.transactionDate, postingDate: tx.postingDate, settlementCurrency: tx.settlementCurrency,
      settlementAmountMinor: tx.settlementAmountMinor, type: tx.type, description: tx.description })
    // A 16-digit card number also looks like hex. Only a genuine computed
    // fingerprint may pass, never arbitrary caller-supplied source identifiers.
    requireSafeScope(Number.isSafeInteger(tx.settlementAmountMinor) && (fingerprint === '' || fingerprint.split('#')[0] === expected) &&
      Number.isSafeInteger(seq) && [tx.sourcePage, tx.sourceRow].every(value => value === null || Number.isSafeInteger(value)))
  }
  const description = desensitize ? desensitizeDescription(tx.description) : tx.description
  return {
    bank: options.bank ?? '',
    cardLast4: tx.cardLast4 ?? '',
    transactionDate: tx.transactionDate ?? '',
    postingDate: tx.postingDate ?? tx.transactionDate ?? '',
    amountMinor: tx.settlementAmountMinor,
    currency: (tx.settlementCurrency || 'CNY').toUpperCase(),
    direction: directionForMinor(tx.settlementAmountMinor),
    description,
    normalizedDescription: normalizeDescription(description),
    rawText: desensitize ? '' : tx.rawText,
    sourcePosition: { row: seq, page: tx.sourcePage, sourceRow: tx.sourceRow },
    nativeId: fingerprint,
    statementKey,
  }
}

export function normalizeWebStatement(
  statement: ParsedStatement,
  fingerprints: string[],
  options: { desensitize?: boolean } = {},
): GoldenStatement {
  if (options.desensitize ?? true) {
    requireSafeScope(BANK_IDS.has(statement.bank) && PARSER_IDS.has(statement.parserId) &&
      safeCard(statement.cardLast4 ?? '') && safeDate(statement.cycleStart) && safeDate(statement.cycleEnd))
  }
  const key = `${statement.bank}:${statement.cardLast4}:${statement.cycleStart ?? ''}:${statement.cycleEnd ?? ''}`
  const transactions = statement.transactions.map((tx, index) =>
    normalizeWebTransaction(tx, fingerprints[index] ?? '', key, index, { desensitize: options.desensitize, bank: statement.bank }),
  )
  return {
    schema: GOLDEN_SCHEMA,
    origin: 'web',
    generator: GOLDEN_GENERATOR_WEB,
    bank: statement.bank,
    bankNative: statement.bank,
    cardLast4: statement.cardLast4 ?? '',
    cycleStart: statement.cycleStart,
    cycleEnd: statement.cycleEnd,
    parserName: statement.parserId,
    desensitized: options.desensitize ?? true,
    nativeIds: { transactionAlgo: 'fnv1a-dual-lane', occurrence: 'fingerprint#N' },
    transactionCount: transactions.length,
    transactions,
  }
}
