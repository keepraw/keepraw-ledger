import { isSupportedCurrency, parseAmountToMinor } from './money'
import type { Transaction } from './types'

type DirectionRow = Pick<Transaction, 'direction' | 'directionEvidence' | 'directionResolution' | 'bankColumnAmounts'> & { bank?: Transaction['bank'] }

type AmountDirection = Pick<Transaction, 'transactionAmountMinor' | 'settlementAmountMinor' | 'direction'>

/** Zero has no sign; missing amounts are handled separately. */
export function hasAmountDirectionConflict(row: AmountDirection): boolean {
  return [row.transactionAmountMinor, row.settlementAmountMinor].some(amount =>
    amount !== 0 && (amount < 0) !== (row.direction === 'credit'))
}

/** Old records without independent evidence must explicitly choose a direction
 * when they have a direction issue. A generic review confirmation is insufficient. */
/** Older BOC dual-column rows retained only an identity projection. Never invent
 * the missing column or trust an old direction-only decision as an amount choice. */
export function needsBankColumnChoice(row: Pick<DirectionRow, 'bank' | 'directionEvidence' | 'bankColumnAmounts'>): boolean {
  return !!row.bankColumnAmounts || (row.bank === 'boc' && row.directionEvidence?.kind === 'missing' &&
    row.directionEvidence.detail === '中国银行同一行同时出现借记和贷记金额列，无法确定唯一方向')
}

export function hasResolvedDirection(row: DirectionRow): boolean {
  const resolution = row.directionResolution
  if (!resolution || !['debit', 'credit'].includes(resolution.direction)) return false
  if (needsBankColumnChoice(row)) return !!row.bankColumnAmounts && resolution.method === 'user_choice' &&
    resolution.amountSource === (resolution.direction === 'debit' ? 'debit_column' : 'credit_column')
  if (resolution.amountSource !== undefined) return false
  return row.directionEvidence?.kind === 'bank'
    ? resolution.method === 'accept_bank' && resolution.direction === row.direction
    : resolution.method === 'user_choice'
}

export function hasUnresolvedDirection(row: DirectionRow & Pick<Transaction, 'flags' | 'transactionAmountMinor' | 'settlementAmountMinor'>): boolean {
  return !hasResolvedDirection(row) && (needsBankColumnChoice(row) || hasAmountDirectionConflict(row) ||
    row.flags.includes('amount_direction_unclear') || row.directionEvidence?.kind === 'missing')
}

/** Stored direction is bank/identity metadata; the explicit decision is final. */
export function effectiveDirection(row: DirectionRow): Transaction['direction'] {
  return hasResolvedDirection(row) ? row.directionResolution!.direction : row.direction
}

/** The ONLY monetary interpretation used by financial consumers. Never mutate
 * source amounts. Null means the user has not resolved the direction yet. */
export function effectiveAmountForDirection(row: Transaction, leg: 'transaction' | 'settlement' = 'settlement'): number | null {
  if (hasUnresolvedDirection(row)) return null
  const selected = hasResolvedDirection(row) ? row.bankColumnAmounts?.[effectiveDirection(row)] : undefined
  const amount = selected?.amountMinor ?? (leg === 'transaction' ? row.transactionAmountMinor : row.settlementAmountMinor)
  return hasResolvedDirection(row) ? Math.abs(amount) * (effectiveDirection(row) === 'credit' ? -1 : 1) : amount
}

/** Same selected bank column supplies the currency as well as the amount. */
export function effectiveCurrencyForDirection(row: Transaction, leg: 'transaction' | 'settlement' = 'settlement'): string {
  return (hasResolvedDirection(row) ? row.bankColumnAmounts?.[effectiveDirection(row)]?.currency : undefined) ??
    (leg === 'transaction' ? row.transactionCurrency : row.settlementCurrency)
}

/** Stable comparison ignores JSON property order, but never loses source evidence
 * or an amount-source decision when a duplicate ID is restored. */
