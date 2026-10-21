import { withoutLegacyMerchant } from './transactionRecord'
import type { ExistingSnapshot, IngestResult } from '../core/ingest'
import type { Table } from 'dexie'
import type { ImportRecord, Statement, Transaction } from '../core/types'
import { type AttachmentRow, db } from './db'
import { assertLedgerRevision, bumpLedgerRevision, LedgerConflictError, readLedgerRevision, type LedgerRevision } from './ledgerRevision'

const DEMO_PURGE_KEY = 'migration:memory-only-demo'
import { validateBackup } from '../backup/validation'
import { createJsonBlob } from '../backup/json'
import { deriveStatementState } from '../core/statementState'
import { getStatementExpectedTotal } from '../core/reconciliation'
import { MAX_ENTRY_BYTES } from '../backup/zipSafety'
export { validateBackup } from '../backup/validation'

/** Caller holds the statements + transactions write transaction. Indexed by statementId. */
async function rebuildStatementStates(statementIds: Iterable<string>): Promise<Statement[]> {
  const updated: Statement[] = []
  for (const id of new Set(statementIds)) {
    const current = await db.statements.get(id)
    if (!current) continue
    const rows = await db.transactions.where('statementId').equals(id).toArray()
    const next = deriveStatementState(current, rows)
    await db.statements.put(next)
    updated.push(next)
  }
  return updated
}

/** Explicit repair for a selected historical statement, never a database-wide migration. */
export async function recomputeStatement(statementId: string): Promise<Statement | undefined> {
  return db.transaction('rw', db.statements, db.transactions, db.settings, async () => {
    const statement = (await rebuildStatementStates([statementId]))[0]
    if (statement) await bumpLedgerRevision()
    return statement
  })
}

function demoImportHashesWithoutRealReferences(
  imports: readonly Pick<ImportRecord, 'fileHash' | 'isDemo'>[],
): string[] {
  const realHashes = new Set(imports.filter((row) => row.isDemo !== true).map((row) => row.fileHash))
  return [...new Set(imports
    .filter((row) => row.isDemo === true && !realHashes.has(row.fileHash))
    .map((row) => row.fileHash))]
}

export interface Snapshot {
  statements: Statement[]
  transactions: Transaction[]
  imports: ImportRecord[]
}

export async function readSnapshot(): Promise<Snapshot> {
  return db.transaction('r', db.statements, db.transactions, db.imports, async () => {
    const [statements, transactions, imports] = await Promise.all([
      db.statements.toArray(), db.transactions.toArray(), db.imports.toArray(),
    ])
    return { statements, transactions, imports }
  })
}

/** One coherent read of financial rows and their optimistic commit token. */
export async function readImportSnapshot(): Promise<{ snapshot: Snapshot; revision: LedgerRevision }> {
  return db.transaction('r', db.statements, db.transactions, db.imports, db.settings, async () => {
    const [snapshot, revision] = await Promise.all([readSnapshot(), readLedgerRevision()])
    return { snapshot, revision }
  })
}

export function toExistingSnapshot(snapshot: Snapshot): ExistingSnapshot {
  return { statements: snapshot.statements, transactions: snapshot.transactions, imports: snapshot.imports }
}

