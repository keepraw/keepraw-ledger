import { hasUnresolvedDirection, effectiveAmountForDirection, effectiveDirection } from './direction'
import { formatMinor } from './money'
import type {
  ReconciliationResult,
  ReconciliationStatus,
  Statement,
  Transaction,
} from './types'

/**
 * Statement-level reconciliation (first phase).
 *
 * Goal: judge whether the transactions stored for one statement look
 * complete and consistent with the bank-stated totals. This is NOT a full
 * financial audit system.
 *
 * Explicit non-goals (never done here):
 * - never touches bank parsers or fingerprints
 * - never auto-fixes transactions, amounts or missing rows
 * - never guesses a bank total that the parser did not provide
 * - never mutates its inputs
 *
 * Two checks only:
 *   1. transaction count — how many active rows belong to the statement
 *   2. amount total — sum of `settlementAmountMinor` vs. a reliable
 *      bank total derived from `Statement.summary`
 *
 * Reuses the existing `Statement.reconciliation.status` vocabulary
 * (`passed` | `mismatch` | `insufficient`). No new status field, no schema
 * change. Use {@link toReconciliationResult} when the lightweight summary
 * must be persisted into the existing `ReconciliationResult` shape.
 */

export interface StatementReconciliationResult {
  status: ReconciliationStatus
  /** Active rows (rejected excluded). */
  transactionCount: number
  /** Sum of active rows in `currency`, minor units. */
  transactionTotalMinor: number
  /** Bank-stated net for this cycle, or null when unavailable. */
  expectedTotalMinor: number | null
  /** `expected - actual`, or null when comparison is impossible. */
  differenceMinor: number | null
  currency: string
  /** False when the parser provided no reliable bank total. */
  bankTotalAvailable: boolean
  /** Human-readable Chinese explanation, never a guess. */
  reason: string
  /** Which summary fields produced the expected total. */
  expectedSource: 'detail' | 'balance' | 'none'
}

export interface ExpectedTotal {
  expectedMinor: number | null
  currency: string
  available: boolean
  source: 'detail' | 'balance' | 'none'
}

/** Primary currency for a statement. Mirrors `reconcile.ts` without importing it. */
export function getStatementCurrency(statement: Statement): string {
  return statement.summary.components[0]?.currency ?? 'CNY'
}

/**
 * Derive the bank-stated net movement for one cycle without guessing.
 *
 * Priority:
 *   1. `detail`: `newDebit + charge + interest - newCredit`
 *      (requires both `newDebitMinor` and `newCreditMinor`; missing
 *      `charge`/`interest` are treated as 0, exactly like the existing
 *      balance equation — a missing fee line means "no fee stated").
 *   2. `balance`: `current - previous`
 *      (requires both balances; used when the detail split is absent).
 *   3. `none`: no reliable total — caller must report `insufficient`.
 */
export function getStatementExpectedTotal(statement: Statement): ExpectedTotal {
  const currency = getStatementCurrency(statement)
  const s = statement.summary

  if (s.newDebitMinor !== null && s.newCreditMinor !== null) {
    const expected = s.newDebitMinor + (s.chargeMinor ?? 0) + (s.interestMinor ?? 0) - s.newCreditMinor
    return { expectedMinor: expected, currency, available: true, source: 'detail' }
  }

  if (s.previousBalanceMinor !== null && s.currentBalanceMinor !== null) {
    return {
      expectedMinor: s.currentBalanceMinor - s.previousBalanceMinor,
      currency,
      available: true,
      source: 'balance',
    }
  }

  return { expectedMinor: null, currency, available: false, source: 'none' }
}

export function describeReconciliationStatus(status: ReconciliationStatus): string {
  switch (status) {
    case 'passed':
      return '通过'
    case 'mismatch':
      return '不匹配'
    case 'insufficient':
      return '信息不足'
  }
}

