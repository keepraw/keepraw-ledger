import { REVIEW_FLAGS as STORED_REVIEW_FLAGS } from './types'
import { statementNeedsReview } from './statementState'
import type {
  ImportRecord,
  ReconciliationStatus,
  ReviewFlag,
  ReviewStatus,
  Statement,
  StatementStatus,
  Transaction,
} from './types'

// Re-export the flag list for consumers without importing types twice.
export const REVIEW_FLAGS = STORED_REVIEW_FLAGS.filter(flag => flag !== 'uncategorized')

/**
 * Data-quality centre (read-only).
 *
 * This module never writes, never mutates its inputs and never touches the
 * transaction / reconciliation logic. It only aggregates the status fields
 * that already exist elsewhere:
 *
 * - Transaction: `origin`, `sourceId`, `reviewStatus`, `flags`, `bank`,
 *   `sourceFileHash`
 * - Statement: `status`, `reconciliation.status`
 * - ImportRecord: `status`, `sourceType`, `parserId`, `duplicateOf`, `fileHash`
 * - Attachment: presence of `fileHash` (passed in as a hash set, so this
 *   module stays storage-agnostic and pure)
 *
 * No new schema, no new status values, no parser/fingerprint changes.
 */

export interface DataQualityInput {
  transactions: readonly Transaction[]
  statements: readonly Statement[]
  imports: readonly ImportRecord[]
  /**
   * Hashes of original evidence files that are actually available
   * (IndexedDB `attachments` table or any equivalent store).
   * Every import whose `fileHash` is absent here counts as `missing`.
   */
  attachmentHashes?: ReadonlySet<string> | readonly string[]
}

export interface OriginStats {
  /** `parser` = bank-parser rows (`origin` absent or `'parser'`). */
  byOrigin: { parser: number; legacy_import: number }
  /** `sourceId` (`legacy-python-export-v1`, …) or `'bank-parser'` fallback. */
  bySourceId: Record<string, number>
  byBank: Record<string, number>
}

export interface EvidenceStats {
  /** Import records considered (every file ever imported). */
  total: number
  archived: number
  missing: number
  /** File names without available evidence (for the "go fix it" link). */
  missingFiles: string[]
}

export interface ReviewStats {
  total: number
  byReviewStatus: Record<ReviewStatus, number>
  flagged: number
  unflagged: number
}

export interface StatementStats {
  total: number
  byStatus: Record<StatementStatus, number>
  byReconciliation: Record<ReconciliationStatus, number>
}

export interface FlagStats {
  /** Transactions carrying at least one flag. */
  flaggedTransactions: number
  byFlag: Record<ReviewFlag, number>
}

export interface DuplicateStats {
  /**
   * File-level duplicates, derived from existing import metadata only.
   * Counts `ImportRecord.status === 'duplicate'` (equivalently
   * `duplicateOf !== null`). Per-row "skipped" counts were never persisted,
   * so no new table is introduced to guess them.
   */
  duplicateFileImports: number
  /** Rows flagged `suspected_duplicate` and still awaiting review. */
  suspectedDuplicateTransactions: number
}

export interface HealthScore {
  /** 0-100, higher is healthier. See `scoreHealth` for the formula. */
  score: number
  level: 'healthy' | 'warning' | 'critical'
}

export interface ActionCounts {
  /** Transactions with flags or `pending` status -> Review page. */
  needsReviewTransactions: number
  /** Statements neither `reconciled` nor `imported` -> Review page. */
  needsReviewStatements: number
  /** Imports without evidence -> Import / Archive pages. */
  missingAttachments: number
}

export interface DataQualityReport {
  totals: { transactions: number; statements: number; imports: number }
  origins: OriginStats
  importsBySourceType: Record<string, number>
  evidence: EvidenceStats
  review: ReviewStats
  statements: StatementStats
  flags: FlagStats
  duplicates: DuplicateStats
  health: HealthScore
  actions: ActionCounts
}

const STATEMENT_STATUS_KEYS: StatementStatus[] = ['reconciled', 'needs_review', 'failed', 'imported']
const RECONCILIATION_KEYS: ReconciliationStatus[] = ['passed', 'mismatch', 'insufficient']

export const BANK_PARSER_SOURCE_ID = 'bank-parser'

function toHashSet(hashes?: DataQualityInput['attachmentHashes']): ReadonlySet<string> {
  if (!hashes) return new Set()
  if (hashes instanceof Set) return hashes
  return new Set(hashes)
}

/**
 * Single-pass aggregation over the ledger. O(n) time, O(k) extra memory where
 * k is the number of distinct banks / source ids / flags (tiny). Never
 * triggers per-row React updates by itself — call once inside `useMemo`.
 */
