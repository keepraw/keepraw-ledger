import { effectiveAmountForDirection, effectiveDirection, isPostedTransaction } from './direction'
import { monthKey } from './dates'
import { normalizeCurrencyCode } from './money'
import { summarizeTransactions, type DirectionTotals } from './reconcile'
import type { BankId, Statement, Transaction } from './types'

export interface Filters {
  from: string | null
  to: string | null
  banks: BankId[]
  cards: string[]
  /** Include statements that did not reconcile. Off by default so statistics stay honest. */
  includeUnreconciled: boolean
  /** Include rows a human rejected during review. */
  includeRejected: boolean
}

export const DEFAULT_FILTERS: Filters = {
  from: null,
  to: null,
  banks: [],
  cards: [],
  includeUnreconciled: false,
  includeRejected: false,
}

export function applyFilters(transactions: Transaction[], filters: Filters): Transaction[] {
  return transactions.filter((tx) => {
    if (!filters.includeRejected && tx.reviewStatus === 'rejected') return false
    if (tx.transactionDate) {
      if (filters.from && tx.transactionDate < filters.from) return false
      if (filters.to && tx.transactionDate > filters.to) return false
    }
    if (filters.banks.length > 0 && !filters.banks.includes(tx.bank)) return false
    if (filters.cards.length > 0 && !filters.cards.includes(tx.cardLast4)) return false
    return true
  })
}

export type DashboardSummary = DirectionTotals

export function summarize(transactions: Transaction[]): DashboardSummary {
  return summarizeTransactions(transactions)
}

export function monthlyTrend(transactions: Transaction[]): Array<{ month: string; debit: number; credit: number }> {
  const buckets = new Map<string, { debit: number; credit: number }>()
  for (const tx of transactions) {
    if (normalizeCurrencyCode(tx.settlementCurrency) !== 'CNY') continue
    if (tx.reviewStatus === 'rejected' || !tx.transactionDate) continue
    const key = monthKey(tx.transactionDate)
    const bucket = buckets.get(key) ?? { debit: 0, credit: 0 }
    if (!isPostedTransaction(tx)) continue
    if (effectiveDirection(tx) === 'credit') bucket.credit += -(effectiveAmountForDirection(tx) ?? 0)
    else bucket.debit += (effectiveAmountForDirection(tx) ?? 0)
    buckets.set(key, bucket)
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, value]) => ({ month, ...value }))
}

export function groupBy(transactions: Transaction[], key: (tx: Transaction) => string): Array<{ label: string; value: number }> {
  const totals = new Map<string, number>()
  for (const tx of transactions) {
    if (normalizeCurrencyCode(tx.settlementCurrency) !== 'CNY') continue
    if (tx.reviewStatus === 'rejected') continue
    if (!isPostedTransaction(tx) || effectiveDirection(tx) !== 'debit') continue
    const label = key(tx)
    totals.set(label, (totals.get(label) ?? 0) + (effectiveAmountForDirection(tx) ?? 0))
  }
  return [...totals.entries()]
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value)
}

export function groupByBank(transactions: Transaction[]): Array<{ label: string; value: number }> {
  const totals = new Map<string, number>()
  for (const tx of transactions) {
    if (normalizeCurrencyCode(tx.settlementCurrency) !== 'CNY') continue
    if (!isPostedTransaction(tx) || effectiveDirection(tx) !== 'debit') continue
    totals.set(tx.bank, (totals.get(tx.bank) ?? 0) + (effectiveAmountForDirection(tx) ?? 0))
  }
  return [...totals.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value)
}

export interface StatementFilterResult {
  transactions: Transaction[]
  excludedStatementIds: Set<string>
}

/**
 * Only statements that reconciled may feed the statistics by default, with one
 * deliberate exception: `imported` history was reviewed in the previous system
 * and carries no balance to check, so it counts without ever claiming
 * `reconciled`. Unreconciled statements are surfaced separately instead of
 * silently inflating the totals.
 */
export function filterByStatementTrust(
  transactions: Transaction[],
  statements: Statement[],
  includeUnreconciled: boolean,
): StatementFilterResult {
  if (includeUnreconciled) {
    return { transactions, excludedStatementIds: new Set() }
  }
  const untrusted = new Set(
    statements.filter((s) => s.status !== 'reconciled' && s.status !== 'imported').map((s) => s.id),
  )
  return {
    transactions: transactions.filter((tx) => !untrusted.has(tx.statementId)),
    excludedStatementIds: untrusted,
  }
}

export function untrustedAmount(transactions: Transaction[], statements: Statement[]): number {
  const untrusted = new Set(
    statements.filter((s) => s.status !== 'reconciled' && s.status !== 'imported').map((s) => s.id),
  )
  return transactions
    .filter((tx) => untrusted.has(tx.statementId) && isPostedTransaction(tx) && normalizeCurrencyCode(tx.settlementCurrency) === 'CNY')
    .reduce((sum, tx) => sum + Math.abs((effectiveAmountForDirection(tx) ?? 0)), 0)
}