/** Persist a batch of ingest results in a single transaction. */
export async function persistImportResults(results: IngestResult[], expectedRevision?: LedgerRevision): Promise<void> {
  // Interactive planners pass their snapshot token. Prebuilt programmatic batches
  // capture one before opening the transaction, preserving the repository API.
  const expected = expectedRevision ?? await readLedgerRevision()
  await db.transaction('rw', db.statements, db.transactions, db.imports, db.settings, async () => {
    await assertLedgerRevision(expected)
    if (results.some(result => result.record.isDemo || result.statement?.isDemo || result.transactions.some(row => row.isDemo))) {
      await db.settings.delete(DEMO_PURGE_KEY)
    }
    for (const result of results) {
      await db.imports.put(result.record)
      if (!result.statement) continue
      const current = await db.statements.get(result.statement.id)
      const existingBankTotal = current && getStatementExpectedTotal(current).available
      const incomingBankTotal = getStatementExpectedTotal(result.statement).available
      if (current && existingBankTotal && incomingBankTotal) {
        const fields = ['previousBalanceMinor', 'currentBalanceMinor', 'newDebitMinor', 'newCreditMinor', 'chargeMinor', 'interestMinor'] as const
        if (getStatementExpectedTotal(current).currency !== getStatementExpectedTotal(result.statement).currency ||
          fields.some(field => current.summary[field] !== result.statement!.summary[field])) {
          throw new Error('同一账期的银行汇总存在冲突，本次导入已回滚，请核对原始账单。')
        }
      }
      // A partial later source cannot erase an already stored bank basis.
      await db.statements.put(current && existingBankTotal && !incomingBankTotal ? current : result.statement)
      // Existing rows may have been edited since parsing. Never write them back.
      const insertedIds = new Set(result.inserted.map((tx) => tx.id))
      await db.transactions.bulkAdd(result.transactions.filter((tx) => insertedIds.has(tx.id)).map(withoutLegacyMerchant))
    }
    await rebuildStatementStates(results.flatMap(result => result.statement ? [result.statement.id] : []))
    await bumpLedgerRevision()
  })
}

/** Persist a legacy-import plan in a single transaction: all rows or none. */
export async function persistLegacyImport(plan: {
  record: ImportRecord
  statements: Statement[]
  inserted: Transaction[]
}, expectedRevision?: LedgerRevision): Promise<void> {
  const expected = expectedRevision ?? await readLedgerRevision()
  await db.transaction('rw', db.statements, db.transactions, db.imports, db.settings, async () => {
    await assertLedgerRevision(expected)
    if (plan.record.isDemo || plan.statements.some(row => row.isDemo) || plan.inserted.some(row => row.isDemo)) {
      await db.settings.delete(DEMO_PURGE_KEY)
    }
    await db.imports.put(plan.record)
    // Historical XLSX carries no new bank summary. Preserve stored evidence.
    for (const statement of plan.statements) {
      if (!await db.statements.get(statement.id)) await db.statements.add(statement)
    }
    for (let offset = 0; offset < plan.inserted.length; offset += 2000) {
      await db.transactions.bulkAdd(plan.inserted.slice(offset, offset + 2000).map(withoutLegacyMerchant))
    }
    await rebuildStatementStates([...plan.statements.map(row => row.id), ...plan.inserted.map(row => row.statementId)])
    await bumpLedgerRevision()
  })
}

/** Merge against the latest committed row, never against a captured React snapshot. */
export async function patchTransaction(patch: Partial<Transaction> & { id: string }): Promise<Transaction | undefined> {
  return (await patchTransactionWithStatements(patch))?.transaction
}

/** Return the committed derived rows as well, so React can publish one coherent state. */
export async function patchTransactionWithStatements(patch: Partial<Transaction> & { id: string }): Promise<{
  transaction: Transaction
  statements: Statement[]
} | undefined> {
  const ownedPatch = structuredClone(patch)
  return db.transaction('rw', db.statements, db.transactions, db.settings, async () => {
    const current = await db.transactions.get(ownedPatch.id)
    if (!current) return undefined
    const next = withoutLegacyMerchant({ ...current, ...ownedPatch })
    await db.transactions.put(next)
    if (next.isDemo) await db.settings.delete(DEMO_PURGE_KEY)
    const affectsReconciliation = (['statementId', 'transactionCurrency', 'transactionAmountMinor',
      'settlementCurrency', 'settlementAmountMinor', 'type', 'direction', 'reviewStatus', 'isDemo'] as const)
      .some(key => current[key] !== next[key])
    const statements = affectsReconciliation ? await rebuildStatementStates([current.statementId, next.statementId]) : []
    await bumpLedgerRevision()
    return { transaction: next, statements }
  })
}

export async function updateTransaction(transaction: Transaction): Promise<void> {
  await patchTransaction(transaction)
}