export function buildDataQualityReport(input: DataQualityInput): DataQualityReport {
  const { transactions, statements, imports } = input
  const available = toHashSet(input.attachmentHashes)

  const byOrigin: OriginStats['byOrigin'] = { parser: 0, legacy_import: 0 }
  const bySourceId: Record<string, number> = {}
  const byBank: Record<string, number> = {}

  const byReviewStatus: Record<ReviewStatus, number> = { ok: 0, pending: 0, confirmed: 0, rejected: 0 }
  const byFlag = Object.fromEntries(REVIEW_FLAGS.map((flag) => [flag, 0])) as Record<ReviewFlag, number>
  let flagged = 0
  let suspectedDuplicates = 0

  for (const tx of transactions) {
    if (tx.origin === 'legacy_import') byOrigin.legacy_import += 1
    else byOrigin.parser += 1

    const sourceId = tx.sourceId ?? BANK_PARSER_SOURCE_ID
    bySourceId[sourceId] = (bySourceId[sourceId] ?? 0) + 1
    byBank[tx.bank] = (byBank[tx.bank] ?? 0) + 1

    if (byReviewStatus[tx.reviewStatus] !== undefined) byReviewStatus[tx.reviewStatus] += 1
    else byReviewStatus.pending += 1

    const activeFlags = tx.flags.filter(flag => flag !== 'uncategorized')
    if (activeFlags.length > 0) {
      flagged += 1
      for (const flag of activeFlags) {
        if (byFlag[flag] !== undefined) byFlag[flag] += 1
      }
      if (tx.flags.includes('suspected_duplicate')) suspectedDuplicates += 1
    }
  }

  const byStatus = Object.fromEntries(
    STATEMENT_STATUS_KEYS.map((s) => [s, 0]) as Array<[StatementStatus, number]>,
  ) as Record<StatementStatus, number>
  const byReconciliation = Object.fromEntries(
    RECONCILIATION_KEYS.map((s) => [s, 0]) as Array<[ReconciliationStatus, number]>,
  ) as Record<ReconciliationStatus, number>
  let needsReviewStatements = 0
  for (const statement of statements) {
    if (byStatus[statement.status] !== undefined) byStatus[statement.status] += 1
    const reconciliationStatus = statement.reconciliation.status
    if (byReconciliation[reconciliationStatus] !== undefined) byReconciliation[reconciliationStatus] += 1
    if (statementNeedsReview(statement)) needsReviewStatements += 1
  }

  const importsBySourceType: Record<string, number> = {}
  let duplicateFileImports = 0
  const missingFiles: string[] = []
  let archived = 0
  for (const record of imports) {
    importsBySourceType[record.sourceType] = (importsBySourceType[record.sourceType] ?? 0) + 1
    if (record.status === 'duplicate' || record.duplicateOf !== null) duplicateFileImports += 1
    if (record.fileHash !== 'unavailable' && available.has(record.fileHash)) archived += 1
    else missingFiles.push(record.fileName)
  }
  const evidence: EvidenceStats = {
    total: imports.length,
    archived,
    missing: imports.length - archived,
    missingFiles,
  }

  const review: ReviewStats = {
    total: transactions.length,
    byReviewStatus,
    flagged,
    unflagged: transactions.length - flagged,
  }

  const statementStats: StatementStats = { total: statements.length, byStatus, byReconciliation }
  const health = scoreHealth({
    transactionCount: transactions.length,
    flagged,
    importCount: imports.length,
    missingAttachments: evidence.missing,
    statementCount: statements.length,
    unreconciledStatements: needsReviewStatements,
  })

  return {
    totals: { transactions: transactions.length, statements: statements.length, imports: imports.length },
    origins: { byOrigin, bySourceId, byBank },
    importsBySourceType,
    evidence,
    review,
    statements: statementStats,
    flags: { flaggedTransactions: flagged, byFlag },
    duplicates: { duplicateFileImports, suspectedDuplicateTransactions: suspectedDuplicates },
    health,
    actions: {
      needsReviewTransactions: flagged,
      needsReviewStatements,
      missingAttachments: evidence.missing,
    },
  }
}

/**
 * Explainable health score, deliberately simple:
 * `100 − 50·flaggedRate − 30·missingEvidenceRate − 20·unreconciledRate`.
 * Empty ledgers score 100 (nothing is wrong yet).
 */
export function scoreHealth(input: {
  transactionCount: number
  flagged: number
  importCount: number
  missingAttachments: number
  statementCount: number
  unreconciledStatements: number
}): HealthScore {
  if (input.transactionCount === 0 && input.importCount === 0 && input.statementCount === 0) {
    return { score: 100, level: 'healthy' }
  }
  const flaggedRate = input.transactionCount > 0 ? input.flagged / input.transactionCount : 0
  const missingRate = input.importCount > 0 ? input.missingAttachments / input.importCount : 0
  const unreconciledRate = input.statementCount > 0 ? input.unreconciledStatements / input.statementCount : 0
  const score = Math.max(0, Math.min(100, Math.round(100 - 50 * flaggedRate - 30 * missingRate - 20 * unreconciledRate)))
  return { score, level: score >= 90 ? 'healthy' : score >= 70 ? 'warning' : 'critical' }
}

/** Convenience for tests and callers that only need one slice. */
export function countByFlag(transactions: readonly Transaction[]): Record<ReviewFlag, number> {
  return buildDataQualityReport({ transactions, statements: [], imports: [] }).flags.byFlag
}
