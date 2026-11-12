/** Local acceptance only: private inputs stay on disk; all writes use in-memory IndexedDB. */
import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { createServer } from 'vite'

const args = process.argv.slice(2)
const option = name => {
  const index = args.indexOf(name)
  return index < 0 ? undefined : args[index + 1]
}
const xlsxPath = option('--xlsx')
const backupPath = option('--backup')
if (!xlsxPath || !backupPath) {
  throw new Error('usage: npm run native:recovery-audit -- --xlsx <transactions.xlsx> --backup <partial-import-backup.json> [--expect-total 18286 --expect-stored 17798 --expect-new 488]')
}
const expected = {
  total: Number(option('--expect-total') ?? 18_286),
  alreadyStored: Number(option('--expect-stored') ?? 17_798),
  newlyInserted: Number(option('--expect-new') ?? 488),
}
assert.ok(Object.values(expected).every(value => Number.isSafeInteger(value) && value >= 0), 'Expected counts must be nonnegative safe integers')
assert.equal(expected.total, expected.alreadyStored + expected.newlyInserted, 'Expected counts must add up')

const root = fileURLToPath(new URL('../', import.meta.url))
const server = await createServer({
  root, configFile: false, logLevel: 'silent', optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true, watch: null }, appType: 'custom',
})
const report = { expected, validation: 'failed' }
let db
try {
  const repository = await server.ssrLoadModule('/src/db/repository.ts')
  db = (await server.ssrLoadModule('/src/db/db.ts')).db
  const { previewLegacyWorkbook, planLegacyImport } = await server.ssrLoadModule('/src/importers/legacyImport.ts')
  const { readSheetData } = await server.ssrLoadModule('/src/importers/workbook.ts')
  const backup = JSON.parse(await readFile(resolve(backupPath), 'utf8'))
  assert.ok(repository.validateBackup(backup), 'Invalid JSON backup')
  await repository.importBackup(backup)
  const before = await repository.readSnapshot()
  const notes = await db.reviewNotes.toArray()
  const bytes = await readFile(resolve(xlsxPath))
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  const meta = { fileName: basename(xlsxPath), fileSize: bytes.length,
    fileHash: createHash('sha256').update(bytes).digest('hex') }
  const sheet = await readSheetData(buffer, '交易明细')
  assert.equal(sheet.rows[0]?.length, 20, 'Acceptance requires the legacy native 20-column workbook')
  const preview = await previewLegacyWorkbook(buffer, meta, before)
  report.firstImport = { total: preview.stats.totalRows, valid: preview.stats.validRows,
    excluded: preview.stats.anomalyRows, alreadyStored: preview.stats.alreadyStored,
    duplicateFile: preview.stats.duplicateFile,
    blockingConflicts: preview.identityWarnings.filter(issue => issue.blocking).length }
  assert.equal(preview.stats.formatId, 'legacy-keepraw-ledger-export-v1', 'Wrong adapter')
  assert.equal(preview.stats.totalRows, expected.total, 'Unexpected total rows')
  assert.equal(preview.stats.validRows, expected.total, 'Some rows are not valid')
  assert.equal(preview.stats.anomalyRows, 0, 'Some rows are excluded')
  assert.equal(preview.stats.alreadyStored, expected.alreadyStored, 'Wrong partial-import baseline')
  assert.equal(preview.stats.duplicateFile, true, 'The original file hash must exist in the backup')
  assert.equal(report.firstImport.blockingConflicts, 0, 'Existing ID conflicts block recovery')
  const plan = planLegacyImport(preview, before)
  report.firstImport.newlyInserted = plan.inserted.length
  report.firstImport.status = plan.record.status
  assert.equal(plan.inserted.length, expected.newlyInserted, 'Wrong recovery count')
  assert.equal(plan.skipped, expected.alreadyStored, 'Wrong skipped count')
  const { revision } = await repository.readImportSnapshot()
  await repository.persistLegacyImport(plan, revision)
  const recovered = await repository.readSnapshot()
  const byId = new Map(recovered.transactions.map(tx => [tx.id, tx]))
  report.firstImport.remainingMissing = preview.rows.filter(row => !byId.has(row.id)).length
  report.firstImport.storedWorkbookIds = preview.rows.filter(row => byId.has(row.id)).length
  report.firstImport.existingRecordsUnchanged = before.transactions.every(tx => isDeepStrictEqual(byId.get(tx.id), tx))
  report.firstImport.notesUnchanged = isDeepStrictEqual(await db.reviewNotes.toArray(), notes)
  assert.equal(report.firstImport.remainingMissing, 0, 'Some workbook IDs are still missing')
  assert.ok(report.firstImport.existingRecordsUnchanged, 'An existing transaction changed')
  assert.ok(report.firstImport.notesUnchanged, 'Existing review notes changed')

  const repeat = await previewLegacyWorkbook(buffer, meta, recovered)
  const second = planLegacyImport(repeat, recovered)
  await repository.persistLegacyImport(second)
  const after = await repository.readSnapshot()
  const workbookIds = new Set(preview.rows.map(row => row.id))
  report.secondImport = { newlyInserted: second.inserted.length, status: second.record.status,
    totalStoredNativeTransactions: after.transactions.filter(tx => workbookIds.has(tx.id) && !tx.isDemo).length }
  assert.equal(second.inserted.length, 0, 'Repeat import inserts rows')
  assert.equal(second.record.status, 'duplicate', 'Repeat import is not reported as duplicate')
  assert.equal(report.secondImport.totalStoredNativeTransactions, expected.total, 'Wrong final native count')
  assert.ok(isDeepStrictEqual(after.transactions, recovered.transactions), 'Repeat import changed transactions')
  assert.ok(isDeepStrictEqual(after.statements, recovered.statements), 'Repeat import changed statements')
  assert.ok(isDeepStrictEqual(await db.reviewNotes.toArray(), notes), 'Repeat import changed notes')
  report.validation = 'passed'
} catch (error) {
  // Do not log exceptions that could contain source descriptions or other private fields.
  report.failure = error instanceof assert.AssertionError ? error.message : 'Local validation could not run; check dependencies and input formats'
  process.exitCode = 1
} finally {
  process.stdout.write(JSON.stringify(report, null, 2) + '\n')
  if (db) await db.delete()
  await server.close()
}