export async function updateTransactions(transactions: Transaction[]): Promise<void> {
  await db.transaction('rw', db.statements, db.transactions, db.settings, async () => {
    const prior = await db.transactions.bulkGet(transactions.map(row => row.id))
    await db.transactions.bulkPut(transactions.map(withoutLegacyMerchant))
    if (transactions.some(row => row.isDemo)) await db.settings.delete(DEMO_PURGE_KEY)
    await rebuildStatementStates([...prior.flatMap(row => row ? [row.statementId] : []), ...transactions.map(row => row.statementId)])
    await bumpLedgerRevision()
  })
}

export async function getReviewNotes(): Promise<Record<string, string>> {
  const rows = await db.reviewNotes.toArray()
  return Object.fromEntries(rows.map((row) => [row.transactionId, row.note]))
}

export async function setReviewNote(transactionId: string, note: string): Promise<void> {
  await db.transaction('rw', db.reviewNotes, db.settings, async () => {
    if (!note.trim()) await db.reviewNotes.delete(transactionId)
    else await db.reviewNotes.put({ transactionId, note: note.trim(), updatedAt: new Date().toISOString() })
    await bumpLedgerRevision()
  })
}

export interface ReviewNotePayload {
  transactionId: string
  note: string
  updatedAt: string
}

export interface BackupPayloadV1 {
  format: 'credit-bill-manager-backup' | 'credit-card-data-backup'
  version: 1
  exportedAt: string
  statements: Statement[]
  transactions: Transaction[]
  imports: ImportRecord[]
  settings: unknown
}

export interface BackupPayloadV2 {
  format: 'credit-bill-manager-backup' | 'credit-card-data-backup'
  version: 2
  exportedAt: string
  statements: Statement[]
  transactions: Transaction[]
  imports: ImportRecord[]
  reviewNotes: ReviewNotePayload[]
  settings: unknown
}

export type BackupPayload = BackupPayloadV1 | BackupPayloadV2

/** Lightweight data backup: transactions + statements + import metadata + settings. No raw files. */
export async function exportBackup(): Promise<BackupPayload> {
  return exportDataBackup()
}

/** Preferred name going forward. Writes `credit-card-data.json`. V2 includes independent review notes. */
export async function exportDataBackup(): Promise<BackupPayload> {
  return db.transaction('r', db.statements, db.transactions, db.imports, db.settings, db.reviewNotes, async () => {
    const [statements, transactions, imports, settings, notes] = await Promise.all([
      db.statements.toArray(), db.transactions.toArray(), db.imports.toArray(), db.settings.get('app'),
      db.reviewNotes.toArray(),
    ])
    // Export every stored note (including orphans) so no recoverable user
    // text is silently omitted. Orphans are never assumed to be demo data:
    // demo filtering happens only via explicit isDemo transaction/import
    // flags, never via note presence. Sorted for stable output.
    const reviewNotes: ReviewNotePayload[] = [...notes]
      .sort((a, b) => a.transactionId.localeCompare(b.transactionId))
      .map((row) => ({ transactionId: row.transactionId, note: row.note, updatedAt: row.updatedAt }))
    const payload: BackupPayloadV2 = { format: 'credit-card-data-backup', version: 2,
      exportedAt: new Date().toISOString(), statements, transactions: transactions.map(withoutLegacyMerchant), imports, reviewNotes, settings: settings?.value ?? null }
    if (!validateBackup(payload)) throw new Error('账本包含无效记录，拒绝生成不可恢复的备份')
    return payload
  })
}

export async function buildDataBackupBlob(): Promise<Blob> {
  return createJsonBlob(await exportDataBackup())
}

async function backupRows<T>(table: Table<T, string>, ids: string[]): Promise<Array<T | undefined>> {
  if (await table.count() === 0) return new Array<T | undefined>(ids.length).fill(undefined)
  const rows: Array<T | undefined> = []
  for (let offset = 0; offset < ids.length; offset += 2000) rows.push(...await table.bulkGet(ids.slice(offset, offset + 2000)))
  return rows
}

