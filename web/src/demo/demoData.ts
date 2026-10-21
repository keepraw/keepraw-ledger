import { addDays, addMonths, monthEnd } from '../core/dates'
import { inferTransactionType, signForDirection } from '../core/classify'
import { ingestParsedStatement, type IngestResult } from '../core/ingest'
import { emptySummary, type ParsedStatement, type ParsedTransaction } from '../parsers/types'
import type { Direction, ImportRecord, Statement, StatementSummary, Transaction } from '../core/types'

/**
 * Demo Mode dataset.
 *
 * Every number, merchant, card suffix and file name here is invented. The data is
 * routed through the exact same parse -> dedupe -> reconcile pipeline as a real
 * import, is tagged `isDemo: true`, and the UI hides real rows whenever Demo Mode is
 * on so the two can never be confused.
 */

function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const MERCHANTS: Array<{ token: string; name: string; direction: Direction; type?: string }> = [
  { token: '消费', name: '示例咖啡', direction: 'debit' },
  { token: '消费', name: '示例生鲜超市', direction: 'debit' },
  { token: '消费', name: '示例连锁餐厅', direction: 'debit' },
  { token: '消费', name: '示例地铁出行', direction: 'debit' },
  { token: '消费', name: '示例网上书店', direction: 'debit' },
  { token: '消费', name: '示例电器商城', direction: 'debit' },
  { token: '消费', name: '示例打车平台', direction: 'debit' },
  { token: '消费', name: '示例健身房', direction: 'debit' },
  { token: '退货', name: '退货 示例电器商城', direction: 'credit' },
  { token: '刷卡金', name: '刷卡金 消费返现', direction: 'credit' },
  { token: '信用卡还款', name: '信用卡还款 转账还款-示例银行', direction: 'credit' },
  { token: '费用', name: '手续费 年费服务费', direction: 'debit' },
]

interface DemoPlan {
  bank: 'boc' | 'bocom'
  cardLast4: string
  cycleStart: string
  cycleEnd: string
  previousBalanceMinor: number
  purchaseCount: number
  forceDiscrepancyMinor?: number
  parserId: string
  parserVersion: string
  fileName: string
  dueDate: string
}

