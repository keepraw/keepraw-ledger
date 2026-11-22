import { isPostingExcluded, hasUnresolvedDirection, effectiveCurrencyForDirection, effectiveAmountForDirection, effectiveDirection, isPostedTransaction } from './direction'
import { formatMinor, normalizeCurrencyCode } from './money'
import type { ReconciliationCheck, ReconciliationResult, StatementSummary, Transaction } from './types'

/**
 * Statement reconciliation.
 *
 * Parsing transactions successfully is NOT enough to call a statement correct.
 * Reconciliation checks run for every statement:
 *
 *   1. balance_equation  本期余额 = 上期余额 + 本期支出 + 费用 + 利息 − 本期还款及其他贷记 − 本期调整金额
 *   2. debit_detail / credit_detail for gross detail, or net_detail for bank-netted detail
 *
 * Any mismatch, or missing summary data, yields `mismatch` / `insufficient` and the
 * statement is routed to manual review instead of being folded into the statistics.
 */

export interface ReconcileInput {
  summary: StatementSummary
  transactions: Transaction[]
}

export function reconcileStatement(input: ReconcileInput): ReconciliationResult {
  const { summary, transactions } = input
  const checks: ReconciliationCheck[] = []
  const currency = summary.components[0]?.currency ?? 'CNY'

  const unrejected = transactions.filter((tx) => tx.reviewStatus !== 'rejected')
  const active = unrejected.filter(tx => !isPostingExcluded(tx))
  const conflicts = unrejected.filter(tx => hasUnresolvedDirection(tx))
  if (conflicts.length) checks.push({ id: 'amount_direction', label: '交易金额与借贷方向一致', status: 'mismatch',
    expectedMinor: 0, actualMinor: conflicts.length, differenceMinor: null, detail: `${conflicts.length} 笔交易存在借贷方向或金额符号冲突，需人工复核` })
  const otherCurrencies = active.filter((tx) => normalizeCurrencyCode(effectiveCurrencyForDirection(tx)) !== normalizeCurrencyCode(currency))
  if (otherCurrencies.length > 0) {
    checks.push({
      id: 'other_currencies', label: '其他结算币种单独保留', status: 'skipped',
      expectedMinor: null, actualMinor: null, differenceMinor: null,
      detail: `${otherCurrencies.length} 笔非 ${currency} 结算交易未纳入本次 ${currency} 对账；未进行汇率换算`,
    })
  }

  // --- 1. balance equation -------------------------------------------------
  const hasPrevious = summary.previousBalanceMinor !== null
  const hasCurrent = summary.currentBalanceMinor !== null
  if (!hasPrevious || !hasCurrent) {
    checks.push({
      id: 'balance_equation',
      label: '本期余额 = 上期余额 + 本期支出 + 费用 + 利息 − 本期还款及其他贷记 − 本期调整金额',
      status: 'missing',
      expectedMinor: null,
      actualMinor: null,
      differenceMinor: null,
      detail: `账单缺少${!hasPrevious ? '上期余额' : ''}${!hasPrevious && !hasCurrent ? '和' : ''}${
        !hasCurrent ? '本期应还金额' : ''
      }，无法完成对账`,
    })
  } else {
    const debit = summary.newDebitMinor ?? 0
    const credit = summary.newCreditMinor ?? 0
    const charge = summary.chargeMinor ?? 0
    const interest = summary.interestMinor ?? 0
    // 本期余额 = 上期余额 + 本期新增支出 + 费用 + 利息 − 本期还款及其他贷记 − 本期调整金额
    const computed = summary.previousBalanceMinor! + debit + charge + interest - credit - (summary.adjustmentMinor ?? 0)
    const difference = summary.currentBalanceMinor! - computed
    checks.push({
      id: 'balance_equation',
      label: '本期余额 = 上期余额 + 本期支出 + 费用 + 利息 − 本期还款及其他贷记 − 本期调整金额',
      status: difference === 0 ? 'passed' : 'mismatch',
      expectedMinor: computed,
      actualMinor: summary.currentBalanceMinor,
      differenceMinor: difference,
      detail:
        difference === 0
          ? `${formatMinor(computed, currency)} 与账单本期应还一致`
          : `按账单汇总计算应为 ${formatMinor(computed, currency)}，账单显示 ${formatMinor(
              summary.currentBalanceMinor!,
              currency,
            )}，差额 ${formatMinor(difference, currency)}`,
    })
  }

  // --- 2. new spending detail ----------------------------------------------
  if (summary.detailBasis === 'net') {
    checks.push(netDetailCheck(summary, active, currency))
  } else {
    checks.push(
      detailCheck(
        'debit_detail',
        '交易明细借记合计 = 本期新增支出 + 费用 + 利息',
        'debit',
        summary.newDebitMinor === null ? null : summary.newDebitMinor + (summary.chargeMinor ?? 0) + (summary.interestMinor ?? 0),
        active,
        currency,
      ),
    )
  }

  // --- 3. charges and interest ---------------------------------------------
  if (summary.chargeMinor !== null || summary.interestMinor !== null) {
    checks.push({
      id: 'charges_detail',
      label: '交易明细手续费/利息合计 = 本期费用 + 利息',
      status: 'skipped',
      expectedMinor: (summary.chargeMinor ?? 0) + (summary.interestMinor ?? 0),
      actualMinor: null,
      differenceMinor: null,
      detail: '未提供可靠的逐笔费用/利息字段，跳过细分核验；金额仍计入借记总额核验',
    })
  }

  // --- 4. credit detail ----------------------------------------------------
  if (summary.detailBasis !== 'net') {
    checks.push(
      detailCheck(
        'credit_detail',
        '交易明细贷记合计 = 本期贷记汇总',
        'credit',
        summary.newCreditMinor,
        active,
        currency,
      ),
    )
  }

  // --- 5. transaction count ------------------------------------------------
  if (active.length === 0) {
    checks.push({
      id: 'transaction_count',
      label: '账单至少包含一笔交易',
      status: 'missing',
      expectedMinor: null,
      actualMinor: 0,
      differenceMinor: null,
      detail: '没有解析到任何交易',
    })
  } else {
    checks.push({
      id: 'transaction_count',
      label: '账单至少包含一笔交易',
      status: 'passed',
      expectedMinor: null,
      actualMinor: active.length,
      differenceMinor: null,
      detail: `共 ${active.length} 笔交易`,
    })
  }

  const hasMissing = checks.some((check) => check.status === 'missing')
  const hasMismatch = checks.some((check) => check.status === 'mismatch')
  const status: ReconciliationResult['status'] = hasMismatch ? 'mismatch' : hasMissing ? 'insufficient' : 'passed'

  return { status, checks, computedBalanceMinor: checks.find((check) => check.id === 'balance_equation')?.actualMinor ?? null }
}