/**
 * Pure statement reconciliation. Single pass over `transactions`, O(n).
 *
 * - `rejected` rows are ignored (same as `reconcile.ts`).
 * - Source-evidenced unposted originals are ignored for the amount total: the bank
 *   prints the original purchase for information but only posts the per-cycle
 *   `installment_payment`. Counting both would double-count spending.
 * - Only rows in the statement currency are summed; other currencies are
 *   reported in `reason` instead of being silently mixed.
 */
export function reconcileStatementTransactions(
  statement: Statement,
  transactions: readonly Transaction[],
): StatementReconciliationResult {
  const currency = getStatementCurrency(statement)
  const expected = getStatementExpectedTotal(statement)

  let transactionCount = 0
  let transactionTotalMinor = 0
  let ignoredCurrency = 0
  let directionConflicts = 0
  let debitTotalMinor = 0, creditTotalMinor = 0

  for (const tx of transactions) {
    if (tx.statementId !== statement.id) continue
    if (tx.reviewStatus === 'rejected') continue
    if (hasUnresolvedDirection(tx)) directionConflicts++
    if (tx.postingExclusion) continue
    transactionCount += 1
    if (tx.settlementCurrency !== currency) {
      ignoredCurrency += 1
      continue
    }
    transactionTotalMinor += (effectiveAmountForDirection(tx) ?? 0)
    if (effectiveDirection(tx) === 'debit') debitTotalMinor += (effectiveAmountForDirection(tx) ?? 0)
    else creditTotalMinor -= (effectiveAmountForDirection(tx) ?? 0)
  }

  // --- 1. transaction count -------------------------------------------------
  if (transactionCount === 0) {
    return {
      status: 'insufficient',
      transactionCount: 0,
      transactionTotalMinor: 0,
      expectedTotalMinor: expected.expectedMinor,
      differenceMinor: null,
      currency,
      bankTotalAvailable: expected.available,
      reason: '该账单下没有可核验的交易，无法完成核验',
      expectedSource: expected.source,
    }
  }

  // --- 2. amount total ------------------------------------------------------
  if (!expected.available || expected.expectedMinor === null) {
    return {
      status: 'insufficient',
      transactionCount,
      transactionTotalMinor,
      expectedTotalMinor: null,
      differenceMinor: null,
      currency,
      bankTotalAvailable: false,
      reason: '账单缺少可靠的银行金额字段（新增支出/还款或上期/本期余额），无法核验，不伪造数据',
      expectedSource: 'none',
    }
  }

  const differenceMinor = expected.expectedMinor - transactionTotalMinor
  const directionTotalsMatch = expected.source !== 'detail' ||
    (debitTotalMinor === statement.summary.newDebitMinor! + (statement.summary.chargeMinor ?? 0) + (statement.summary.interestMinor ?? 0) &&
      creditTotalMinor === statement.summary.newCreditMinor)
  if (differenceMinor === 0 && directionConflicts === 0 && directionTotalsMatch) {
    return {
      status: 'passed',
      transactionCount,
      transactionTotalMinor,
      expectedTotalMinor: expected.expectedMinor,
      differenceMinor: 0,
      currency,
      bankTotalAvailable: true,
      reason:
        ignoredCurrency > 0
          ? `${transactionCount} 笔（另有 ${ignoredCurrency} 笔非 ${currency} 交易未计入）合计 ${formatMinor(transactionTotalMinor, currency)}，与银行金额一致`
          : `${transactionCount} 笔合计 ${formatMinor(transactionTotalMinor, currency)}，与银行金额一致`,
      expectedSource: expected.source,
    }
  }

  return {
    status: 'mismatch',
    transactionCount,
    transactionTotalMinor,
    expectedTotalMinor: expected.expectedMinor,
    differenceMinor,
    currency,
    bankTotalAvailable: true,
    reason: `${directionConflicts ? `${directionConflicts} 笔借贷方向冲突；` : ''}${!directionTotalsMatch ? '借记/贷记分项与银行汇总不符；' : ''}${transactionCount} 笔合计 ${formatMinor(transactionTotalMinor, currency)}，银行金额为 ${formatMinor(expected.expectedMinor, currency)}，差额 ${formatMinor(differenceMinor, currency)}`,
    expectedSource: expected.source,
  }
}

