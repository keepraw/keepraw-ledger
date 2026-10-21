import Dexie from 'dexie'
import JSZip from 'jszip'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { BillDatabase, db } from '../src/db/db'
import { buildFullBackupZip, DATABASE_JSON, previewFullBackupZip, restoreFullBackupZip } from '../src/backup/archive'
import { readJsonBackup } from '../src/backup/json'
import { exportDataBackup, importBackup, patchTransaction, persistImportResults, persistLegacyImport, readSnapshot, saveOriginalFile, updateTransactions, validateBackup } from '../src/db/repository'
import { withoutLegacyMerchant } from '../src/db/transactionRecord'
import { ingestParsedStatement } from '../src/core/ingest'
import { transactionDisplayDescription } from '../src/core/descriptionNormalizer'
import { buildCsv, EXPORT_COLUMNS, transactionToRow } from '../src/export/tabular'
import { sha256Hex } from '../src/parsers/extract'
import { ingestSynthetic, syntheticStatement, EMPTY_SNAPSHOT } from './fixtures/identity'
import { MIGRATION_FORMATS, migrationFixture } from './fixtures/historicalMigration'
import { previewLegacyWorkbook, planLegacyImport } from '../src/importers/legacyImport'

beforeEach(async () => { vi.restoreAllMocks(); await db.delete(); await db.open() })
afterEach(() => vi.useRealTimers())
const schemaV3 = { statements: 'id', transactions: 'id, statementId', imports: 'id', settings: 'key', reviewNotes: 'transactionId', attachments: 'fileHash' }

it('v3 → v4 removes only merchant, preserves every other property/store and survives reopen', async () => {
  const name = 'synthetic-merchant-v3'
  await Dexie.delete(name)
  const old = new Dexie(name); old.version(3).stores(schemaV3)
  const result = ingestSynthetic(['消费 支付宝-合成 A-B (HK)', '消费 支付宝-合成 A-B (HK)', '消费 合成第三笔'])
  const rows = result.transactions.map((row, index) => ({ ...row, merchant: '旧标签', category: '教育' as const,
    reviewStatus: 'confirmed' as const, retainedExtension: { synthetic: true },
    description: index === 2 ? '消费 人工输入-A:01' : row.description }))
  const note = { transactionId: rows[0]!.id, note: '保留原样\n合成复核备注', updatedAt: '2024-01-01T00:00:00Z' }
  const attachment = { fileHash: 'synthetic-hash', fileName: 'synthetic.txt', mimeType: 'text/plain', size: 4,
    data: new Uint8Array([1, 2, 3, 4]).buffer, importId: result.record.id, parserId: result.record.parserId, importedAt: note.updatedAt }
  await old.table('transactions').bulkAdd(rows)
  await old.table('statements').put(result.statement)
  await old.table('imports').put(result.record)
  await old.table('settings').put({ key: 'app', value: { demoMode: false } })
  await old.table('reviewNotes').put(note); await old.table('attachments').put(attachment)
  old.close()
  const upgraded = new BillDatabase(name)
  try {
    for (let count = 0; count < 2; count++) {
      await upgraded.open()
      expect(upgraded.verno).toBe(4)
      const actual = await upgraded.transactions.toArray()
      expect(actual).toEqual(rows.map(withoutLegacyMerchant))
      expect(actual.every(row => !Object.hasOwn(row, 'merchant'))).toBe(true)
      expect(transactionDisplayDescription(actual.find(row => row.id === rows[2]!.id)!)).toBe('消费 人工输入-A:01')
      expect(await upgraded.statements.toArray()).toEqual([result.statement])
      expect(await upgraded.imports.toArray()).toEqual([result.record])
      expect(await upgraded.reviewNotes.toArray()).toEqual([note])
      expect(await upgraded.attachments.toArray()).toEqual([attachment])
      expect(await upgraded.settings.get('app')).toEqual({ key: 'app', value: { demoMode: false } })
      expect(upgraded.transactions.schema.indexes.map(index => index.name)).toEqual(['statementId'])
      const repeat = ingestSynthetic(['消费 支付宝-合成 A-B (HK)', '消费 支付宝-合成 A-B (HK)'], 'repacked', {
        imports: [], transactions: actual, statements: [result.statement!],
      })
      expect(repeat.inserted).toEqual([])
      expect(repeat.skippedDuplicates.map(row => [row.id, row.fingerprint, row.occurrence])).toEqual(
        rows.slice(0, 2).map(row => [row.id, row.fingerprint, row.occurrence]))
      upgraded.close()
    }
  } finally { await upgraded.delete() }
})

