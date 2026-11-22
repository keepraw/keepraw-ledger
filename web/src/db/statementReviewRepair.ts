import type { Transaction as UpgradeTransaction } from 'dexie'
import { normalizeHistoricalStatements } from '../core/statementState'
import type { ImportRecord, Statement, Transaction } from '../core/types'

export async function repairStatementReview(transaction: UpgradeTransaction): Promise<void> {
  const imports = await transaction.table<ImportRecord>('imports').toArray()
  const statements = await transaction.table<Statement>('statements').toArray()
  const rows = await transaction.table<Transaction>('transactions').toArray()
  const normalized = normalizeHistoricalStatements(statements, rows, imports)
  await transaction.table<Statement>('statements').bulkPut(normalized.filter((row, index) => row !== statements[index]))
}