/**
 * Group transactions by `statementId` in one pass. O(n) time, O(m) memory
 * where m is the number of statements. Pure: the input array is never
 * mutated and each bucket is a fresh array.
 */
export function groupTransactionsByStatement(
  transactions: readonly Transaction[],
): Map<string, Transaction[]> {
  const groups = new Map<string, Transaction[]>()
  for (const tx of transactions) {
    const bucket = groups.get(tx.statementId)
    if (bucket) bucket.push(tx)
    else groups.set(tx.statementId, [tx])
  }
  return groups
}

/**
 * Reconcile many statements with a single grouping pass. Total cost is
 * O(transactions + statements) — opening the page never triggers per-row
 * React updates; call once inside `useMemo`.
 */
export function reconcileManyStatements(
  statements: readonly Statement[],
  transactions: readonly Transaction[],
): Map<string, StatementReconciliationResult> {
  const groups = groupTransactionsByStatement(transactions)
  const out = new Map<string, StatementReconciliationResult>()
  for (const statement of statements) {
    out.set(statement.id, reconcileStatementTransactions(statement, groups.get(statement.id) ?? []))
  }
  return out
}

/**
 * Memoization helper so repeated page opens with unchanged array references
 * skip the full recomputation entirely. The cache is reference-based (no
 * deep hashing, no schema change): same `statements` + `transactions`
 * references return the identical `Map` object.
 */
export function createReconciliationCache(): {
  reconcile(
    statements: readonly Statement[],
    transactions: readonly Transaction[],
  ): Map<string, StatementReconciliationResult>
  clear(): void
  stats(): { hits: number; misses: number }
} {
  let cachedStatements: readonly Statement[] | null = null
  let cachedTransactions: readonly Transaction[] | null = null
  let cachedResult: Map<string, StatementReconciliationResult> | null = null
  let hits = 0
  let misses = 0

  return {
    reconcile(statements, transactions) {
      if (cachedResult && cachedStatements === statements && cachedTransactions === transactions) {
        hits += 1
        return cachedResult
      }
      misses += 1
      cachedStatements = statements
      cachedTransactions = transactions
      cachedResult = reconcileManyStatements(statements, transactions)
      return cachedResult
    },
    clear() {
      cachedStatements = null
      cachedTransactions = null
      cachedResult = null
      hits = 0
      misses = 0
    },
    stats() {
      return { hits, misses }
    },
  }
}

/**
 * Adapt the lightweight summary to the existing `ReconciliationResult`
 * shape so it can be stored in `Statement.reconciliation` without any
 * schema change. The detailed `reconcile.ts` checks remain the source of
 * truth for imports; this adapter exists so the first-phase result can be
 * persisted or compared without inventing a new field.
 */
export function toReconciliationResult(result: StatementReconciliationResult): ReconciliationResult {
  return {
    status: result.status,
    computedBalanceMinor: result.expectedTotalMinor,
    checks: [
      {
        id: 'transaction_count',
        label: '账单至少包含一笔交易',
        status: result.transactionCount > 0 ? 'passed' : 'missing',
        expectedMinor: null,
        actualMinor: result.transactionCount,
        differenceMinor: null,
        detail:
          result.transactionCount > 0 ? `共 ${result.transactionCount} 笔交易` : '没有解析到任何交易',
      },
      {
        id: 'statement_total',
        label: '交易金额合计 = 银行账单金额',
        status: !result.bankTotalAvailable ? 'missing' : result.status === 'passed' ? 'passed' : 'mismatch',
        expectedMinor: result.expectedTotalMinor,
        actualMinor: result.bankTotalAvailable ? result.transactionTotalMinor : null,
        differenceMinor: result.differenceMinor,
        detail: result.reason,
      },
    ],
  }
}
