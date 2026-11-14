import { beforeEach, expect, it, vi } from 'vitest'
import { db } from '../src/db/db'
import { reviewTransactions } from '../src/db/repository'
import { readLedgerRevision } from '../src/db/ledgerRevision'
import { reviewBatchFixture } from './fixtures/reviewBatch'

beforeEach(async () => {
  vi.restoreAllMocks(); await db.delete(); await db.open()
  const fixture = reviewBatchFixture(204)
  await db.statements.bulkAdd(fixture.statements); await db.transactions.bulkAdd(fixture.transactions)
  await db.imports.bulkAdd(fixture.imports); await db.reviewNotes.bulkAdd(fixture.notes)
})
async function stored() {
  return Object.fromEntries(await Promise.all(db.tables.map(async table => [table.name, await table.toArray()])))
}
it.each(['confirmed', 'rejected'] as const)('atomically %s latest rows with only review-field changes and one revision', async decision => {
  const rows = await db.transactions.toArray()
  const selected = rows.filter(row => row.reviewStatus === 'pending').slice(0, 102)
  const ids = selected.map(row => row.id)
  await db.transactions.update(ids[0]!, { category: '旅行', description: 'Synthetic concurrent edit', confidence: 0.43 })
  const before = await stored(), revision = await readLedgerRevision()
  const result = await reviewTransactions([...ids, ids[0]!], decision)
  expect(result.transactions).toHaveLength(102)
  const selectedIds = new Set(ids)
  expect(await db.transactions.toArray()).toEqual((before.transactions as typeof rows).map(row => selectedIds.has(row.id)
    ? { ...row, reviewStatus: decision, flags: decision === 'confirmed' ? [] : row.flags } : row))
  for (const name of ['reviewNotes', 'imports', 'attachments']) expect(await db.table(name).toArray()).toEqual(before[name])
  expect((await readLedgerRevision()).version).toBe(revision.version + 1)
  expect(result.statements).toHaveLength(1)
})
it('rolls back transactions, statements and revision if recomputation fails after rows were written', async () => {
  const before = await stored()
  const fail = vi.spyOn(db.statements, 'put').mockRejectedValueOnce(new Error('synthetic statement failure'))
  const ids = (await db.transactions.toArray()).filter(row => row.reviewStatus === 'pending').map(row => row.id)
  await expect(reviewTransactions(ids, 'rejected')).rejects.toThrow('synthetic statement failure')
  fail.mockRestore(); expect(await stored()).toEqual(before)
})
it('rolls back a later write chunk; never reports partial batch success', async () => {
  const fixture = reviewBatchFixture(2004)
  await db.transactions.bulkPut(fixture.transactions)
  const ids = fixture.transactions.filter(row => row.reviewStatus === 'pending').map(row => row.id)
  const before = await stored()
  const original = db.transactions.bulkPut.bind(db.transactions)
  let writes = 0
  const fail = vi.spyOn(db.transactions, 'bulkPut').mockImplementation((...args) => {
    if (++writes === 2) return Promise.reject(new Error('synthetic second chunk failure')) as ReturnType<typeof original>
    return original(...args)
  })
  await expect(reviewTransactions(ids, 'confirmed')).rejects.toThrow('synthetic second chunk failure')
  fail.mockRestore(); expect(writes).toBe(2); expect(await stored()).toEqual(before)
}, 20_000)
it('rejects missing, normal, rejected and stored demo targets before any writes', async () => {
  const rows = await db.transactions.toArray()
  const target = rows.find(row => row.reviewStatus === 'pending')!
  const demo = { ...target, id: 'synthetic-stored-demo', isDemo: true }
  await db.transactions.put(demo)
  const before = await stored()
  for (const id of ['missing', rows.find(row => row.reviewStatus === 'ok')!.id,
    rows.find(row => row.reviewStatus === 'rejected')!.id, demo.id]) {
    await expect(reviewTransactions([target.id, id], 'confirmed')).rejects.toThrow()
    expect(await stored()).toEqual(before)
  }
  await db.settings.put({ key: 'app', value: { demoMode: true } })
  const demoBefore = await stored()
  await expect(reviewTransactions([target.id], 'rejected')).rejects.toThrow('演示模式')
  expect(await stored()).toEqual(demoBefore)
})
