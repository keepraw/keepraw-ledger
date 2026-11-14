import JSZip from 'jszip'
import { beforeEach, expect, it, vi } from 'vitest'
import { db } from '../src/db/db'
import { importBackup, exportDataBackup, readSnapshot, saveOriginalFile, type BackupPayload } from '../src/db/repository'
import { buildFullBackupZip, DATABASE_JSON, restoreFullBackupZip } from '../src/backup/archive'
import { ingestSynthetic } from './fixtures/identity'
import { nativeTransaction } from './fixtures/nativeLedger'
import { sha256Hex } from '../src/parsers/extract'

beforeEach(async () => { vi.restoreAllMocks(); await db.delete(); await db.open() })

async function legacyBackup() {
  const result = ingestSynthetic(['消费 合成备份'])
  await db.statements.put({ ...result.statement!, status: 'imported', transactionCount: 7 })
  await db.imports.put(result.record)
  const transactions = ['ok', 'pending', 'confirmed', 'rejected'].map((status, i) => ({ ...nativeTransaction(i + 1),
    statementId: result.statement!.id, origin: 'legacy_import' as const, sourceId: 'legacy-keepraw-ledger-export-v1',
    reviewStatus: status as 'ok' | 'pending' | 'confirmed' | 'rejected', confidence: i / 10,
    flags: ['suspected_duplicate', 'low_confidence', 'date_missing'] as const }))
  const controls = [
    { ...nativeTransaction(10), statementId: result.statement!.id, flags: ['low_confidence'] as const },
    { ...nativeTransaction(11), statementId: result.statement!.id, origin: 'legacy_import' as const, sourceId: 'legacy-python-export-v1', flags: ['low_confidence'] as const },
    { ...nativeTransaction(12), statementId: result.statement!.id, sourceId: 'legacy-keepraw-ledger-export-v1', flags: ['low_confidence'] as const },
  ]
  await db.transactions.bulkPut([...transactions, ...controls].map(row => ({ ...row, flags: [...row.flags] })))
  await db.reviewNotes.put({ transactionId: transactions[0]!.id, note: 'Synthetic retained note\n第二行', updatedAt: '2024-01-01T00:00:00Z' })
  return exportDataBackup()
}
function expected(payload: BackupPayload) {
  return payload.transactions.map(row => row.origin === 'legacy_import' && row.sourceId === 'legacy-keepraw-ledger-export-v1'
    ? { ...row, flags: row.flags.filter(flag => flag !== 'low_confidence') } : row)
}

it.each([1, 2] as const)('cleans old JSON V%s immutably and idempotently without changing status, confidence, identity or notes', async version => {
  const v2 = await legacyBackup()
  const payload = JSON.parse(JSON.stringify(v2)) as BackupPayload
  Object.assign(payload, { version })
  if (version === 1) delete (payload as unknown as { reviewNotes?: unknown }).reviewNotes
  const original = structuredClone(payload)
  const notes = await db.reviewNotes.toArray()
  await db.delete(); await db.open()
  if (version === 1) await db.reviewNotes.bulkPut(notes)
  await importBackup(payload); await importBackup(payload)
  expect((await readSnapshot()).transactions).toEqual(expected(original))
  expect(await db.reviewNotes.toArray()).toEqual(notes)
  expect(payload).toEqual(original)
})

it('cleans ZIP through importBackup in the existing outer transaction; attachment failure rolls back all stores', async () => {
  const payload = await legacyBackup()
  const bytes = new TextEncoder().encode('SYNTHETIC_NATIVE_BACKUP_EVIDENCE')
  const fileHash = await sha256Hex(bytes.buffer)
  const record = (await db.imports.toArray())[0]!
  await db.imports.update(record.id, { fileHash })
  await saveOriginalFile({ fileHash, fileName: 'synthetic.txt', data: bytes.buffer, importId: record.id, parserId: record.parserId })
  const zip = await buildFullBackupZip()
  const before = await db.reviewNotes.toArray()
  await db.delete(); await db.open()
  const fail = vi.spyOn(db.attachments, 'put').mockRejectedValueOnce(new Error('synthetic attachment failure'))
  await expect(restoreFullBackupZip(zip.blob)).rejects.toThrow('synthetic attachment failure')
  fail.mockRestore()
  for (const table of db.tables) expect(await table.count()).toBe(0)
  await restoreFullBackupZip(zip.blob); await restoreFullBackupZip(zip.blob)
  expect((await readSnapshot()).transactions).toEqual(expected(payload))
  expect(await db.reviewNotes.toArray()).toEqual(before)
  expect((await db.attachments.get(fileHash))?.data).toEqual(bytes.buffer)
  const original = await JSZip.loadAsync(zip.blob)
  expect(JSON.parse(await original.file(DATABASE_JSON)!.async('string')).transactions).toEqual(payload.transactions)
})

it.each([1, 2] as const)('rolls back JSON V%s rows, notes and settings on a late failure without mutating the payload', async version => {
  const payload = JSON.parse(JSON.stringify(await legacyBackup())) as BackupPayload
  Object.assign(payload, { version })
  if (version === 1) delete (payload as unknown as { reviewNotes?: unknown }).reviewNotes
  const original = structuredClone(payload)
  await db.delete(); await db.open()
  const fail = vi.spyOn(db.settings, 'put').mockRejectedValueOnce(new Error('synthetic restore settings failure'))
  await expect(importBackup(payload)).rejects.toThrow('synthetic restore settings failure')
  fail.mockRestore()
  for (const table of db.tables) expect(await table.count()).toBe(0)
  expect(payload).toEqual(original)
})
