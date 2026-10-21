import { BANKS, CATEGORIES, REVIEW_FLAGS, TRANSACTION_TYPES } from '../core/types'
import { parseDateInput } from '../core/dates'
import type { BackupPayload } from '../db/repository'

export const MAX_BACKUP_RECORDS = 1_000_000
/** Free-text review notes are independent rows keyed by transactionId. */
export const MAX_REVIEW_NOTES = 1_000_000
/**
 * Per-note character bound. 100,000 characters keep a single note's transient
 * JSON encoding well under 1 MiB (worst case fully `\uXXXX`-escaped), while
 * accommodating any realistic review note including pasted content. Aggregate
 * memory stays bounded by the 128 MiB JSON budget, the total-record budget and
 * the JSON complexity budgets; over-long notes are rejected loudly at
 * export/restore time, never truncated or silently omitted.
 */
export const MAX_NOTE_CHARS = 100_000
type Row = Record<string, unknown>
const object = (value: unknown): value is Row => !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): value is string => typeof value === 'string'
// Reject control characters without allocating a character array for every ID.
// eslint-disable-next-line no-control-regex
const INVALID_IDENTIFIER = /[\s\x00-\x1f\x7f]/
const identifier = (value: unknown): value is string => text(value) && value.length > 0 && value.length <= 256 &&
  !INVALID_IDENTIFIER.test(value)
const integer = (value: unknown): value is number => Number.isSafeInteger(value)
const nonnegative = (value: unknown): value is number => integer(value) && value >= 0
const minor = (value: unknown) => value === null || integer(value)
const date = (value: unknown) => value === null || (text(value) && /^\d{4}-\d{2}-\d{2}$/.test(value) && parseDateInput(value) === value)
const timestamp = (value: unknown) => text(value) && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value))
const oneOf = (value: unknown, options: readonly string[]) => text(value) && options.includes(value)
const bank = (value: unknown) => text(value) && Object.hasOwn(BANKS, value)
const currency = (value: unknown) => text(value) && /^[A-Z]{3,8}$/.test(value)
const strings = (row: Row, keys: string[]) => keys.every((key) => text(row[key]))

function summary(value: unknown): boolean {
  if (!object(value)) return false
  return ['previousBalanceMinor', 'newDebitMinor', 'newCreditMinor', 'chargeMinor', 'interestMinor',
    'currentBalanceMinor', 'minimumPaymentMinor', 'creditLimitMinor'].every((key) => minor(value[key])) &&
    date(value.dueDate) && Array.isArray(value.components) && value.components.every((entry) =>
      object(entry) && text(entry.label) && minor(entry.minor) && currency(entry.currency))
}

function reconciliation(value: unknown): boolean {
  return object(value) && oneOf(value.status, ['passed', 'mismatch', 'insufficient']) && minor(value.computedBalanceMinor) &&
    Array.isArray(value.checks) && value.checks.every((check) => object(check) && identifier(check.id) &&
      strings(check, ['label', 'detail']) && oneOf(check.status, ['passed', 'mismatch', 'missing', 'skipped']) &&
      ['expectedMinor', 'actualMinor', 'differenceMinor'].every((key) => minor(check[key])))
}

function statement(value: unknown): value is Row {
  return object(value) && identifier(value.id) && identifier(value.statementKey) && bank(value.bank) && text(value.cardLast4) &&
    ['cycleStart', 'cycleEnd', 'dueDate'].every((key) => date(value[key])) && summary(value.summary) && reconciliation(value.reconciliation) &&
    oneOf(value.status, ['reconciled', 'needs_review', 'failed', 'imported']) && nonnegative(value.transactionCount) &&
    strings(value, ['parserId', 'parserVersion', 'sourceFileName', 'sourceFileHash']) && timestamp(value.importedAt) && typeof value.isDemo === 'boolean'
}

function transaction(value: unknown): value is Row {
  return object(value) && identifier(value.id) && identifier(value.statementId) && identifier(value.fingerprint) && bank(value.bank) &&
    strings(value, ['cardLast4', 'description', 'rawDescription', 'sourceFileName', 'sourceFileHash', 'rawText']) &&
    (!Object.hasOwn(value, 'merchant') || text(value.merchant)) &&
    date(value.transactionDate) && date(value.postingDate) && currency(value.transactionCurrency) && currency(value.settlementCurrency) &&
    integer(value.transactionAmountMinor) && integer(value.settlementAmountMinor) && oneOf(value.type, TRANSACTION_TYPES) &&
    oneOf(value.direction, ['debit', 'credit']) && oneOf(value.category, CATEGORIES) &&
    typeof value.confidence === 'number' && Number.isFinite(value.confidence) && value.confidence >= 0 && value.confidence <= 1 &&
    Array.isArray(value.flags) && value.flags.every((flag) => oneOf(flag, REVIEW_FLAGS)) &&
    oneOf(value.reviewStatus, ['ok', 'pending', 'confirmed', 'rejected']) &&
    (value.sourcePage === null || (integer(value.sourcePage) && value.sourcePage > 0)) && nonnegative(value.sourceRow) &&
    integer(value.occurrence) && value.occurrence > 0 && typeof value.isDemo === 'boolean' &&
    (value.isSynthetic === undefined || typeof value.isSynthetic === 'boolean') &&
    (value.origin === undefined || oneOf(value.origin, ['parser', 'legacy_import'])) &&
    (value.sourceId === undefined || text(value.sourceId))
}

