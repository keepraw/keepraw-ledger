import type { Transaction } from './types'

type AmountDirection = Pick<Transaction, 'transactionAmountMinor' | 'settlementAmountMinor' | 'direction'>

/** Zero has no sign; missing amounts are handled separately. */
export function hasAmountDirectionConflict(row: AmountDirection): boolean {
  return [row.transactionAmountMinor, row.settlementAmountMinor].some(amount =>
    amount !== 0 && (amount < 0) !== (row.direction === 'credit'))
}

/** Old records without independent evidence must explicitly choose a direction
 * when they have a direction issue. A generic review confirmation is insufficient. */
export function hasResolvedDirection(row: Pick<Transaction, 'direction' | 'directionEvidence' | 'directionResolution'>): boolean {
  const resolution = row.directionResolution
  return !!resolution && (resolution.direction === 'debit' || resolution.direction === 'credit') &&
    (row.directionEvidence?.kind === 'bank'
      ? resolution.method === 'accept_bank' && resolution.direction === row.direction
      : resolution.method === 'user_choice')
}

export function hasUnresolvedDirection(row: Pick<Transaction, 'direction' | 'directionEvidence' | 'directionResolution' | 'flags' | 'transactionAmountMinor' | 'settlementAmountMinor'>): boolean {
  return !hasResolvedDirection(row) && (hasAmountDirectionConflict(row) ||
    row.flags.includes('amount_direction_unclear') || row.directionEvidence?.kind === 'missing')
}

/** Stored direction is bank/identity metadata; the explicit decision is final. */
export function effectiveDirection(row: Pick<Transaction, 'direction' | 'directionEvidence' | 'directionResolution'>): Transaction['direction'] {
  return hasResolvedDirection(row) ? row.directionResolution!.direction : row.direction
}

/** The ONLY monetary interpretation used by financial consumers. Never mutate
 * source amounts. Null means the user has not resolved the direction yet. */
export function effectiveAmountForDirection(row: Transaction, leg: 'transaction' | 'settlement' = 'settlement'): number | null {
  if (hasUnresolvedDirection(row)) return null
  const amount = leg === 'transaction' ? row.transactionAmountMinor : row.settlementAmountMinor
  return hasResolvedDirection(row) ? Math.abs(amount) * (effectiveDirection(row) === 'credit' ? -1 : 1) : amount
}

/** Financial eligibility never depends on legacy type metadata or generic confirmation. */
export function isPostedTransaction(row: Transaction): boolean {
  return row.reviewStatus !== 'rejected' && !row.postingExclusion && !hasUnresolvedDirection(row)
}

/** Validate explicit decisions and keep unrelated review reasons intact. Shared
 * by durable edits, bulk review and the isolated in-memory demo. */
export function applyReviewPatch(current: Transaction, patch: Partial<Transaction>): Transaction {
  const next = { ...current, ...patch }
  if (patch.directionResolution !== undefined) {
    if (['direction', 'transactionAmountMinor', 'settlementAmountMinor', 'transactionCurrency', 'settlementCurrency']
      .some(key => next[key as keyof Transaction] !== current[key as keyof Transaction]) ||
      JSON.stringify(next.directionEvidence) !== JSON.stringify(current.directionEvidence) || !hasResolvedDirection(next)) {
      throw new Error('方向确认无效；必须接受银行方向或明确选择借记/贷记，不能改写原始金额与依据。')
    }
    next.flags = current.flags.filter(flag => flag !== 'amount_direction_unclear')
    next.reviewStatus = current.reviewStatus === 'rejected' ? 'rejected' : next.flags.length ? 'pending' : 'confirmed'
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
    !(resolved && row.flags.includes('amount_direction_unclear'))) return row
  const flags = row.flags.filter(flag => (flag as string) !== 'transaction_type_unclear' && !(resolved && flag === 'amount_direction_unclear'))
  const unresolved = hasUnresolvedDirection({ ...row, flags })
  if (unresolved && !flags.includes('amount_direction_unclear')) flags.push('amount_direction_unclear')
  const reviewStatus = row.reviewStatus === 'confirmed' || row.reviewStatus === 'rejected' ? row.reviewStatus
    : unresolved ? 'pending' : row.reviewStatus === 'pending' && flags.length === 0 ? 'ok' : row.reviewStatus
  return flags.length === row.flags.length && flags.every((flag, i) => flag === row.flags[i]) && reviewStatus === row.reviewStatus
    ? row : { ...row, flags, reviewStatus }
}

/** Optional JSON/XLSX metadata is strictly validated, never interpreted as a type. */
export function validDirectionMetadata(row: { direction?: unknown; directionEvidence?: unknown; directionResolution?: unknown }): boolean {
  const evidence = row.directionEvidence as Transaction['directionEvidence']
  const resolution = row.directionResolution as Transaction['directionResolution']
  if (evidence !== undefined && (!evidence || !['bank', 'missing'].includes(evidence.kind) ||
    typeof evidence.detail !== 'string' || !evidence.detail.trim())) return false
  if (resolution === undefined) return true
  return !!resolution && ['debit', 'credit'].includes(resolution.direction) &&
    (evidence?.kind === 'bank' ? resolution.method === 'accept_bank' && resolution.direction === row.direction
      : resolution.method === 'user_choice')
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
