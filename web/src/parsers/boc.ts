import { cleanSourceDescription } from '../core/sourceDescription'
import { addDays, addMonths, parseDateInput } from '../core/dates'
import { classifyTransactionType, extractSourceTypeToken, signForDirection } from '../core/classify'
import { parseAmountToMinor } from '../core/money'
import type { BankId, Direction, NamedAmount, StatementSummary } from '../core/types'
import { itemCenterX, pageRows, type TextRow } from './pdfLayout'
import { assertCreditSign, emptySummary, ParseError, requireTransactionAmount, type BankParser, type ParsedStatement, type ParsedTransaction, type SourceDocument } from './types'

const PARSER_ID = 'boc_pdf'
const PARSER_VERSION = '2.0.0'

/**
 * Bank of China merged text PDF statement.
 *
 * Direction comes from the printed amount column (存入 Deposit / 支出 Expenditure)
 * and never from the description text. Merchant descriptions frequently wrap onto a
 * neighbouring text line, so description fragments are collected by proximity to the
 * transaction row instead of by strict row membership.
 */

const AMOUNT_RE = /-?\d[\d,]*\.\d{2}/
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const COMPACT_DATE_RE = /^\d{6}$/

const NOISE_PATTERNS: RegExp[] = [
  /交易日|银行记账日|卡号后四位|交易描述|^存入$|^支出$|人民币交易明细|积分奖励计划/,
  /Transaction Date|Posting Date|Last Four|Description|^Deposit$|^Expenditure$/,
  /^Digits$|of Card Number|Loyalty Plan|RMB Transaction/,
  /第\s*\d+\s*页|共\s*\d+\s*页/,
]

interface RowRef {
  pageNumber: number
  row: TextRow
}

export const bocParser: BankParser = {
  id: PARSER_ID,
  version: PARSER_VERSION,
  bank: 'boc',
  sourceTypes: ['pdf'],

  match(doc) {
    if (doc.sourceType !== 'pdf' || !doc.pdf) return 0
    const { text } = doc
    const namesBank = /中国银行|Bank of China|BOC Credit Card/.test(text)
    const namesStatement = /信用卡账单|Credit Card Billing Statement/.test(text)
    const namesTable = /人民币交易明细|RMB Transaction Detailed List/.test(text)
    if (namesBank && namesStatement && namesTable) return 1
    if (namesBank && namesTable) return 0.8
    return 0
  },

  parse(doc) {
    if (!doc.pdf) throw new ParseError('缺少 PDF 内容', 'missing_pdf')
    const overview = parseOverviewDates(doc)
    const fallbackCardLast4 = parseCardLast4(doc)
    const transactions = parseTransactions(doc, fallbackCardLast4)
    const cnyCards = new Set(transactions.filter(tx => tx.settlementCurrency === 'CNY').map(tx => tx.cardLast4))
    const cardLast4 = cnyCards.size === 1 ? [...cnyCards][0]! : fallbackCardLast4
    const summary = parseAccountSummary(doc, transactions)

    if (transactions.length === 0) {
      throw new ParseError('未在账单明细表中找到交易行', 'no_transactions_found')
    }

    const warnings: string[] = []
    const cycleEnd = overview.closingDate
    const cycleStart = cycleEnd ? addDays(addMonths(cycleEnd, -1), 1) : null
    if (!cardLast4) warnings.push('missing_card_last4')
    if (!cycleEnd) warnings.push('missing_statement_period')
    if (summary.currentBalanceMinor === null) warnings.push('missing_current_balance')
    if (cycleStart && cycleEnd) {
      const outside = transactions.filter(
        (tx) =>
          (tx.transactionDate && (tx.transactionDate < cycleStart || tx.transactionDate > cycleEnd)) ||
          (tx.postingDate && (tx.postingDate < cycleStart || tx.postingDate > cycleEnd)),
      )
      if (outside.length) warnings.push(`transactions_outside_cycle:${outside.length}`)
    }

    return {
      bank: 'boc' as BankId,
      cardLast4,
      cycleStart,
      cycleEnd,
      dueDate: overview.dueDate,
      summary,
      transactions,
      confidence: cardLast4 && summary.currentBalanceMinor !== null && cycleEnd ? 0.95 : 0.7,
      parserId: PARSER_ID,
      parserVersion: PARSER_VERSION,
      warnings,
    } satisfies ParsedStatement
  },
}

function isNoise(row: TextRow): boolean {
  return NOISE_PATTERNS.some((re) => re.test(row.text.trim()))
}

