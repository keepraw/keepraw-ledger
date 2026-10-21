import Dexie from 'dexie'
import { expect, it } from 'vitest'
import { BillDatabase } from '../src/db/db'
import { ingestSynthetic } from './fixtures/identity'

const historic = {
  statements: 'id, bank, cardLast4, cycleEnd, status, isDemo',
  transactions: 'id, statementId, bank, transactionDate, postingDate, type, category, reviewStatus, isDemo, fingerprint, [bank+transactionDate]',
  imports: 'id, fileHash, importedAt, status, isDemo', settings: 'key', reviewNotes: 'transactionId',
}
const current = { ...historic, attachments: 'fileHash, importId, importedAt' }

for (const version of [1, 2]) {
  it(`upgrades v${version} to v4 without rewriting any stored record and can reopen`, async () => {
    const name = `synthetic-index-upgrade-${version}`
    await Dexie.delete(name)
    const old = new Dexie(name)
    old.version(version).stores(version === 1 ? historic : current)
    const result = ingestSynthetic(['消费 合成升级商户', '消费 合成升级商户'])
    const rows = result.transactions.map(row => ({ ...row, category: '旅行', reviewStatus: 'confirmed' as const }))
    const note = { transactionId: rows[0]!.id, note: 'Synthetic retained note', updatedAt: '2024-01-01T00:00:00Z' }
    const attachment = { fileHash: 'synthetic-hash', fileName: 'synthetic.txt', mimeType: 'text/plain', size: 4,
      data: new Uint8Array([1, 2, 3, 4]).buffer, importId: result.record.id, parserId: result.record.parserId,
      importedAt: '2024-01-01T00:00:00Z' }
    await old.open()
    await old.table('statements').add(result.statement)
    await old.table('transactions').bulkAdd(rows)
    await old.table('imports').add(result.record)
    await old.table('settings').add({ key: 'app', value: { demoMode: false } })
    await old.table('reviewNotes').add(note)
    if (version === 2) await old.table('attachments').add(attachment)
    old.close()
    const upgraded = new BillDatabase(name)
    try {
      for (let open = 0; open < 3; open++) {
        await upgraded.open()
        expect(upgraded.verno).toBe(4)
        expect(upgraded.tables.flatMap(table => table.schema.indexes.map(index => `${table.name}.${index.name}`))).toEqual(['transactions.statementId'])
        expect(await upgraded.transactions.toArray()).toEqual(rows)
        expect(await upgraded.statements.get(result.statement!.id)).toEqual(result.statement)
        expect(await upgraded.imports.get(result.record.id)).toEqual(result.record)
        expect(await upgraded.reviewNotes.get(note.transactionId)).toEqual(note)
        expect(await upgraded.settings.get('app')).toEqual({ key: 'app', value: { demoMode: false } })
        expect(await upgraded.attachments.toArray()).toEqual(version === 2 ? [attachment] : [])
        upgraded.close()
      }
    } finally { await upgraded.delete() }
  })
}

it('rolls back index removal on an aborted upgrade and can subsequently upgrade safely', async () => {
  const name = 'synthetic-index-abort'
  await Dexie.delete(name)
  const old = new Dexie(name)
  old.version(2).stores(current)
  const rows = ingestSynthetic(['消费 合成升级失败商户']).transactions
  await old.table('transactions').bulkAdd(rows)
  old.close()
  const failing = new BillDatabase(name)
  failing.version(3).upgrade(() => { throw new Error('synthetic upgrade abort') })
  await expect(failing.open()).rejects.toThrow('synthetic upgrade abort')
  failing.close()
  const reopened = new Dexie(name)
  try {
    await reopened.open()
    expect(reopened.backendDB().version).toBe(20)
    expect(reopened.tables.reduce((sum, table) => sum + table.schema.indexes.length, 0)).toBe(21)
    expect(await reopened.table('transactions').toArray()).toEqual(rows)
  } finally { reopened.close() }
  const upgraded = new BillDatabase(name)
  try { await upgraded.open(); expect(await upgraded.transactions.toArray()).toEqual(rows) }
  finally { await upgraded.delete() }
})

it('initializes a new v4 database with all six stores and the retained association index', async () => {
  const database = new BillDatabase('synthetic-new-v4')
  try {
    await database.open()
    expect(database.tables.map(table => table.name).sort()).toEqual(['attachments', 'imports', 'reviewNotes', 'settings', 'statements', 'transactions'])
    expect(database.transactions.schema.indexes.map(index => index.name)).toEqual(['statementId'])
  } finally { await database.delete() }
})