/** Matching primary keys keep current metadata; financial or note conflicts abort. */
export async function importBackup(payload: BackupPayload): Promise<void> {
  if (!validateBackup(payload)) throw new Error('备份包含无效记录，拒绝恢复')
  // Old V1/V2 JSON and ZIP payloads may carry the retired field; never write it back.
  payload = { ...payload, transactions: payload.transactions.map(withoutLegacyMerchant) }
  // V1 restores never touch reviewNotes: existing local notes stay unchanged.
  // V2 restores merge notes in the same atomic transaction as financial rows.
  const incomingNotes: ReviewNotePayload[] = payload.version === 2 ? payload.reviewNotes : []
  if (payload.version === 1) {
    await db.transaction('rw', db.statements, db.transactions, db.imports, db.settings, async () => {
      await applyBackupPayload(payload, [])
    })
    return
  }
  await db.transaction('rw', db.statements, db.transactions, db.imports, db.settings, db.reviewNotes, async () => {
    const storedNotes = await backupRows(db.reviewNotes, incomingNotes.map((row) => row.transactionId))
    for (const [index, row] of incomingNotes.entries()) {
      const current = storedNotes[index]
      // Same transactionId with conflicting content rejects the entire
      // restore. Never last-write-wins, never compare updatedAt to overwrite.
      // Identical content preserves the existing row (idempotent repeat).
      // Absence locally inserts the original content and timestamp.
      // Absence in the payload never deletes an existing local note.
      if (current && current.note !== row.note) throw new Error(`复核备注冲突，拒绝覆盖：${row.transactionId}`)
    }
    await applyBackupPayload(payload, storedNotes)
  })
}

async function applyBackupPayload(payload: BackupPayload, storedNotes: Array<{ transactionId: string; note: string; updatedAt: string } | undefined>): Promise<void> {
    const [storedStatements, storedTransactions, storedImports] = await Promise.all([
      backupRows(db.statements, payload.statements.map((row) => row.id)),
      backupRows(db.transactions, payload.transactions.map((row) => row.id)),
      backupRows(db.imports, payload.imports.map((row) => row.id)),
    ])
    for (const [index, row] of payload.transactions.entries()) {
      const current = storedTransactions[index]
      if (current && ['statementId', 'bank', 'cardLast4', 'transactionDate', 'postingDate', 'description',
        'transactionCurrency', 'transactionAmountMinor', 'settlementCurrency', 'settlementAmountMinor', 'type', 'direction', 'fingerprint', 'occurrence']
        .some((key) => current[key as keyof Transaction] !== row[key as keyof Transaction])) {
        throw new Error(`交易标识冲突，拒绝覆盖：${row.id}`)
      }
    }
    for (const [index, row] of payload.statements.entries()) {
      const current = storedStatements[index]
      if (current && ['statementKey', 'bank', 'cardLast4', 'cycleStart', 'cycleEnd']
        .some((key) => current[key as keyof Statement] !== row[key as keyof Statement])) throw new Error('账单标识冲突，拒绝恢复')
    }
    for (const [index, row] of payload.imports.entries()) {
      if (storedImports[index] && storedImports[index]!.fileHash !== row.fileHash) throw new Error('导入记录标识冲突，拒绝恢复')
    }
    await db.statements.bulkAdd(payload.statements.filter((_row, index) => !storedStatements[index]))
    const addedTransactions = payload.transactions.filter((_row, index) => !storedTransactions[index])
    for (let offset = 0; offset < addedTransactions.length; offset += 2000) {
      await db.transactions.bulkAdd(addedTransactions.slice(offset, offset + 2000))
    }
    await db.imports.bulkAdd(payload.imports.filter((_row, index) => !storedImports[index]))
    const affected = [...new Set(addedTransactions.map((row) => row.statementId))]
    const existingStatementIds = new Set(storedStatements.flatMap((row) => row ? [row.id] : []))
    const grouped = new Map<string, Transaction[]>()
    for (const row of await db.transactions.where('statementId').anyOf(affected).toArray()) {
      const rows = grouped.get(row.statementId) ?? []
      rows.push(row)
      grouped.set(row.statementId, rows)
    }
    for (const current of await db.statements.bulkGet(affected)) {
      if (!current) continue
      const transactions = grouped.get(current.id) ?? []
      // A complete restored statement already carries its original decisions
      // and reconciliation. Only existing/partial statements need rebuilding.
      if (!existingStatementIds.has(current.id) && current.transactionCount === transactions.length) continue
      await db.statements.put(deriveStatementState(current, transactions))
    }
    // V2 notes: insert absent notes preserving original content/timestamps.
    // Identical content is already a no-op; conflicting content already threw
    // above before any write. Absence in the payload never deletes.
    if (payload.version === 2) {
      const incoming = payload.reviewNotes
      const toAdd = incoming.filter((_row, index) => !storedNotes[index])
      // Orphaned notes (no matching transaction in this payload or locally)
      // are still inserted: they remain recoverable user text, never dropped.
      for (let offset = 0; offset < toAdd.length; offset += 2000) {
        await db.reviewNotes.bulkAdd(toAdd.slice(offset, offset + 2000))
      }
    }
    if (payload.transactions.some(row => row.isDemo) || payload.statements.some(row => row.isDemo) || payload.imports.some(row => row.isDemo)) await db.settings.delete(DEMO_PURGE_KEY)
    if (payload.settings) await db.settings.put({ key: 'app', value: payload.settings })
    await bumpLedgerRevision()
}