function detailCheck(
  id: string,
  label: string,
  direction: 'debit' | 'credit',
  expected: number | null,
  transactions: Transaction[],
  currency: string,
): ReconciliationCheck {
  if (expected === null) {
    return {
      id,
      label,
      status: 'missing',
      expectedMinor: null,
      actualMinor: null,
      differenceMinor: null,
      detail: '账单缺少该分项的汇总金额，无法核对交易明细',
    }
  }

  const relevant = transactions.filter((tx) => {
    if (hasUnresolvedDirection(tx)) return false
    if (effectiveDirection(tx) !== direction) return false
    if (effectiveCurrencyForDirection(tx) !== currency) return false
    return !isPostingExcluded(tx)
  })

  // Credit rows are stored as negative amounts, so compare magnitudes.
  const actual = relevant.reduce((sum, tx) => sum + (effectiveDirection(tx) === 'credit' ? -(effectiveAmountForDirection(tx) ?? 0) : (effectiveAmountForDirection(tx) ?? 0)), 0)
  const difference = expected - actual
  return {
    id,
    label,
    status: difference === 0 ? 'passed' : 'mismatch',
    expectedMinor: expected,
    actualMinor: actual,
    differenceMinor: difference,
    detail:
      difference === 0
        ? `${relevant.length} 笔合计 ${formatMinor(actual, currency)}，与账单一致`
        : `${relevant.length} 笔合计 ${formatMinor(actual, currency)}，账单分项为 ${formatMinor(
            expected,
            currency,
          )}，差额 ${formatMinor(difference, currency)}`,
  }
}

function netDetailCheck(
  summary: StatementSummary,
  transactions: Transaction[],
  currency: string,
): ReconciliationCheck {
  const expected = summary.newDebitMinor === null || summary.newCreditMinor === null
    ? null
    : summary.newDebitMinor + (summary.chargeMinor ?? 0) + (summary.interestMinor ?? 0) - summary.newCreditMinor
  if (expected === null) {
    return {
      id: 'net_detail',
      label: '交易明细净额 = 本期新增 + 费用 + 利息 − 本期贷记',
      status: 'missing',
      expectedMinor: null,
      actualMinor: null,
      differenceMinor: null,
      detail: '账单缺少本期新增或本期贷记汇总金额，无法核对交易明细净额',
    }
  }

  const relevant = transactions.filter((tx) =>
    !hasUnresolvedDirection(tx) &&
    effectiveCurrencyForDirection(tx) === currency &&
    !isPostingExcluded(tx),
  )
  const actual = relevant.reduce((sum, tx) => {
    const amount = effectiveAmountForDirection(tx) ?? 0
    return sum + (effectiveDirection(tx) === 'credit' ? -Math.abs(amount) : Math.abs(amount))
  }, 0)
  const difference = expected - actual
  return {
    id: 'net_detail',
    label: '交易明细净额 = 本期新增 + 费用 + 利息 − 本期贷记',
    status: difference === 0 ? 'passed' : 'mismatch',
    expectedMinor: expected,
    actualMinor: actual,
    differenceMinor: difference,
    detail: difference === 0
      ? `${relevant.length} 笔净额 ${formatMinor(actual, currency)}，与账单一致`
      : `${relevant.length} 笔净额 ${formatMinor(actual, currency)}，账单分项为 ${formatMinor(expected, currency)}，差额 ${formatMinor(difference, currency)}`,
  }
}

/** Direction totals in a single settlement currency, with no business guesses. */
export interface DirectionTotals {
  billingDebitMinor: number
  billingCreditMinor: number
  netMinor: number
  transactionCount: number
}

export function summarizeTransactions(transactions: Transaction[], currency = 'CNY'): DirectionTotals {
  const result: DirectionTotals = { billingDebitMinor: 0, billingCreditMinor: 0, netMinor: 0, transactionCount: 0 }
  for (const tx of transactions) {
    if (!isPostedTransaction(tx)) continue
    if (normalizeCurrencyCode(effectiveCurrencyForDirection(tx)) !== normalizeCurrencyCode(currency)) continue
    if (effectiveDirection(tx) === 'debit') result.billingDebitMinor += (effectiveAmountForDirection(tx) ?? 0)
    else result.billingCreditMinor += -(effectiveAmountForDirection(tx) ?? 0)
    result.transactionCount++
  }
  result.netMinor = result.billingDebitMinor - result.billingCreditMinor
  return result
}