function rowsMatching(doc: SourceDocument, pattern: RegExp): RowRef[] {
  const found: RowRef[] = []
  for (const page of doc.pdf!.pages) {
    for (const row of pageRows(page)) {
      if (pattern.test(row.text)) found.push({ pageNumber: page.pageNumber, row })
    }
  }
  return found
}

interface Anchor {
  key: string
  center: number
}

function collectAnchors(doc: SourceDocument, specs: Array<{ key: string; re: RegExp }>): Anchor[] {
  const anchors: Anchor[] = []
  for (const spec of specs) {
    const centers: number[] = []
    for (const page of doc.pdf!.pages) {
      for (const row of pageRows(page)) {
        if (isNoise(row)) continue
        for (const item of row.items) {
          if (spec.re.test(item.text.trim())) centers.push(itemCenterX(item))
        }
      }
    }
    if (centers.length > 0) {
      anchors.push({ key: spec.key, center: centers.reduce((sum, value) => sum + value, 0) / centers.length })
    }
  }
  return anchors
}

function nearestAnchor(anchors: Anchor[], x: number, maxDistance = Number.POSITIVE_INFINITY): Anchor | null {
  let best: Anchor | null = null
  let bestDistance = Number.POSITIVE_INFINITY
  for (const anchor of anchors) {
    const distance = Math.abs(anchor.center - x)
    if (distance < bestDistance) {
      bestDistance = distance
      best = anchor
    }
  }
  return bestDistance <= maxDistance ? best : null
}

function amountIn(text: string): number | null {
  const match = AMOUNT_RE.exec(text)
  if (!match) return null
  return parseAmountToMinor(match[0])?.minor ?? null
}

/** 欠款 = balance owed (positive), 存款 = balance in credit (negative). */
function applyBalanceQualifier(text: string, minor: number): number {
  const hasDebt = /欠款|DEBT/i.test(text)
  const hasCredit = /存款|CREDIT\s*BAL/i.test(text)
  if (hasDebt) return Math.abs(minor)
  if (hasCredit && !hasDebt) return -Math.abs(minor)
  return minor
}

interface OverviewDates {
  dueDate: string | null
  closingDate: string | null
}

function parseOverviewDates(doc: SourceDocument): OverviewDates {
  const anchors = collectAnchors(doc, [
    { key: 'dueDate', re: /到期还款日|Payment Due Date/i },
    { key: 'closingDate', re: /账单日$|^账单日|Statement Closing Date/i },
  ])
  if (anchors.length === 0) return { dueDate: null, closingDate: null }

  const result: OverviewDates = { dueDate: null, closingDate: null }
  for (const { row } of rowsMatching(doc, /\d{4}-\d{2}-\d{2}/)) {
    const dates = row.items
      .map((item) => ({ item, iso: ISO_DATE_RE.test(item.text.trim()) ? parseDateInput(item.text.trim()) : null }))
      .filter((entry): entry is { item: (typeof row.items)[number]; iso: string } => entry.iso !== null)
    if (dates.length < 2) continue
    for (const { item, iso } of dates) {
      const anchor = nearestAnchor(anchors, itemCenterX(item))
      if (!anchor) continue
      if (anchor.key === 'closingDate' && !result.closingDate) result.closingDate = iso
      if (anchor.key === 'dueDate' && !result.dueDate) result.dueDate = iso
    }
    if (result.closingDate && result.dueDate) break
  }
  return result
}

/** A currency is reliable only when all explicit labels agree. */
function currencyOf(text: string): string | null {
  const currencies = new Set<string>()
  if (/人民币|\bRMB\b|\bCNY\b/i.test(text)) currencies.add('CNY')
  if (/美元|\bUSD\b/i.test(text)) currencies.add('USD')
  if (/港币|港元|\bHKD\b/i.test(text)) currencies.add('HKD')
  return currencies.size === 1 ? [...currencies][0]! : null
}

function accountOf(text: string): string | null {
  return /卡号[：:]\s*(\d{4})(?!\d)/.exec(text)?.[1] ?? null
}

/** Infer the row axis from the labelled account/table block, not amount values. */
function readingDirection(doc: SourceDocument): number | null {
  const directions = new Set<number>()
  for (const page of doc.pdf!.pages) {
    const rows = pageRows(page)
    const accounts = rows.filter(row => accountOf(row.text))
    for (const header of rows.filter(row => /账号类型|Account Type/i.test(row.text))) {
      const closest = [...accounts].sort((a, b) => Math.abs(a.y - header.y) - Math.abs(b.y - header.y))[0]
      if (closest && closest.y !== header.y) directions.add(closest.y > header.y ? -1 : 1)
    }
  }
  return directions.size === 1 ? [...directions][0]! : null
}

