import { reconcileStatement } from './reconcile'
import type { Statement, Transaction } from './types'

/** Rebuild only derived fields; bank evidence and user decisions stay intact. */
export function deriveStatementState(statement: Statement, transactions: Transaction[]): Statement {
  const reconciliation = reconcileStatement({ summary: statement.summary, transactions })
  const status: Statement['status'] = statement.status === 'failed' ? 'failed'
    : statement.status === 'imported' && reconciliation.status === 'insufficient' ? 'imported'
      : reconciliation.status === 'passed' ? 'reconciled' : 'needs_review'
  // Count stored rows, including rejected rows, for source/backup completeness.
  // reconcileStatement independently excludes rejected rows from monetary checks.
  return { ...statement, transactionCount: transactions.length, reconciliation, status }
}
