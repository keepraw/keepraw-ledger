import { reconcileStatement } from './reconcile'
import type { ImportRecord, Statement, Transaction } from './types'

export function canAcknowledgeStatement(statement: Statement): boolean {
  return statement.status !== 'failed' && statement.reconciliation.status === 'insufficient' &&
    statement.reconciliation.checks.some(check => check.status === 'missing') &&
    !statement.reconciliation.checks.some(check => check.status === 'mismatch')
}

export function statementNeedsReview(statement: Statement): boolean {
  return statement.status !== 'reconciled' && statement.status !== 'imported' &&
    !(statement.reconciliationAcknowledged && canAcknowledgeStatement(statement))
}

export function normalizeHistoricalStatement(statement: Statement, transactions: Transaction[] = [], imports: ImportRecord[] = []): Statement {
  if (!statement.summary || statement.status === 'failed' || statement.reconciliation?.status !== 'insufficient' ||
    statement.reconciliation.checks.some(check => check.status === 'mismatch')) return statement
  const summary = statement.summary
  const noSummary = [summary.previousBalanceMinor, summary.currentBalanceMinor, summary.newDebitMinor,
    summary.newCreditMinor, summary.chargeMinor, summary.interestMinor, summary.minimumPaymentMinor,
    summary.creditLimitMinor, summary.adjustmentMinor].every(value => value == null) && summary.components.length === 0
  const historical = statement.parserId?.startsWith('legacy-') || /\.xlsx?$/i.test(statement.sourceFileName) ||
    imports.some(record => record.fileHash === statement.sourceFileHash && (record.sourceType === 'xlsx' || record.parserId.startsWith('legacy-'))) ||
    (transactions.length > 0 && transactions.every(row => row.origin === 'legacy_import'))
  return noSummary && historical && statement.status !== 'imported' ? { ...statement, status: 'imported' } : statement
}

export function normalizeHistoricalStatements(statements: Statement[], transactions: Transaction[], imports: ImportRecord[]): Statement[] {
  const byStatement = new Map<string, Transaction[]>()
  for (const row of transactions) {
    const group = byStatement.get(row.statementId) ?? []
    group.push(row)
    byStatement.set(row.statementId, group)
  }
  return statements.map(statement => normalizeHistoricalStatement(statement, byStatement.get(statement.id) ?? [], imports))
}

/** Rebuild only derived fields; bank evidence and user decisions stay intact. */
export function deriveStatementState(statement: Statement, transactions: Transaction[]): Statement {
  const reconciliation = reconcileStatement({ summary: statement.summary, transactions })
  const status: Statement['status'] = statement.status === 'failed' ? 'failed'
    : statement.status === 'imported' && reconciliation.status === 'insufficient' ? 'imported'
      : reconciliation.status === 'passed' ? 'reconciled' : 'needs_review'
  // Count stored rows, including rejected rows, for source/backup completeness.
  // reconcileStatement independently excludes rejected rows from monetary checks.
  const next = normalizeHistoricalStatement({ ...statement, transactionCount: transactions.length, reconciliation, status }, transactions)
  if (next.reconciliationAcknowledged && !canAcknowledgeStatement(next)) return { ...next, reconciliationAcknowledged: false }
  return next
}