function parseAccountSummary(doc: SourceDocument, transactions: ParsedTransaction[]): StatementSummary {
  const unavailable = emptySummary()
  const anchors = collectAnchors(doc, [
    { key: 'previous', re: /上期存款|Previous Balance/i },
    { key: 'purchase', re: /本期支出金额|^Purchase$/i },
    { key: 'payments', re: /本期存入金额|^Payments$/i },
    { key: 'current', re: /本期存款\/欠款余额|^New Balance$/i },
  ])
  if (anchors.length < 3) return unavailable

  const anchorSpread = Math.max(...anchors.map((a) => a.center)) - Math.min(...anchors.map((a) => a.center))
  const tolerance = anchorSpread / Math.max(anchors.length, 1)

  const candidates: Array<{ account: string | null; summary: StatementSummary }> = []
  const direction = readingDirection(doc)
  let account: string | null = null
  for (const page of doc.pdf!.pages) {
    for (const row of pageRows(page).sort((a, b) => (a.y - b.y) * (direction ?? -1))) {
      const heading = accountOf(row.text)
      if (/卡号[：:]/.test(row.text)) account = direction === null ? null : heading
      // An account-type row must explicitly name its own currency. Never borrow
      // another row's missing values or the unscoped card overview balance.
      const label = row.text.split(AMOUNT_RE)[0]?.trim() ?? ''
      if (!/^(人民币|美元|港币|港元|RMB\b|CNY\b|USD\b|HKD\b)/i.test(label)) continue
      if (/交易明细|Transaction Detailed List/i.test(row.text)) continue
      const currency = currencyOf(label)
      if (!currency) continue
      const summary = emptySummary()
      const components: NamedAmount[] = []
      for (const item of row.items) {
        const minor = amountIn(item.text)
        if (minor === null) continue
        const signed = applyBalanceQualifier(item.text, minor)
        const anchor = nearestAnchor(anchors, itemCenterX(item), tolerance)
        if (!anchor) continue
        switch (anchor.key) {
          case 'previous':
            if (summary.previousBalanceMinor === null) {
              summary.previousBalanceMinor = signed
              components.push({ label: '上期存款/欠款余额 Previous Balance', minor: signed, currency })
            }
            break
          case 'purchase':
            if (summary.newDebitMinor === null) {
              summary.newDebitMinor = Math.abs(signed)
              components.push({
                label: '本期支出金额 Purchase and Adjustments',
                minor: summary.newDebitMinor,
                currency,
              })
            }
            break
          case 'payments':
            if (summary.newCreditMinor === null) {
              summary.newCreditMinor = Math.abs(signed)
              components.push({
                label: '本期存入金额 Payments and Other Credits',
                minor: summary.newCreditMinor,
                currency,
              })
            }
            break
          case 'current':
            if (summary.currentBalanceMinor === null) {
              summary.currentBalanceMinor = signed
              components.push({ label: '本期存款/欠款余额 New Balance', minor: signed, currency })
            }
            break
          default:
            break
        }
      }
      summary.components = components
      if (components.length) candidates.push({ account, summary })
    }
  }
  const cards = new Set(transactions.filter(tx => tx.settlementCurrency === 'CNY').map(tx => tx.cardLast4))
  const eligible = candidates.filter(candidate => candidate.summary.components[0]?.currency === 'CNY' &&
    cards.size === 1 && candidate.account === [...cards][0])
  // This parser's primary reconciliation is the RMB account. Foreign evidence
  // stays in its printed currency; absent/ambiguous RMB scope stays insufficient.
  const selected = eligible.length === 1 ? eligible[0]! : null
  const summary = selected?.summary ?? unavailable
  if (selected) parseCardRow(doc, summary, summary.components, selected.account!)
  for (const candidate of candidates) {
    if (candidate === selected) continue
    summary.components.push(...candidate.summary.components.map(component => ({ ...component,
      label: `未用于人民币对账（尾号${candidate.account ?? '未识别'}） ${component.label}`,
    })))
  }
  return summary
}