/** Remove only the fictional demo rows so they can be regenerated cleanly. */
export async function clearDemoData(): Promise<void> {
  await db.transaction('rw', [db.statements, db.transactions, db.imports, db.reviewNotes, db.attachments, db.settings], async () => {
    const demoTransactions = await db.transactions.filter((row) => row.isDemo === true).primaryKeys()
    const imports = await db.imports.toArray()
    const demoImportIds = imports.filter((row) => row.isDemo === true).map((row) => row.id)
    const demoHashes = demoImportHashesWithoutRealReferences(imports)
    await db.statements.filter((row) => row.isDemo === true).delete()
    await db.transactions.bulkDelete(demoTransactions)
    await db.imports.bulkDelete(demoImportIds)
    await db.reviewNotes.bulkDelete(demoTransactions)
    await db.attachments.bulkDelete(demoHashes)
    await bumpLedgerRevision()
  })
}

/**
 * Migration cleanup for databases written by older versions that persisted
 * demo rows into the production tables. Removes explicit demo rows and only
 * linked notes/evidence whose demo provenance is still present.
 */
export async function purgeDemoRows(): Promise<void> {
  await db.transaction('rw', [
    db.statements, db.transactions, db.imports, db.reviewNotes, db.attachments, db.settings,
  ], async () => {
    const demoTransactionIds = await db.transactions.filter((row) => row.isDemo === true).primaryKeys()
    const imports = await db.imports.toArray()
    const demoImportIds = imports.filter((row) => row.isDemo === true).map((row) => row.id)
    const demoAttachmentHashes = demoImportHashesWithoutRealReferences(imports)

    await db.statements.filter((row) => row.isDemo === true).delete()
    await db.transactions.bulkDelete(demoTransactionIds)
    await db.imports.bulkDelete(demoImportIds)
    await db.reviewNotes.bulkDelete(demoTransactionIds)
    await db.attachments.bulkDelete(demoAttachmentHashes)

    // Keep the legacy once-only protocol. A failed earlier operation aborts
    // this transaction before the marker can be committed.
    await db.settings.put({ key: DEMO_PURGE_KEY, value: true })
    if (demoTransactionIds.length || demoImportIds.length) await bumpLedgerRevision()
  })
}

/** Only scan old ledgers once. Importing persisted demo rows invalidates the marker atomically. */
export async function ensureDemoRowsPurged(): Promise<void> {
  if ((await db.settings.get(DEMO_PURGE_KEY))?.value !== true) await purgeDemoRows()
}