function buildStatement(plan: DemoPlan, random: () => number): ParsedStatement {
  const transactions: ParsedTransaction[] = []
  const cycleStart = plan.cycleStart
  const cycleEnd = plan.cycleEnd

  const dayInCycle = (ratio: number): string => {
    const span = Math.max(1, daysBetweenIso(cycleStart, cycleEnd))
    const offset = Math.min(span, Math.max(0, Math.round(span * ratio)))
    return addDays(cycleStart, offset)
  }

  for (let i = 0; i < plan.purchaseCount; i++) {
    const merchant = MERCHANTS[Math.floor(random() * (MERCHANTS.length - 2))]!
    const amountMinor = (500 + Math.floor(random() * 24000) + 99) // 5.00 - 249.99
    const date = dayInCycle(random() * 0.9)
    transactions.push(
      makeTransaction({
        cardLast4: plan.cardLast4,
        date,
        postingDate: date,
        description: `${merchant.token} ${merchant.name}`,
        amountMinor,
        direction: merchant.direction,
        sourceRow: transactions.length,
        forceType: merchant.type,
      }),
    )
  }

  // One repayment, sized so the statement carries a realistic closing balance.
  const repaymentMinor = plan.previousBalanceMinor + 12345
  const payDate = dayInCycle(0.1)
  transactions.push(
    makeTransaction({
      cardLast4: plan.cardLast4,
      date: payDate,
      postingDate: payDate,
      description: '信用卡还款 转账还款-示例银行',
      amountMinor: repaymentMinor,
      direction: 'credit',
      sourceRow: transactions.length,
      forceType: 'payment',
    }),
  )

  // One small fee, only for the BOCOM-style plans.
  if (plan.bank === 'bocom') {
    const feeDate = dayInCycle(0.5)
    transactions.push(
      makeTransaction({
        cardLast4: plan.cardLast4,
        date: feeDate,
        postingDate: feeDate,
        description: '费用 分期手续费',
        amountMinor: 193,
        direction: 'debit',
        sourceRow: transactions.length,
        forceType: 'fee',
      }),
    )
  }

  const purchases = transactions.filter((tx) => tx.direction === 'debit' && tx.type === 'purchase')
  const charges = transactions.filter((tx) => tx.direction === 'debit' && (tx.type === 'fee' || tx.type === 'interest'))
  const credits = transactions.filter((tx) => tx.direction === 'credit')
  const newDebitMinor = sumAbs(purchases)
  const chargeMinor = sumAbs(charges)
  const newCreditMinor = sumAbs(credits)
  const currentBalanceMinor =
    plan.previousBalanceMinor + newDebitMinor + chargeMinor - newCreditMinor + (plan.forceDiscrepancyMinor ?? 0)

  const summary: StatementSummary = {
    ...emptySummary(),
    previousBalanceMinor: plan.previousBalanceMinor,
    newDebitMinor,
    newCreditMinor,
    chargeMinor,
    interestMinor: 0,
    currentBalanceMinor,
    minimumPaymentMinor: Math.max(1000, Math.round(currentBalanceMinor * 0.05)),
    dueDate: plan.dueDate,
    components: [
      { label: '上期存款/欠款余额', minor: plan.previousBalanceMinor, currency: 'CNY' },
      { label: '本期新增支出', minor: newDebitMinor, currency: 'CNY' },
      { label: '本期还款及其他贷记', minor: newCreditMinor, currency: 'CNY' },
      { label: '本期应还', minor: currentBalanceMinor, currency: 'CNY' },
    ],
  }

  return {
    bank: plan.bank,
    cardLast4: plan.cardLast4,
    cycleStart,
    cycleEnd,
    dueDate: plan.dueDate,
    summary,
    transactions,
    confidence: 0.95,
    parserId: plan.parserId,
    parserVersion: plan.parserVersion,
    warnings: [],
  }
}

function daysBetweenIso(start: string, end: string): number {
  return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000)
}

function sumAbs(rows: ParsedTransaction[]): number {
  return rows.reduce((sum, tx) => sum + Math.abs(tx.transactionAmountMinor), 0)
}

function makeTransaction(input: {
  cardLast4: string
  date: string
  postingDate: string
  description: string
  amountMinor: number
  direction: Direction
  sourceRow: number
  forceType?: string
}): ParsedTransaction {
  const token = input.description.split(' ')[0] ?? ''
  const type = (input.forceType as ParsedTransaction['type']) ?? inferTransactionType(token, input.description, input.direction)
  const signed = signForDirection(input.amountMinor, input.direction)
  return {
    cardLast4: input.cardLast4,
    transactionDate: input.date,
    postingDate: input.postingDate,
    rawDescription: input.description,
    description: input.description,
    transactionCurrency: 'CNY',
    transactionAmountMinor: signed,
    settlementCurrency: 'CNY',
    settlementAmountMinor: signed,
    type,
    direction: input.direction,
    bankToken: token,
    confidence: 0.95,
    sourcePage: null,
    sourceRow: input.sourceRow,
    rawText: `${input.date} | ${input.cardLast4} | ${input.description} | ${input.amountMinor / 100}`,
  }
}

function cycle(anchorMonth: string, day = 4): { start: string; end: string } {
  const end = monthEnd(Number(anchorMonth.slice(0, 4)), Number(anchorMonth.slice(5, 7)))
  const start = addDays(addMonths(end, -1), 1)
  void day
  return { start, end }
}

