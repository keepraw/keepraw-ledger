/**
 * Integer minor-unit money handling.
 *
 * Financial amounts are NEVER accumulated as JavaScript floats in this project.
 * Every amount is stored as an integer number of minor units (fen / cent / sen).
 * Parsing goes string -> integer digits, so no rounding error is introduced at
 * any point of the pipeline.
 */

export type CurrencyCode = string

/** Normalize supported aliases without assigning a currency to unknown text. */
const CURRENCY_ALIASES: Record<string, string> = {
  RMB: 'CNY', CHN: 'CNY', 人民币: 'CNY', '￥': 'CNY', '¥': 'CNY',
  美元: 'USD', '$': 'USD', 港币: 'HKD', 港元: 'HKD', 欧元: 'EUR', '€': 'EUR',
  日元: 'JPY', 英镑: 'GBP', '£': 'GBP',
}

export function normalizeCurrencyCode(currency: string): string {
  const text = currency.trim().toUpperCase()
  return CURRENCY_ALIASES[text] ?? text
}

/** Decimal places used by a currency. */
const CURRENCY_EXPONENT: Record<string, number> = {
  CNY: 2,
  RMB: 2,
  USD: 2,
  HKD: 2,
  EUR: 2,
  GBP: 2,
  SGD: 2,
  AUD: 2,
  CAD: 2,
  CHF: 2,
  TRY: 2,
  MYR: 2,
  PHP: 2,
  IDR: 2,
  JPY: 0,
  KRW: 0,
  VND: 0,
}

export function currencyExponent(currency: string): number {
  return CURRENCY_EXPONENT[normalizeCurrencyCode(currency || 'CNY')] ?? 2
}

/** Historical adapters must not guess the exponent of an unfamiliar currency. */
export function isSupportedCurrency(currency: string): boolean {
  return Object.hasOwn(CURRENCY_EXPONENT, normalizeCurrencyCode(currency))
}

/** Convert minor units back to a plain decimal string (no float math involved). */
export function minorToDecimalString(minor: number, currency = 'CNY'): string {
  const exp = currencyExponent(currency)
  const negative = minor < 0
  const digits = Math.abs(Math.trunc(minor)).toString()
  let out: string
  if (exp === 0) {
    out = digits
  } else {
    const padded = digits.padStart(exp + 1, '0')
    out = `${padded.slice(0, padded.length - exp)}.${padded.slice(padded.length - exp)}`
  }
  return negative ? `-${out}` : out
}

/** Human readable amount, e.g. `-1,410.00`. */
export function formatMinor(minor: number, currency = 'CNY', options: { sign?: boolean } = {}): string {
  const exp = currencyExponent(currency)
  const negative = minor < 0
  const digits = Math.abs(Math.trunc(minor)).toString()
  let intPart: string
  let fracPart = ''
  if (exp === 0) {
    intPart = digits
  } else {
    const padded = digits.padStart(exp + 1, '0')
    intPart = padded.slice(0, padded.length - exp)
    fracPart = padded.slice(padded.length - exp)
  }
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const body = fracPart ? `${grouped}.${fracPart}` : grouped
  const sign = negative ? '-' : options.sign === true ? '+' : ''
  return `${sign}${body}`
}

export interface ParsedAmount {
  /** Signed integer minor units. */
  minor: number
  /** Explicit sign discovered in the source text (parentheses, leading/trailing -, /C). */
  negativeByFormat: boolean
  /** Currency token detected next to the number, when present. */
  currency?: string
}