export function bankColumnSelectionKey(row: Pick<Transaction, 'bankColumnAmounts' | 'directionResolution'>): string {
  const columns = row.bankColumnAmounts
  return JSON.stringify([columns ? [columns.source, columns.rowBinding,
    ...[columns.debit, columns.credit].map(value => [value.direction, value.currency, value.amountMinor, value.rawText])] : null,
    row.directionResolution?.amountSource ?? null])
}

/** A BOC original-principal marker is debit evidence. On a dual-column row
 * its exclusion applies only when that debit source is actually selected.
 * All existing single-amount/plan/legacy exclusions retain their old effect. */
export function isPostingExcluded(row: DirectionRow & Pick<Transaction, 'postingExclusion'>): boolean {
  return !!row.postingExclusion && !(row.bankColumnAmounts && row.postingExclusion.source === 'bank_original_marker' &&
    hasResolvedDirection(row) && effectiveDirection(row) === 'credit')
}

/** Financial eligibility never depends on legacy type metadata or generic confirmation. */
export function isPostedTransaction(row: Transaction): boolean {
  return row.reviewStatus !== 'rejected' && !isPostingExcluded(row) && !hasUnresolvedDirection(row)
}

/** Validate explicit decisions and keep unrelated review reasons intact. Shared
 * by durable edits, bulk review and the isolated in-memory demo. */
export function applyReviewPatch(current: Transaction, patch: Partial<Transaction>): Transaction {
  const next = { ...current, ...patch }
  if (patch.directionResolution !== undefined) {
    if (['direction', 'transactionAmountMinor', 'settlementAmountMinor', 'transactionCurrency', 'settlementCurrency']
      .some(key => next[key as keyof Transaction] !== current[key as keyof Transaction]) ||
      JSON.stringify(next.directionEvidence) !== JSON.stringify(current.directionEvidence) ||
      bankColumnSelectionKey({ ...next, directionResolution: current.directionResolution }) !== bankColumnSelectionKey(current) || !hasResolvedDirection(next)) {
      throw new Error('方向确认无效；必须接受银行方向或明确选择借记/贷记，不能改写原始金额与依据。')
    }
    next.flags = current.flags.filter(flag => flag !== 'amount_direction_unclear')
    next.reviewStatus = current.reviewStatus === 'rejected' ? 'rejected' : next.flags.length ? 'pending' : 'confirmed'
  } else if (bankColumnSelectionKey(next) !== bankColumnSelectionKey(current)) {
    throw new Error('不能改写银行原始双列金额证据。')
  } else if (patch.reviewStatus === 'confirmed' && hasUnresolvedDirection(current)) {
    throw new Error('请先明确接受银行方向，或选择借记/贷记；普通确认不能解决方向问题。')
  } else if (hasUnresolvedDirection(current) && !next.flags.includes('amount_direction_unclear')) {
    next.flags = [...next.flags, 'amount_direction_unclear']
  }
  return next
}

/** Immutable, idempotent compatibility boundary shared by upgrade and restore. */
export function repairDirectionReview(row: Transaction): Transaction {
  const oldFlags: readonly string[] = row.flags
  const resolved = hasResolvedDirection(row)
  if (!oldFlags.includes('transaction_type_unclear') &&
    !(hasUnresolvedDirection(row) && (row.flags.includes('amount_direction_unclear') || row.directionEvidence?.kind === 'missing') && row.reviewStatus === 'ok') &&
    !(resolved && row.flags.includes('amount_direction_unclear')) &&
    !(needsBankColumnChoice(row) && !resolved && !row.flags.includes('amount_direction_unclear'))) return row
  const flags = row.flags.filter(flag => (flag as string) !== 'transaction_type_unclear' && !(resolved && flag === 'amount_direction_unclear'))
  const unresolved = hasUnresolvedDirection({ ...row, flags })
  if (unresolved && !flags.includes('amount_direction_unclear')) flags.push('amount_direction_unclear')
  const reviewStatus = row.reviewStatus === 'confirmed' || row.reviewStatus === 'rejected' ? row.reviewStatus
    : unresolved ? 'pending' : row.reviewStatus === 'pending' && flags.length === 0 ? 'ok' : row.reviewStatus
  return flags.length === row.flags.length && flags.every((flag, i) => flag === row.flags[i]) && reviewStatus === row.reviewStatus
    ? row : { ...row, flags, reviewStatus }
}