const PLANS: DemoPlan[] = [
  plan('boc', '0000', '2026-04', 612345, 9, 'boc_pdf', '2.0.0', '示例-中国银行账单2026年04月.pdf'),
  plan('boc', '0000', '2026-05', 588210, 11, 'boc_pdf', '2.0.0', '示例-中国银行账单2026年05月.pdf'),
  plan('boc', '0000', '2026-06', 431200, 8, 'boc_pdf', '2.0.0', '示例-中国银行账单2026年06月.pdf'),
  plan('boc', '0000', '2026-07', 298760, 12, 'boc_pdf', '2.0.0', '示例-中国银行账单2026年07月.pdf'),
  plan('bocom', '9999', '2026-06', 705113, 10, 'bocom_eml', '2.0.0', '示例-交通银行账单2026年06月.eml'),
  plan('bocom', '9999', '2026-07', 512004, 13, 'bocom_eml', '2.0.0', '示例-交通银行账单2026年07月.eml'),
  plan('bocom', '9999', '2026-08', 366221, 9, 'bocom_eml', '2.0.0', '示例-交通银行账单2026年08月.eml'),
]

function plan(
  bank: 'boc' | 'bocom',
  cardLast4: string,
  anchorMonth: string,
  previousBalanceMinor: number,
  purchaseCount: number,
  parserId: string,
  parserVersion: string,
  fileName: string,
  forceDiscrepancyMinor?: number,
): DemoPlan {
  const { start, end } = cycle(anchorMonth)
  return {
    bank,
    cardLast4,
    cycleStart: start,
    cycleEnd: end,
    dueDate: addDays(end, 20),
    previousBalanceMinor,
    purchaseCount,
    parserId,
    parserVersion,
    fileName,
    ...(forceDiscrepancyMinor !== undefined ? { forceDiscrepancyMinor } : {}),
  }
}

/**
 * Build the demo dataset. The last statement deliberately carries a 12.34 discrepancy
 * so the reconciliation and manual review flows are visible without real data.
 */
export function buildDemoDataset(): IngestResult[] {
  const random = mulberry32(20260911)
  const results: IngestResult[] = []
  const accumulated: { statements: Statement[]; transactions: Transaction[]; imports: ImportRecord[] } = {
    statements: [],
    transactions: [],
    imports: [],
  }

  const plans = [...PLANS]
  plans.push({
    ...plan('bocom', '9999', '2026-09', 402119, 10, 'bocom_eml', '2.0.0', '示例-交通银行账单2026年09月.eml'),
    forceDiscrepancyMinor: 1234,
  })

  plans.forEach((demoPlan, index) => {
    const parsed = buildStatement(demoPlan, random)
    // Give a few transactions a manual category and a review flag so the Review page
    // is not empty on a fresh install.
    const result = ingestParsedStatement(
      parsed,
      {
        fileName: demoPlan.fileName,
        fileHash: `demo-${demoPlan.bank}-${demoPlan.cycleStart}-${index}`,
        fileSize: 100_000 + index * 1000,
        sourceType: demoPlan.bank === 'boc' ? 'pdf' : 'eml',
        isDemo: true,
      },
      accumulated,
    )

    if (index === plans.length - 1) {
      // Flag a couple of rows so the review queue demonstrates the workflow.
      const flagged: Transaction[] = result.transactions.map((tx, i) => {
        if (i === 1) return { ...tx, flags: [...tx.flags, 'uncategorized'], reviewStatus: 'pending' }
        if (i === 3) return { ...tx, flags: [...tx.flags, 'suspected_duplicate'], reviewStatus: 'pending' }
        return tx
      })
      result.transactions = flagged
      const insertedIds = new Set(result.inserted.map((tx) => tx.id))
      result.inserted = flagged.filter((tx) => insertedIds.has(tx.id))
    }

    results.push(result)
    accumulated.transactions.push(...result.transactions)
    accumulated.statements.push(result.statement!)
    accumulated.imports.push(result.record)
  })

  return results
}

export const DEMO_BADGE = '演示数据'