function importRecord(value: unknown): value is Row {
  return object(value) && identifier(value.id) && nonnegative(value.fileSize) && identifier(value.fileHash) &&
    strings(value, ['fileName', 'cardLast4', 'message', 'parserId']) && bank(value.bank) && bank(value.detectedBank) &&
    oneOf(value.sourceType, ['pdf', 'eml', 'html', 'text', 'xlsx', 'unknown']) && date(value.cycleStart) && date(value.cycleEnd) &&
    oneOf(value.status, ['parsed', 'needs_review', 'duplicate', 'failed', 'unsupported', 'imported']) &&
    (value.statementId === null || identifier(value.statementId)) && (value.duplicateOf === null || identifier(value.duplicateOf)) &&
    nonnegative(value.transactionCount) && timestamp(value.importedAt) && typeof value.isDemo === 'boolean'
}

function settings(value: unknown): boolean {
  // Older version-1 backups may contain only a subset of the settings.
  return value === null || (object(value) &&
    Object.keys(value).every((key) => ['theme', 'demoMode', 'locale'].includes(key)) &&
    (value.theme === undefined || oneOf(value.theme, ['light', 'dark', 'system'])) &&
    (value.demoMode === undefined || typeof value.demoMode === 'boolean') &&
    (value.locale === undefined || value.locale === 'zh-CN'))
}

function unique(rows: Row[]): boolean {
  return new Set(rows.map((row) => row.id)).size === rows.length
}

function reviewNote(value: unknown): value is Row {
  if (!object(value)) return false
  if (!identifier(value.transactionId)) return false
  if (typeof value.note !== 'string') return false
  // Preserve exact user text (including Unicode, punctuation and line breaks).
  // Reject empty/whitespace-only notes and notes beyond MAX_NOTE_CHARS; stored
  // notes are always trimmed non-empty text, but restore preserves the exported
  // bytes.
  if (value.note.length === 0 || value.note.length > MAX_NOTE_CHARS) return false
  if (value.note.trim().length === 0) return false
  if (!timestamp(value.updatedAt)) return false
  return true
}

function uniqueNotes(rows: Row[]): boolean {
  return new Set(rows.map((row) => row.transactionId)).size === rows.length
}

/**
 * Validate the versioned backup contract without changing financial meaning.
 *
 * - V1 (`version: 1`): legacy payload without `reviewNotes`. Missing notes can
 *   never be reconstructed; V1 restores must leave local notes untouched.
 * - V2 (`version: 2`): same financial records plus independent `reviewNotes`
 *   (`transactionId`, exact `note` content, `updatedAt`). Orphaned notes (no
 *   matching transaction in the payload) are valid and must be preserved;
 *   exports never silently omit stored notes and restores never delete notes
 *   merely because they are absent from the incoming payload.
 */
export function validateBackup(value: unknown): value is BackupPayload {
  if (!object(value) || !oneOf(value.format, ['credit-bill-manager-backup', 'credit-card-data-backup']) ||
    !timestamp(value.exportedAt) || !settings(value.settings)) return false
  if (value.version !== 1 && value.version !== 2) return false
  const { statements, transactions, imports } = value
  if (!Array.isArray(statements) || !Array.isArray(transactions) || !Array.isArray(imports) ||
    !statements.every(statement) || !transactions.every(transaction) || !imports.every(importRecord) ||
    !unique(statements) || !unique(transactions) || !unique(imports)) return false
  if (value.version === 1) {
    // V1 never contained independent notes. A V1 payload carrying notes is
    // malformed: reject rather than silently ignoring recoverable user text.
    if ('reviewNotes' in value) return false
    if (statements.length + transactions.length + imports.length > MAX_BACKUP_RECORDS) return false
  } else {
    const reviewNotes = (value as { reviewNotes?: unknown }).reviewNotes
    if (!Array.isArray(reviewNotes)) return false
    if (!reviewNotes.every(reviewNote)) return false
    if (!uniqueNotes(reviewNotes as Row[])) return false
    if (reviewNotes.length > MAX_REVIEW_NOTES) return false
    if (statements.length + transactions.length + imports.length + reviewNotes.length > MAX_BACKUP_RECORDS) return false
  }
  const statementIds = new Set(statements.map((row) => row.id))
  const importIds = new Set(imports.map((row) => row.id))
  return transactions.every((row) => statementIds.has(row.statementId)) && imports.every((row) =>
    (row.statementId === null || statementIds.has(row.statementId)) &&
    (row.duplicateOf === null || importIds.has(row.duplicateOf)))
}