/** Optional JSON/XLSX metadata is strictly validated, never interpreted as a type. */
export function validDirectionMetadata(row: { bank?: unknown; direction?: unknown; directionEvidence?: unknown; directionResolution?: unknown; bankColumnAmounts?: unknown; rawText?: unknown }): boolean {
  const evidence = row.directionEvidence as Transaction['directionEvidence']
  const resolution = row.directionResolution as Transaction['directionResolution']
  const columns = row.bankColumnAmounts as Transaction['bankColumnAmounts']
  if (evidence !== undefined && (!evidence || !['bank', 'missing'].includes(evidence.kind) ||
    typeof evidence.detail !== 'string' || !evidence.detail.trim())) return false
  if (columns !== undefined) {
    if (!columns || typeof row.rawText !== 'string' || row.bank !== 'boc' || columns.source !== 'boc_pdf' || columns.rowBinding !== 'single_transaction_anchor' || evidence?.kind !== 'missing') return false
    for (const direction of ['debit', 'credit'] as const) {
      const value = columns[direction]
      if (!value || value.direction !== direction || typeof value.rawText !== 'string' || !value.rawText.trim() ||
        !Number.isSafeInteger(value.amountMinor) || typeof value.currency !== 'string' || !/^[A-Z]{3}$/.test(value.currency) || !isSupportedCurrency(value.currency)) return false
      if (!` ${row.rawText.replace(/\s+/g, ' ').trim()} `.includes(` ${value.rawText.replace(/\s+/g, ' ').trim()} `)) return false
      try { if (parseAmountToMinor(value.rawText, value.currency)?.minor !== value.amountMinor) return false } catch { return false }
    }
  }
  if (resolution === undefined) return true
  if (!resolution || !['debit', 'credit'].includes(resolution.direction)) return false
  if (columns) return resolution.method === 'user_choice' && resolution.amountSource ===
    (resolution.direction === 'debit' ? 'debit_column' : 'credit_column')
  if (resolution.amountSource !== undefined) return false
  // Old formats may retain an unbound choice verbatim; hasResolvedDirection
  // deliberately excludes known old BOC dual-column rows until evidence exists.
  return evidence?.kind === 'bank' ? resolution.method === 'accept_bank' && resolution.direction === row.direction
    : resolution.method === 'user_choice'
}

/** Preserve the OLD exclusion decision at old-format boundaries only. Never
 * infer new exclusions from type. New parser imports carry bank-plan evidence.
 * The old row did not retain the plan; label this limitation explicitly.
 */
export function preserveLegacyPostingExclusion<T extends Pick<Transaction, 'type' | 'rawText' | 'postingExclusion'>>(row: T): T & Pick<Transaction, 'postingExclusion'> {
  if (row.postingExclusion !== undefined || row.type !== 'installment_original') return row
  return { ...row, postingExclusion: { source: 'legacy_installment_exclusion',
    detail: '保留旧版本已排除的分期原始记录；旧格式未保存独立计划依据。原始片段：' + row.rawText } }
}

/** Supported statement formats distinguish original principal from the explicit
 * per-cycle posting token. Retain the actual source token and row, not a type.
 */
export function postingExclusionFromBankToken(token: string, rawText: string, direction: Transaction['direction']): Transaction['postingExclusion'] {
  return direction === 'debit' && ['分期消费原始', '分期原始', '商户分期'].includes(token)
    ? { source: 'bank_original_marker', detail: `${token} | ${rawText}` } : null
}
