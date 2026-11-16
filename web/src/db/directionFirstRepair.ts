import type { Transaction as UpgradeTransaction } from 'dexie'
import { preserveLegacyPostingExclusion, repairDirectionReview } from '../core/direction'
import type { Transaction } from '../core/types'

export async function repairDirectionFirst(transaction: UpgradeTransaction): Promise<void> {
  await transaction.table<Transaction>('transactions').toCollection().modify(row => {
    const next = preserveLegacyPostingExclusion(repairDirectionReview(row))
    if (next === row) return false
    // No identity, money, category, source or user text is rewritten.
    row.flags = next.flags
    row.reviewStatus = next.reviewStatus
    if (next.postingExclusion) row.postingExclusion = next.postingExclusion
  })
}