export async function clearAllData(options: { includeDemo: boolean }): Promise<void> {
  if (options.includeDemo) {
    await db.transaction('rw', [db.statements, db.transactions, db.imports, db.reviewNotes, db.attachments, db.settings], async () => {
      await db.statements.clear()
      await db.transactions.clear()
      await db.imports.clear()
      await db.reviewNotes.clear()
      await db.attachments.clear()
      await bumpLedgerRevision(true)
    })
    return
  }
  await db.transaction('rw', [db.statements, db.transactions, db.imports, db.reviewNotes, db.attachments, db.settings], async () => {
    // Orphaned sensitive records have no reliable demo provenance. Clearing
    // real data removes them, retaining only evidence and notes demonstrably
    // referenced by surviving fictional rows (including shared file hashes).
    const demoIds = new Set(await db.transactions.filter((row) => row.isDemo === true).primaryKeys())
    const demoHashes = new Set((await db.imports.filter((row) => row.isDemo === true).toArray()).map((row) => row.fileHash))
    await db.statements.filter((row) => row.isDemo !== true).delete()
    await db.transactions.filter((row) => row.isDemo !== true).delete()
    await db.imports.filter((row) => row.isDemo !== true).delete()
    await db.reviewNotes.bulkDelete(await db.reviewNotes.filter((row) => !demoIds.has(row.transactionId)).primaryKeys())
    await db.attachments.bulkDelete(await db.attachments.filter((row) => !demoHashes.has(row.fileHash)).primaryKeys())
    await bumpLedgerRevision(true)
  })
}

export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  if (!navigator.storage?.estimate) return null
  const estimate = await navigator.storage.estimate()
  return { usage: estimate.usage ?? 0, quota: estimate.quota ?? 0 }
}

// ---------------------------------------------------------------------------
// Original-file lifecycle: indexeddb | external (future) | missing
// ---------------------------------------------------------------------------

export type AttachmentStorage = 'indexeddb' | 'external' | 'missing'

export interface ManifestFileEntry {
  importId: string
  filename: string
  sha256: string
  parserId: string
  importedAt: string
  storage: AttachmentStorage
}

export interface ArchiveManifest {
  version: 1
  createdAt: string
  files: ManifestFileEntry[]
}

export interface ArchiveStatus {
  transactionCount: number
  importCount: number
  archivedCount: number
  missingCount: number
}

export function mimeTypeForFile(fileName: string): string {
  const lower = fileName.toLowerCase()
  if (lower.endsWith('.pdf')) return 'application/pdf'
  if (lower.endsWith('.eml')) return 'message/rfc822'
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'text/html'
  if (lower.endsWith('.txt')) return 'text/plain'
  return 'application/octet-stream'
}

/** Store the raw evidence bytes. Idempotent: same hash is never stored twice. */
export async function saveOriginalFile(input: {
  fileHash: string
  fileName: string
  mimeType?: string
  data: ArrayBuffer
  importId: string
  parserId: string
  generation?: number
}): Promise<void> {
  if (input.data.byteLength > MAX_ENTRY_BYTES) throw new Error('原始文件超过 64 MiB 备份上限，未保存附件。')
  await db.transaction('rw', db.attachments, db.imports, db.settings, async () => {
    if (input.generation !== undefined && ((await readLedgerRevision()).generation !== input.generation || !await db.imports.get(input.importId))) {
      throw new LedgerConflictError(true)
    }
    const existing = await db.attachments.get(input.fileHash)
    if (existing) return
    const row: AttachmentRow = {
      fileHash: input.fileHash, fileName: input.fileName,
      mimeType: input.mimeType ?? mimeTypeForFile(input.fileName), size: input.data.byteLength,
      data: input.data.slice(0), importId: input.importId, parserId: input.parserId, importedAt: new Date().toISOString(),
    }
    await db.attachments.put(row)
  })
}

/** Evidence warnings may annotate an existing import; they never recreate a cleared row. */
export async function markImportEvidenceMissing(record: ImportRecord, generation: number): Promise<void> {
  await db.transaction('rw', db.imports, db.settings, db.attachments, async () => {
    if ((await readLedgerRevision()).generation !== generation) return
    if (await db.attachments.get(record.fileHash)) return
    const current = await db.imports.get(record.id)
    const warning = '原始文件未保留，可稍后重新导入。'
    if (current && !current.message.includes(warning)) {
      await db.imports.put({ ...current, message: `${current.message}，${warning}` })
    }
  })
}

export async function getAttachment(fileHash: string): Promise<AttachmentRow | undefined> {
  return db.attachments.get(fileHash)
}

const EXTERNAL_FILE_PREFIX = 'archive:external:'

