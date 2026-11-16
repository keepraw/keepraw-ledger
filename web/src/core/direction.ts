import type { Transaction } from './types'

type AmountDirection = Pick<Transaction, 'transactionAmountMinor' | 'settlementAmountMinor' | 'direction'>

/** Zero has no sign; missing amounts are handled separately. */
export function hasAmountDirectionConflict(row: AmountDirection): boolean {
  return [row.transactionAmountMinor, row.settlementAmountMinor].some(amount =>
    amount !== 0 && (amount < 0) !== (row.direction === 'credit'))
}

/** Financial eligibility never depends on legacy type metadata. */
export function isPostedTransaction(row: Transaction): boolean {
  return row.reviewStatus !== 'rejected' && !row.postingExclusion && !hasAmountDirectionConflict(row) &&
    (!row.flags.includes('amount_direction_unclear') || row.reviewStatus === 'confirmed')
}

/** Immutable, idempotent compatibility boundary, shared by upgrade and restore. */
export function repairDirectionReview(row: Transaction): Transaction {
  const oldFlags: readonly string[] = row.flags
  const hadTypeFlag = oldFlags.includes('transaction_type_unclear')
  const conflict = hasAmountDirectionConflict(row)
  // Also repair a previously cleaned row whose real direction flag was kept
  // with an incorrect ok status. Preserve explicit human decisions.
  if (!hadTypeFlag && !(conflict && row.flags.includes('amount_direction_unclear') && row.reviewStatus === 'ok')) return row
  const flags = row.flags.filter(flag => (flag as string) !== 'transaction_type_unclear')
  if (conflict && !flags.includes('amount_direction_unclear')) flags.push('amount_direction_unclear')
  const reviewStatus = row.reviewStatus === 'confirmed' || row.reviewStatus === 'rejected' ? row.reviewStatus
    : conflict ? 'pending' : row.reviewStatus === 'pending' && flags.length === 0 ? 'ok' : row.reviewStatus
  return { ...row, flags, reviewStatus }
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
