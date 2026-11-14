import type { Transaction } from '../core/types'
import { withoutLegacyMerchant } from './transactionRecord'

/** Immutable restore boundary for V1/V2 JSON and ZIP. Never recover missing metadata. */
export function normalizeRestoredTransaction(transaction: Transaction): Transaction {
  const row = withoutLegacyMerchant(transaction)
  return row.origin === 'legacy_import' && row.sourceId === 'legacy-keepraw-ledger-export-v1' && row.flags.includes('low_confidence')
    ? { ...row, flags: row.flags.filter(flag => flag !== 'low_confidence') } : row
}
