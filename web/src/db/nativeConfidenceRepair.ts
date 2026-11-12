import type { Transaction as UpgradeTransaction } from 'dexie'
import type { Transaction } from '../core/types'

/** PR #48 never recovered flags from XLSX: low_confidence was unconditional.
 * Match BOTH provenance fields; real parser flags and other adapters stay intact.
 * Only flags change, including for pending/rejected rows and edited metadata.
 * Must run inside an IndexedDB transaction; do not catch partial write failures.
 */
export async function repairNativeLedgerConfidence(transaction: UpgradeTransaction): Promise<void> {
  await transaction.table<Transaction>('transactions').toCollection().modify(row => {
    if (row.origin !== 'legacy_import' || row.sourceId !== 'legacy-keepraw-ledger-export-v1' ||
      !row.flags.includes('low_confidence')) return false
    row.flags = row.flags.filter(flag => flag !== 'low_confidence')
  })
}