it('rolls back the real v4 field deletion when a later upgrade step aborts', async () => {
  const name = 'synthetic-merchant-upgrade-abort'
  await Dexie.delete(name)
  const old = new Dexie(name); old.version(3).stores(schemaV3)
  const rows = ingestSynthetic(['消费 合成升级回滚']).transactions.map(row => ({ ...row, merchant: '必须回滚保留' }))
  await old.table('transactions').bulkAdd(rows); old.close()
  const failing = new BillDatabase(name)
  let deletionObserved = false
  failing.version(5).stores({}).upgrade(async transaction => {
    const row = await transaction.table('transactions').get(rows[0]!.id)
    deletionObserved = !Object.hasOwn(row, 'merchant')
    throw new Error('synthetic abort after v4 deletion')
  })
  await expect(failing.open()).rejects.toThrow('synthetic abort after v4 deletion')
  failing.close(); expect(deletionObserved).toBe(true)
  const reopened = new Dexie(name)
  try {
    await reopened.open()
    expect(reopened.verno).toBe(3)
    expect(await reopened.table('transactions').toArray()).toEqual(rows)
  } finally { reopened.close() }
  const upgraded = new BillDatabase(name)
  try { await upgraded.open(); expect(await upgraded.transactions.toArray()).toEqual(rows.map(withoutLegacyMerchant)) }
  finally { await upgraded.delete() }
})

async function seed() {
  const bytes = new TextEncoder().encode('SYNTHETIC_MERCHANT_REMOVAL_EVIDENCE')
  const fileHash = await sha256Hex(bytes.buffer)
  const result = ingestParsedStatement(syntheticStatement(['消费 支付宝-合成 A-B (HK)']), {
    fileName: 'synthetic.txt', fileHash, fileSize: bytes.length, sourceType: 'text',
  }, EMPTY_SNAPSHOT)
  await persistImportResults([result])
  await patchTransaction({ id: result.transactions[0]!.id, category: '教育', reviewStatus: 'confirmed', description: '消费 人工输入-A:01' })
  await db.reviewNotes.put({ transactionId: result.transactions[0]!.id, note: '保留合成备注\n第二行', updatedAt: '2024-01-01T00:00:00Z' })
  await saveOriginalFile({ fileHash, fileName: 'synthetic.txt', data: bytes.buffer, importId: result.record.id, parserId: result.record.parserId })
  return { payload: await exportDataBackup(), snapshot: await readSnapshot(), attachments: await db.attachments.toArray(), notes: await db.reviewNotes.toArray() }
}

function legacyPayload(payload: Awaited<ReturnType<typeof exportDataBackup>>, version: number) {
  const legacy = JSON.parse(JSON.stringify(payload))
  legacy.version = version
  if (version === 1) delete legacy.reviewNotes
  for (const row of legacy.transactions) row.merchant = '旧版商户标签'
  return legacy
}

it.each([1, 2])('restores old V%s JSON, discards only merchant, retains original caller input and stays idempotent', async version => {
  const before = await seed()
  const legacy = legacyPayload(before.payload, version)
  const decoded = await readJsonBackup(new Blob([JSON.stringify(legacy)]))
  expect(validateBackup(decoded)).toBe(true)
  if (!validateBackup(decoded)) throw new Error('invalid synthetic backup')
  await db.delete(); await db.open(); await importBackup(decoded); await importBackup(decoded)
  expect(await readSnapshot()).toEqual(before.snapshot)
  expect(await db.reviewNotes.toArray()).toEqual(version === 2 ? before.notes : [])
  expect(legacy.transactions[0]).toHaveProperty('merchant', '旧版商户标签')
  expect(decoded.transactions[0]).toHaveProperty('merchant', '旧版商户标签')
  expect((await exportDataBackup()).transactions).toEqual(before.payload.transactions)
  expect((await db.transactions.toArray()).every(row => !Object.hasOwn(row, 'merchant'))).toBe(true)
})

