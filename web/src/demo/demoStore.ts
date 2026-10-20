import { buildDemoDataset } from './demoData'
import type { Snapshot } from '../db/repository'
import type { Transaction } from '../core/types'
import { deriveStatementState } from '../core/statementState'

/** A fresh, independently editable dataset for one mounted application. */
export function createDemoSnapshot(): Snapshot {
  const results = buildDemoDataset()
  return {
    statements: results.map(result => result.statement!),
    transactions: results.flatMap(result => result.transactions),
    imports: results.map(result => result.record),
  }
}

/** Pure in-memory edit. Never look up a missing target in the real database. */
export function patchDemoSnapshot(current: Snapshot, patch: Partial<Transaction> & { id: string }): Snapshot {
  const transaction = current.transactions.find(row => row.id === patch.id && row.isDemo)
  if (!transaction) throw new Error('演示模式只能修改演示交易。')
  const next = { ...transaction, ...patch }
  if (!next.isDemo || !current.statements.some(row => row.id === next.statementId && row.isDemo)) {
    throw new Error('演示交易必须保留在演示账单中。')
  }
  const transactions = current.transactions.map(row => row.id === next.id ? next : row)
  const affected = new Set([transaction.statementId, next.statementId])
  return { ...current, transactions, statements: current.statements.map(row => affected.has(row.id)
    ? deriveStatementState(row, transactions.filter(tx => tx.statementId === row.id)) : row) }
}

/**
 * In-memory demo dataset.
 *
 * Demo rows are fictional showcase data (cards `0000` / `9999`). They must
 * never be written to the production Dexie tables (`transactions`,
 * `statements`, `imports`, `attachments`): the provider serves its own snapshot
 * while Demo Mode is on, and the real database stays untouched.
 * This cached initial dataset is used for counts/fixtures only. AppProvider
 * owns a fresh snapshot and publishes immutable edits; it never mutates this.
 */
let cached: Snapshot | null = null

export function getDemoSnapshot(): Snapshot {
  if (!cached) {
    cached = createDemoSnapshot()
  }
  return cached
}

/** Drop the cached snapshot (tests only). Production code never needs this. */
export function clearDemoCache(): void {
  cached = null
}