function parseCardRow(doc: SourceDocument, summary: StatementSummary, components: NamedAmount[], cardLast4: string): void {
  const anchors = collectAnchors(doc, [
    { key: 'card', re: /^卡号$|Credit Card No/i },
    { key: 'newBalance', re: /本期应还款额|New Balanc/i },
    { key: 'minimum', re: /本期最小还款|Minimum Payment/i },
  ])
  if (anchors.length < 2) return
  const spread = Math.max(...anchors.map((a) => a.center)) - Math.min(...anchors.map((a) => a.center))
  const tolerance = spread / Math.max(anchors.length, 1)

  for (const { row } of rowsMatching(doc, /\*{2,}/)) {
    if (!new RegExp(`\\*{2,}\\s*${cardLast4}(?!\\d)`).test(row.text)) continue
    for (const item of row.items) {
      const minor = amountIn(item.text)
      if (minor === null) continue
      const anchor = nearestAnchor(anchors, itemCenterX(item), tolerance)
      if (!anchor) continue
      if (anchor.key === 'minimum' && summary.minimumPaymentMinor === null) {
        summary.minimumPaymentMinor = minor
        components.push({ label: '本期最小还款 Minimum Payment due', minor, currency: 'CNY' })
      }
    }
    if (summary.minimumPaymentMinor !== null) break
  }
}

function parseCardLast4(doc: SourceDocument): string {
  for (const { row } of rowsMatching(doc, /\*{2,}/)) {
    const inline = /\d{4}\s*\d{4}\s*\*{2,}\s*(\d{4})/.exec(row.text)
    if (inline) return inline[1]!
    for (const item of row.items) {
      const direct = /\*{2,}\s*(\d{4})/.exec(item.text)
      if (direct) return direct[1]!
    }
  }
  for (const { row } of rowsMatching(doc, /卡号[：:]\s*(\d{4})/)) {
    const match = /卡号[：:]\s*(\d{4})/.exec(row.text)
    if (match) return match[1]!
  }
  return ''
}

interface Fragment {
  pageNumber: number
  y: number
  x: number
  text: string
}

const DESCRIPTION_ATTACH_TOLERANCE = 13

/**
 * The column headers are split over two printed lines (Chinese on one row, English
 * on the next), so the band around the header row is scanned for both.
 */