it.each([1, 2])('restores old V%s ZIP with notes and original evidence intact, then exports no merchant', async version => {
  // ZIP restores retain evidence bytes/metadata but assign a new storage timestamp.
  // Freeze only Date so the full-object assertion remains deterministic.
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-01T00:00:00Z'))
  const before = await seed()
  const archive = await buildFullBackupZip()
  const zip = await JSZip.loadAsync(archive.blob)
  const current = JSON.parse(await zip.file(DATABASE_JSON)!.async('string'))
  expect(current.transactions.every((row: object) => !Object.hasOwn(row, 'merchant'))).toBe(true)
  zip.file(DATABASE_JSON, JSON.stringify(legacyPayload(current, version)))
  const oldZip = await zip.generateAsync({ type: 'blob' })
  expect((await previewFullBackupZip(oldZip)).backupVersion).toBe(version)
  await db.delete(); await db.open(); await restoreFullBackupZip(oldZip); await restoreFullBackupZip(oldZip)
  expect(await readSnapshot()).toEqual(before.snapshot)
  expect(await db.attachments.toArray()).toEqual(before.attachments)
  expect(await db.reviewNotes.toArray()).toEqual(version === 2 ? before.notes : [])
  const exported = await JSZip.loadAsync((await buildFullBackupZip()).blob)
  expect(JSON.parse(await exported.file(DATABASE_JSON)!.async('string')).transactions).toEqual(before.payload.transactions)
})

it('still rejects malformed retired fields and every other invalid financial field', async () => {
  const { payload } = await seed()
  for (const merchant of [null, 1, {}, []]) {
    const legacy = legacyPayload(payload, 2); legacy.transactions[0].merchant = merchant
    expect(validateBackup(legacy)).toBe(false)
    await expect(importBackup(legacy)).rejects.toThrow('无效记录')
  }
  for (const [key, value] of [['settlementAmountMinor', 1.5], ['transactionDate', '2024-02-30'], ['occurrence', 0], ['description', null], ['id', '']] as const) {
    const legacy = legacyPayload(payload, 2); legacy.transactions[0][key] = value
    expect(validateBackup(legacy)).toBe(false)
  }
})

it('rejects old backup conflicts and rolls back restored notes and evidence on write failure', async () => {
  const before = await seed()
  const conflict = legacyPayload(before.payload, 2); conflict.transactions[0].settlementAmountMinor++
  await expect(importBackup(conflict)).rejects.toThrow('冲突')
  expect(await readSnapshot()).toEqual(before.snapshot)
  const zip = await JSZip.loadAsync((await buildFullBackupZip()).blob)
  zip.file(DATABASE_JSON, JSON.stringify(legacyPayload(before.payload, 2)))
  const oldZip = await zip.generateAsync({ type: 'blob' })
  await db.delete(); await db.open()
  const fail = vi.spyOn(db.attachments, 'put').mockRejectedValueOnce(new Error('synthetic quota failure'))
  await expect(restoreFullBackupZip(oldZip)).rejects.toThrow('synthetic quota failure')
  fail.mockRestore()
  for (const table of [db.transactions, db.statements, db.imports, db.reviewNotes, db.attachments]) expect(await table.count()).toBe(0)
})

it('repository writes and exports cannot reintroduce a stale runtime merchant property', async () => {
  const result = ingestSynthetic(['消费 支付宝-合成 A-B (HK)'])
  const stale = { ...result.transactions[0]!, merchant: '陈旧调用方' }
  await persistImportResults([{ ...result, transactions: [stale] }])
  expect(await db.transactions.get(stale.id)).not.toHaveProperty('merchant')
  await patchTransaction({ ...stale, category: '教育' })
  expect(await db.transactions.get(stale.id)).not.toHaveProperty('merchant')
  await updateTransactions([stale])
  expect(await db.transactions.get(stale.id)).not.toHaveProperty('merchant')
  // Defensive export also omits a field introduced by direct IndexedDB access.
  await db.transactions.put(stale)
  expect((await exportDataBackup()).transactions[0]).not.toHaveProperty('merchant')
  const row = transactionToRow(stale)
  expect(EXPORT_COLUMNS.some(column => String(column.key) === 'merchant')).toBe(false)
  expect(buildCsv([stale]).split('\r\n')[0]).not.toContain('商户')
  expect(row[4]).toBe('支付宝-合成 A-B (HK)')
})

it.each(MIGRATION_FORMATS)('$sheet: adapters and persisted plans omit merchant for all six banks', async format => {
  const { buffer } = migrationFixture(format)
  const preview = await previewLegacyWorkbook(buffer, { fileName: 'synthetic.xlsx', fileHash: 'synthetic', fileSize: buffer.byteLength }, EMPTY_SNAPSHOT)
  expect(preview.rows.every(row => !Object.hasOwn(row, 'merchant'))).toBe(true)
  const plan = planLegacyImport(preview, EMPTY_SNAPSHOT)
  expect(plan.inserted.every(row => !Object.hasOwn(row, 'merchant'))).toBe(true)
  await persistLegacyImport(plan)
  expect((await db.transactions.toArray()).every(row => !Object.hasOwn(row, 'merchant'))).toBe(true)
})
