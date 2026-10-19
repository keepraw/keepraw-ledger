import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db, DEFAULT_SETTINGS } from '../src/db/db'
import { clearAllData, clearDemoData, saveOriginalFile } from '../src/db/repository'
import { buildDemoDataset } from '../src/demo/demoData'
import { LEDGER_REVISION_KEY } from '../src/db/ledgerRevision'

beforeEach(async () => { await db.delete(); await db.open() })

async function seed() {
  const demo = buildDemoDataset()[0]!
  const real = buildDemoDataset()[1]!
  await db.statements.bulkPut([demo.statement!, { ...real.statement!, isDemo: false }])
  await db.transactions.bulkPut([demo.transactions[0]!, { ...real.transactions[0]!, isDemo: false }])
  await db.imports.bulkPut([demo.record, { ...real.record, isDemo: false }])
  await db.settings.put({ key: 'app', value: DEFAULT_SETTINGS })
  for (const result of [demo, real]) {
    await saveOriginalFile({ fileHash: result.record.fileHash, fileName: result.record.fileName,
      data: new TextEncoder().encode('synthetic').buffer, importId: result.record.id, parserId: result.record.parserId })
    await db.reviewNotes.put({ transactionId: result.transactions[0]!.id, note: 'synthetic note', updatedAt: '2026-01-01T00:00:00Z' })
  }
  await saveOriginalFile({ fileHash: 'orphan', fileName: 'orphan.txt', data: new ArrayBuffer(1), importId: 'gone', parserId: '' })
  await db.reviewNotes.put({ transactionId: 'gone', note: 'orphan', updatedAt: '2026-01-01T00:00:00Z' })
  return { demo, real }
}

describe('sensitive record deletion', () => {
  it('removes real evidence, notes and orphans, preserving demo records and settings', async () => {
    const { demo, real } = await seed()
    await clearAllData({ includeDemo: false })
    expect(await db.attachments.get(real.record.fileHash)).toBeUndefined()
    expect(await db.reviewNotes.get(real.transactions[0]!.id)).toBeUndefined()
    expect(await db.attachments.get('orphan')).toBeUndefined()
    expect(await db.reviewNotes.get('gone')).toBeUndefined()
    expect(await db.attachments.get(demo.record.fileHash)).toBeDefined()
    expect(await db.reviewNotes.get(demo.transactions[0]!.id)).toBeDefined()
    expect(await db.transactions.count()).toBe(1)
    expect(await db.statements.count()).toBe(1)
    expect(await db.imports.count()).toBe(1)
    expect((await db.settings.get('app'))!.value).toEqual(DEFAULT_SETTINGS)
  })

  it('preserves evidence shared with a surviving demo import', async () => {
    const { demo, real } = await seed()
    await db.imports.put({ ...demo.record, fileHash: real.record.fileHash })
    await clearAllData({ includeDemo: false })
    expect(await db.attachments.get(real.record.fileHash)).toBeDefined()
  })

  it('rolls back every table if sensitive-data deletion fails', async () => {
    await seed()
    const fail = vi.spyOn(db.attachments, 'bulkDelete').mockRejectedValueOnce(new Error('storage failure'))
    await expect(clearAllData({ includeDemo: false })).rejects.toThrow('storage failure')
    fail.mockRestore()
    expect(await db.transactions.count()).toBe(2)
    expect(await db.statements.count()).toBe(2)
    expect(await db.imports.count()).toBe(2)
    expect(await db.reviewNotes.count()).toBe(3)
    expect(await db.attachments.count()).toBe(3)
  })

  it('clears all sensitive data but keeps settings', async () => {
    await seed()
    await clearAllData({ includeDemo: true })
    expect(await db.attachments.count()).toBe(0)
    expect(await db.reviewNotes.count()).toBe(0)
    // Clear retains preferences plus the non-financial generation tombstone,
    // which prevents a plan captured before this clear from recreating data.
    expect(await db.settings.count()).toBe(2)
    expect(await db.settings.toArray()).toEqual([
      { key: 'app', value: DEFAULT_SETTINGS },
      { key: LEDGER_REVISION_KEY, value: { version: 1, generation: 1, writer: expect.any(String) } },
    ])
    expect(await db.transactions.count()).toBe(0)
    expect(await db.statements.count()).toBe(0)
    expect(await db.imports.count()).toBe(0)
  })

  it('clearing demo data leaves real notes and evidence intact', async () => {
    const { real, demo } = await seed()
    await clearDemoData()
    expect(await db.reviewNotes.get(real.transactions[0]!.id)).toBeDefined()
    expect(await db.attachments.get(real.record.fileHash)).toBeDefined()
    expect(await db.reviewNotes.get(demo.transactions[0]!.id)).toBeUndefined()
    expect(await db.attachments.get(demo.record.fileHash)).toBeUndefined()
  })
})