const CURRENCY_PREFIX = /^(人民币|美元|港币|港元|欧元|日元|英镑|[￥¥$€£]|[A-Z]{3}(?=\s|[-+(\d]))\s*/i
const CURRENCY_SUFFIX = /\s*\/?\s*(人民币|美元|港币|港元|欧元|日元|英镑|[￥¥$€£]|[A-Z]{3})$/i

/**
 * Parse a numeric Excel cell or bank-provided amount string into signed minor units.
 *
 * Recognised formats: `1,234.56`, `1234.56`, `-1234.56`, `1234.56-`, `(1234.56)`,
 * `1234.56/C`, `1234.56CR`, `CNY 1234.56`, `&yen;6512.48`.
 * Returns `null` for unsupported cell types or invalid amounts.
 */
export function parseAmountToMinor(raw: unknown, fallbackCurrency?: string): ParsedAmount | null {
  if (typeof raw !== 'number' && typeof raw !== 'string') return null
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return null
    const currency = normalizeCurrencyCode(fallbackCurrency ?? 'CNY')
    if (!isSupportedCurrency(currency)) throw new Error(`尚未定义币种 ${currency} 的货币精度，拒绝猜测金额`)
    const scaled = raw * 10 ** currencyExponent(currency)
    const asInt = Math.round(scaled)
    if (!Number.isSafeInteger(asInt)) return null
    if (Math.abs(scaled - asInt) > 1e-6) return null
    return { minor: asInt, negativeByFormat: raw < 0 }
  }

  let text = raw.trim().replace(/&yen;/gi, '¥').replace(/[−–—]/g, '-')
  if (!text) return null

  let currency: string | undefined
  const prefix = CURRENCY_PREFIX.exec(text)
  if (prefix) {
    currency = normalizeCurrencyCode(prefix[1]!)
    text = text.slice(prefix[0].length).trim()
  }
  // Bank credit/debit suffixes are parsed before an optional currency suffix.
  const bankSign = /(?:\/\s*([CD])|(CR|DR))$/i.exec(text)
  if (bankSign) text = text.slice(0, bankSign.index).trim()
  const suffix = CURRENCY_SUFFIX.exec(text)
  if (suffix) {
    const code = normalizeCurrencyCode(suffix[1]!)
    if (currency && currency !== code) return null
    currency = code
    text = text.slice(0, suffix.index).trim()
  }
  const expectedCurrency = fallbackCurrency === undefined ? undefined : normalizeCurrencyCode(fallbackCurrency)
  if (currency && expectedCurrency && currency !== expectedCurrency) return null
  const effectiveCurrency = currency ?? expectedCurrency ?? 'CNY'
  if (!isSupportedCurrency(effectiveCurrency)) throw new Error(`尚未定义币种 ${effectiveCurrency} 的货币精度，拒绝猜测金额`)
  if (text.endsWith('元') && effectiveCurrency === 'CNY') text = text.slice(0, -1).trim()
  const parenthesized = /^\((.*)\)$/.exec(text)
  const leadingSign = /^[+-]/.exec(text)
  const trailingMinus = text.endsWith('-')
  if (Number(!!parenthesized) + Number(!!leadingSign) + Number(trailingMinus) > 1) return null
  const amountNegative = !!parenthesized || leadingSign?.[0] === '-' || trailingMinus
  const bankCredit = /^(C|CR)$/i.test(bankSign?.[1] ?? bankSign?.[2] ?? '')
  if (bankSign && !bankCredit && amountNegative) return null
  if (bankCredit && leadingSign?.[0] === '+') return null
  const negativeByFormat = amountNegative || bankCredit
  if (parenthesized) text = parenthesized[1]!
  else if (leadingSign) text = text.slice(1)
  else if (trailingMinus) text = text.slice(0, -1)

  // Only a decimal point and complete three-digit comma groups are accepted.
  // Never remove arbitrary text or malformed separators to manufacture money.
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(text)) return null
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text.replace(/,/g, ''))
  if (!match) return null
  const integerPart = match[1] ?? '0'
  let fractionPart = match[2] ?? ''

  const exp = currencyExponent(effectiveCurrency)
  // Banks may format integer currencies as 100.00. Only zero fractional
  // digits may be discarded; 100.50 JPY remains invalid.
  if (exp === 0 && /^0*$/.test(fractionPart)) fractionPart = ''
  if (fractionPart.length > exp) {
    // More precision than the currency supports: refuse instead of rounding silently.
    return null
  }
  const scaledFraction = fractionPart.padEnd(exp, '0')
  const minor = Number(`${integerPart}${scaledFraction}`)
  if (!Number.isSafeInteger(minor)) return null

  return {
    minor: negativeByFormat ? -minor : minor,
    negativeByFormat,
    ...(currency ? { currency } : {}),
  }
}

/** Minor units -> integer yuan-style amount for tests/debugging only. */
export function minorToNumber(minor: number): number {
  return minor / 100
}

export function sumMinor(values: number[]): number {
  let total = 0
  for (const value of values) {
    if (!Number.isSafeInteger(value)) {
      throw new Error(`Non-integer minor unit encountered: ${value}`)
    }
    total += value
  }
  if (!Number.isSafeInteger(total)) throw new Error('Amount overflow while summing')
  return total
}
