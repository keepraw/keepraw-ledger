import Dexie from 'dexie'
import { expect, it } from 'vitest'
import { repairNativeLedgerConfidence } from '../src/db/nativeConfidenceRepair'
import { BillDatabase } from '../src/db/db'
import type { Transaction } from '../src/core/types'
import { buildDataQualityReport } from '../src/core/dataQuality'
import { nativeTransaction } from './fixtures/nativeLedger'

const schema = { statements: 'id', transactions: 'id, statementId', imports: 'id', settings: 'key',
  reviewNotes: 'transactionId', attachments: 'fileHash' }
const sourceId = 'legacy-keepraw-ledger-export-v1'
const queue = (rows: Transaction[]) => rows.filter(tx => tx.reviewStatus === 'pending' ||
  (tx.flags.length > 0 && tx.reviewStatus !== 'rejected')).length
const expectedRow = (row: Transaction) => row.origin === 'legacy_import' && row.sourceId === sourceId
  ? { ...row, flags: row.flags.filter(flag => flag !== 'low_confidence') } : row

it('atomically repairs native rows; preserves all other fields, notes and stores across repeated repair and reopen', async () => {
  const name = 'synthetic-native-confidence-large'
  await Dexie.delete(name)
  const old = new Dexie(name); old.version(4).stores(schema)
  const rows = Array.from({ length: 182 }, (_, i): Transaction => ({ ...nativeTransaction(i + 1),
    statementId: `synthetic-period-${Math.floor(i / 100)}`,
    origin: 'legacy_import', sourceId, confidence: 0, flags: i < 12 ? ['low_confidence', 'suspected_duplicate'] : ['low_confidence'],
    reviewStatus: i < 100 ? 'ok' : i < 140 ? 'confirmed' : i < 170 ? 'pending' : 'rejected' }))
  const controls: Transaction[] = [
    { ...nativeTransaction(20_000), origin: 'parser', sourceId, confidence: 0.6, flags: ['low_confidence'] },
    { ...nativeTransaction(20_001), origin: 'legacy_import', sourceId: 'legacy-python-export-v1', flags: ['low_confidence'] },
    { ...nativeTransaction(20_002), sourceId, flags: ['low_confidence'] },
    { ...nativeTransaction(20_003), origin: 'legacy_import', flags: ['low_confidence'] },
    { ...nativeTransaction(20_004), origin: 'legacy_import', sourceId, flags: ['suspected_duplicate'], confidence: 1 },
    { ...nativeTransaction(20_005), origin: 'legacy_import', sourceId, flags: [], reviewStatus: 'pending' },
  ]
  const all = [...rows, ...controls]
  const notes = all.map(row => ({ transactionId: row.id, note: `Synthetic note ${row.occurrence}\n保留`, updatedAt: '2024-01-01T00:00:00Z' }))
  await old.table('transactions').bulkAdd(all)
  await old.table('reviewNotes').bulkAdd(notes)
  for (const table of ['statements', 'imports', 'settings', 'attachments']) {
    const key = table === 'settings' ? { key: 'synthetic' } : table === 'attachments' ? { fileHash: 'synthetic' } : { id: 'synthetic' }
    await old.table(table).put({ ...key, retained: ['synthetic', 42] })
  }
  const read = async (database: Dexie) => Object.fromEntries(await Promise.all(database.tables.map(async table => [table.name, await table.toArray()])))
  const before = await read(old); old.close()
  expect(queue(rows)).toBe(170)
  const upgraded = new BillDatabase(name)
  try {
    await upgraded.open()
    const after = await read(upgraded)
    const expected = { ...before, transactions: (before.transactions as Transaction[]).map(expectedRow) }
    expect(after).toEqual(expected)
    const native = (after.transactions as Transaction[]).filter(row => row.occurrence <= 182)
    expect(native).toHaveLength(182)
    expect(queue(native)).toBe(42)
    expect(buildDataQualityReport({ transactions: rows, statements: [], imports: [] }).review.flagged).toBe(182)
    expect(buildDataQualityReport({ transactions: native, statements: [], imports: [] }).review.flagged).toBe(12)
    // Force the registered repair step to run again in an upgrade transaction.
    upgraded.close()
    const repeated = new BillDatabase(name)
    repeated.version(6).stores({}).upgrade(repairNativeLedgerConfidence)
    try {
      await repeated.open(); expect(await read(repeated)).toEqual(expected)
      repeated.close(); await repeated.open(); expect(await read(repeated)).toEqual(expected)
    } finally { repeated.close() }
  } finally { await upgraded.delete() }
}, 15_000)

it('rolls back completed flag repair and database version on abort, then safely retries', async () => {
  const name = 'synthetic-native-confidence-abort'
  await Dexie.delete(name)
  const old = new Dexie(name); old.version(4).stores(schema)
  const row: Transaction = { ...nativeTransaction(), origin: 'legacy_import', sourceId, confidence: 0,
    flags: ['low_confidence', 'suspected_duplicate'], reviewStatus: 'rejected' }
  await old.table('transactions').put(row); old.close()
  const failing = new BillDatabase(name)
  let repaired = false
  failing.version(6).stores({}).upgrade(async transaction => {
    repaired = !(await transaction.table('transactions').get(row.id)).flags.includes('low_confidence')
    throw new Error('synthetic failure after repair')
  })
  await expect(failing.open()).rejects.toThrow('synthetic failure after repair')
  failing.close(); expect(repaired).toBe(true)
  const rollback = new Dexie(name)
  try {
    await rollback.open(); expect(rollback.verno).toBe(4)
    expect(await rollback.table('transactions').toArray()).toEqual([row])
  } finally { rollback.close() }
  const retry = new BillDatabase(name)
  try { await retry.open(); expect(await retry.transactions.toArray()).toEqual([expectedRow(row)]) }
  finally { await retry.delete() }
})