function locateTransactionHeaderBand(
  rows: TextRow[],
): { depositCenter: number; expenditureCenter: number } | null {
  const anchorIndex = rows.findIndex((row) => /Last Four/i.test(row.text) || /卡号后四位/.test(row.text))
  if (anchorIndex === -1) return null
  const anchorY = rows[anchorIndex]!.y

  const deposit: number[] = []
  const expenditure: number[] = []
  for (const row of rows) {
    if (Math.abs(row.y - anchorY) > 60) continue
    for (const item of row.items) {
      const text = item.text.trim()
      if (/^(存入|Deposit)$/i.test(text)) deposit.push(itemCenterX(item))
      else if (/^(支出|Expenditure)$/i.test(text)) expenditure.push(itemCenterX(item))
    }
  }
  if (deposit.length === 0 || expenditure.length === 0) return null
  const average = (values: number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length
  return { depositCenter: average(deposit), expenditureCenter: average(expenditure) }
}

function parseTransactions(doc: SourceDocument, fallbackCardLast4: string): ParsedTransaction[] {
  const result: ParsedTransaction[] = []
  const direction = readingDirection(doc) ?? -1
  let currency: string | null = null
  for (const page of doc.pdf!.pages) {
    const rows = pageRows(page, 2.5).sort((a, b) => (a.y - b.y) * direction)
    const headerBand = locateTransactionHeaderBand(rows)
    if (!headerBand) {
      for (const row of rows) {
        if (/交易明细|Transaction Detailed List/i.test(row.text)) currency = currencyOf(row.text)
      }
      continue
    }
    const { depositCenter, expenditureCenter } = headerBand

    const fragments: Fragment[] = []
    const transactionRows: Array<RowRef & { currency: string }> = []

    for (const row of rows) {
      if (/交易明细|Transaction Detailed List/i.test(row.text)) {
        currency = currencyOf(row.text)
        continue
      }
      if (isNoise(row)) continue
      const dateItems = row.items.filter((item) => ISO_DATE_RE.test(item.text.trim()) || COMPACT_DATE_RE.test(item.text.trim()))
      const hasCard = row.items.some((item) => /^\d{4}$/.test(item.text.trim()))
      if (dateItems.length >= 2 && hasCard) {
        if (!currency) throw new ParseError('交易明细币种标记不明确，整份账单未导入', 'ambiguous_detail_currency')
        transactionRows.push({ pageNumber: page.pageNumber, row, currency })
        continue
      }
      const text = row.text.trim()
      if (!text || /\d{4}-\d{2}-\d{2}/.test(text)) continue
      if (!/[\u4e00-\u9fffA-Za-z]/.test(text)) continue
      fragments.push({
        pageNumber: page.pageNumber,
        y: row.y,
        x: row.items[0]?.x ?? 0,
        text,
      })
    }

    transactionRows.sort((a, b) => b.row.y - a.row.y).forEach((entry, index) => {
      const built = buildTransaction(entry, fragments, {
        depositCenter,
        expenditureCenter,
        fallbackCardLast4,
        sourceRow: index,
        currency: entry.currency,
      })
      if (built) result.push(built)
    })
  }
  return result
}

interface ColumnConfig {
  currency: string
  depositCenter: number
  expenditureCenter: number
  /** Statement level card last4, used when a row has no readable card digits. */
  fallbackCardLast4: string
  sourceRow: number
}

function buildTransaction(entry: RowRef, fragments: Fragment[], config: ColumnConfig): ParsedTransaction | null {
  const { row, pageNumber } = entry
  const dateItems = row.items.filter((item) => ISO_DATE_RE.test(item.text.trim()) || COMPACT_DATE_RE.test(item.text.trim()))
  if (dateItems.length < 2) return null
  const transactionDate = parseDateInput(dateItems[0]!.text.trim())
  const postingDate = parseDateInput(dateItems[1]!.text.trim()) ?? transactionDate
  if (!transactionDate) return null

  const cardItem = row.items.find(
    (item) => /^\d{4}$/.test(item.text.trim()) && item.x > dateItems[1]!.x + dateItems[1]!.width,
  )
  const rowCardLast4 = cardItem?.text.trim() ?? config.fallbackCardLast4
  if (!rowCardLast4) return null

  // The two amount columns are far apart; pick the column the amount was printed in.
  let selected: { text: string; direction: Direction } | null = null
  for (const item of row.items) {
    if (item.x < config.depositCenter - 45) continue
    const center = itemCenterX(item)
    if (center >= config.expenditureCenter - 45) selected = { text: item.text, direction: 'debit' }
    else if (center >= config.depositCenter - 45) selected = { text: item.text, direction: 'credit' }
  }
  const selectedAmount = requireTransactionAmount(selected, config.sourceRow)
  const parsed = requireTransactionAmount(parseAmountToMinor(selectedAmount.text.trim(), config.currency), config.sourceRow)
  assertCreditSign(parsed.negativeByFormat, selectedAmount.direction, config.sourceRow)
  const minor = signForDirection(parsed.minor, selectedAmount.direction)

  const descriptionStart = cardItem ? cardItem.x + cardItem.width : 0
  const parts: Array<{ y: number; text: string }> = []
  for (const item of row.items) {
    const text = item.text.trim()
    if (item.x <= descriptionStart) continue
    if (AMOUNT_RE.test(text)) continue
    if (ISO_DATE_RE.test(text) || COMPACT_DATE_RE.test(text)) continue
    if (!text) continue
    parts.push({ y: item.y, text })
  }

  const nearby = fragments
    .filter(
      (fragment) =>
        fragment.pageNumber === pageNumber &&
        fragment.x > descriptionStart &&
        Math.abs(fragment.y - row.y) <= DESCRIPTION_ATTACH_TOLERANCE,
    )
    .map((fragment) => ({ y: fragment.y, text: fragment.text }))
  parts.push(...nearby)
  parts.sort((a, b) => b.y - a.y)

  const rawDescription = parts
    .map((part) => part.text.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('')
    .trim()

  const cleaned = cleanDescription(rawDescription)
  const bankToken = extractSourceTypeToken(cleaned)
  const classification = classifyTransactionType(bankToken, selectedAmount.direction, minor)
  const type = classification.type

  return {
    cardLast4: rowCardLast4,
    transactionDate,
    postingDate,
    rawDescription,
    description: cleaned || '未识别交易',
    transactionCurrency: config.currency,
    transactionAmountMinor: minor,
    settlementCurrency: config.currency,
    settlementAmountMinor: minor,
    type,
    typeUncertain: classification.requiresReview,
    direction: selectedAmount.direction,
    bankToken,
    confidence: cleaned && cleaned !== '未识别交易' ? 0.95 : 0.6,
    sourcePage: pageNumber,
    sourceRow: config.sourceRow,
    rawText: row.text,
  }
}

/**
 * pdf.js splits a merchant line across text runs, so `...平台商户C` + `HN` arrives as
 * two fragments. The currency marker is stripped, never the merchant name.
 */
export function cleanDescription(text: string): string {
  return cleanSourceDescription(text, 'boc')
}