export async function isArchiveFileExternal(fileHash: string): Promise<boolean> {
  return (await db.settings.get(`${EXTERNAL_FILE_PREFIX}${fileHash}`))?.value === true
}

/** Local export choices are separate from app settings and financial JSON. No bytes are deleted. */
export async function setArchiveFileExternal(fileHash: string, external: boolean, expected: LedgerRevision): Promise<void> {
  await db.transaction('rw', db.settings, db.attachments, async () => {
    await assertLedgerRevision(expected)
    if (!await db.attachments.get(fileHash)) throw new Error('原始文件已不存在，请刷新后重试。')
    await db.settings.put({ key: `${EXTERNAL_FILE_PREFIX}${fileHash}`, value: external })
    await bumpLedgerRevision()
  })
}

export async function listArchiveFiles(): Promise<{ revision: LedgerRevision; files: Array<{
  fileHash: string; fileName: string; size: number; external: boolean
}> }> {
  return db.transaction('r', db.imports, db.attachments, db.settings, async () => {
    const revision = await readLedgerRevision()
    const files = []
    const hashes = new Set<string>()
    for (const record of await db.imports.toArray()) {
      if (record.isDemo || hashes.has(record.fileHash)) continue
      hashes.add(record.fileHash)
      const row = await db.attachments.get(record.fileHash)
      if (row) files.push({ fileHash: row.fileHash, fileName: row.fileName, size: row.data.byteLength,
        external: await isArchiveFileExternal(row.fileHash) })
    }
    return { revision, files }
  })
}

export async function hasAttachment(fileHash: string): Promise<boolean> {
  return (await db.attachments.get(fileHash)) !== undefined
}

/** Hashes of every stored evidence file. Read-only helper for the data-quality page. */
export async function listAttachmentHashes(): Promise<Set<string>> {
  const rows = await db.attachments.toCollection().primaryKeys()
  return new Set(rows.map(String))
}

/** Build the manifest without inventing files: no row in `attachments` means `missing`. */
export async function buildManifest(): Promise<ArchiveManifest> {
  const imports = await db.imports.toArray()
  const files: ManifestFileEntry[] = []
  for (const record of imports) {
    const attachment = await db.attachments.get(record.fileHash)
    files.push({
      importId: record.id,
      filename: record.fileName,
      sha256: record.fileHash,
      parserId: record.parserId,
      importedAt: record.importedAt,
      storage: attachment ? 'indexeddb' : 'missing',
    })
  }
  files.sort((a, b) => a.importedAt.localeCompare(b.importedAt))
  return { version: 1, createdAt: new Date().toISOString(), files }
}

export function validateManifest(value: unknown): value is ArchiveManifest {
  if (!value || typeof value !== 'object') return false
  const manifest = value as Partial<ArchiveManifest>
  if (manifest.version !== 1 || typeof manifest.createdAt !== 'string' || !Array.isArray(manifest.files)) return false
  return manifest.files.every(
    (entry) =>
      entry &&
      typeof entry === 'object' &&
      typeof entry.importId === 'string' &&
      typeof entry.filename === 'string' &&
      typeof entry.sha256 === 'string' &&
      typeof entry.parserId === 'string' &&
      typeof entry.importedAt === 'string' &&
      (entry.storage === 'indexeddb' || entry.storage === 'external' || entry.storage === 'missing'),
  ) && new Set(manifest.files.map((entry) => entry.importId)).size === manifest.files.length
}

/** Count how many imports still have evidence available vs. data-only rows. Real rows only. */
export async function getArchiveStatus(): Promise<ArchiveStatus> {
  const [transactions, imports] = await Promise.all([db.transactions.toArray(), db.imports.toArray()])
  const realTransactions = transactions.filter((row) => !row.isDemo)
  const realImports = imports.filter((row) => !row.isDemo)
  let archivedCount = 0
  for (const record of realImports) {
    if (await db.attachments.get(record.fileHash)) archivedCount += 1
  }
  return {
    transactionCount: realTransactions.length,
    importCount: realImports.length,
    archivedCount,
    missingCount: realImports.length - archivedCount,
  }
}
