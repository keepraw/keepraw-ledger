import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppProvider, useApp } from '../src/app/AppStore'
import { db, DEFAULT_SETTINGS } from '../src/db/db'
import * as repository from '../src/db/repository'
import { failedImportRecord, ingestParsedStatement } from '../src/core/ingest'
import { SYNTHETIC_CCB_HTML } from './fixtures/ccbEml'
import { historyRow, workbookBytes } from './fixtures/legacyWorkbook'
import { LEGACY_UNIFIED_COLUMNS } from '../src/importers/legacyPythonExportV1'
import { ingestSynthetic, syntheticStatement } from './fixtures/identity'
import * as registry from '../src/parsers/registry'

let app: ReturnType<typeof useApp>
function Probe() { app = useApp(); return null }
function gate() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}
const bytes = new TextEncoder().encode(SYNTHETIC_CCB_HTML).buffer
beforeEach(async () => {
  await db.delete(); await db.open()
  await db.settings.put({ key: 'app', value: DEFAULT_SETTINGS })
  const seed = failedImportRecord({ fileName: 'synthetic', fileHash: 'seed', fileSize: 1, sourceType: 'text' }, 'seed')
  await db.imports.put(seed)
  render(<AppProvider><Probe /></AppProvider>)
  await waitFor(() => expect(app.state.ready).toBe(true))
  await db.imports.delete(seed.id)
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('AUD-005 cross-context import and clear', () => {
  it('does not resurrect rows when another tab clears after the bank import snapshot', async () => {
    const barrier = gate(); let reading = false
    const file = { name: 'synthetic.html', type: 'text/html', size: bytes.byteLength,
      arrayBuffer: async () => { reading = true; await barrier.promise; return bytes } } as File
    let done!: Promise<unknown>
    await act(async () => {
      done = app.importFiles([file]).then(() => null, error => error)
      await waitFor(() => expect(reading).toBe(true))
      await repository.clearAllData({ includeDemo: true })
      barrier.release()
      expect(await done).toBeInstanceOf(Error)
    })
    expect(await db.transactions.count()).toBe(0)
    expect(await db.statements.count()).toBe(0)
    expect(await db.imports.count()).toBe(0)
    expect(await db.attachments.count()).toBe(0)
  })
  it('rolls back a stale historical confirmation after another tab clears', async () => {
    const buffer = workbookBytes('标准字段', LEGACY_UNIFIED_COLUMNS, [historyRow()])
    const preview = await app.previewLegacyImport({ name: 'synthetic.xlsx', size: buffer.byteLength, arrayBuffer: async () => buffer } as File)
    const barrier = gate(); let writing = false
    const persist = repository.persistLegacyImport
    vi.spyOn(repository, 'persistLegacyImport').mockImplementation(async (...args) => {
      writing = true; await barrier.promise; return persist(...args)
    })
    await act(async () => {
      const done = app.confirmLegacyImport(preview).then(() => null, error => error)
      await waitFor(() => expect(writing).toBe(true))
      await repository.clearAllData({ includeDemo: true })
      barrier.release()
      expect(await done).toBeInstanceOf(Error)
    })
    expect(await db.transactions.count()).toBe(0)
    expect(await db.imports.count()).toBe(0)
  })
  it('cannot archive orphan evidence after a concurrent clear following the financial commit', async () => {
    const barrier = gate(); let archiving = false
    const save = repository.saveOriginalFile
    vi.spyOn(repository, 'saveOriginalFile').mockImplementation(async (...args) => {
      archiving = true; await barrier.promise; return save(...args)
    })
    await act(async () => {
      const done = app.importFiles([{ name: 'synthetic.html', type: 'text/html', size: bytes.byteLength, arrayBuffer: async () => bytes } as File]).then(() => null, error => error)
      await waitFor(() => expect(archiving).toBe(true))
      await repository.clearAllData({ includeDemo: true })
      barrier.release(); expect(await done).toBeInstanceOf(Error)
    })
    expect(await db.transactions.count()).toBe(0)
    expect(await db.imports.count()).toBe(0)
    expect(await db.attachments.count()).toBe(0)
  })
  it('replans after another tab edits classification/review without reparsing or overwriting decisions', async () => {
    const seed = ingestSynthetic(['消费 保留人工决定'], 'existing')
    await repository.persistImportResults([seed])
    const row = seed.transactions[0]!
    const persist = repository.persistImportResults
    const writes = vi.spyOn(repository, 'persistImportResults').mockImplementationOnce(async (...args) => {
      await repository.patchTransaction({ id: row.id, category: '旅行', reviewStatus: 'confirmed' })
      await repository.setReviewNote(row.id, 'Synthetic retained decision')
      return persist(...args)
    })
    const parses = vi.spyOn(registry, 'parseDocument')
    await act(async () => { await app.importFiles([{ name: 'synthetic.html', type: 'text/html', size: bytes.byteLength, arrayBuffer: async () => bytes } as File]) })
    expect(writes).toHaveBeenCalledTimes(2)
    expect(parses).toHaveBeenCalledTimes(1)
    expect(await db.transactions.get(row.id)).toMatchObject({ category: '旅行', reviewStatus: 'confirmed' })
    expect((await db.reviewNotes.get(row.id))!.note).toBe('Synthetic retained decision')
    expect(await db.transactions.count()).toBe(15)
  })
  it('bounds conflict retries to three attempts and leaves no partial imported batch', async () => {
    const seed = ingestSynthetic(['消费 并发编辑'], 'existing')
    await repository.persistImportResults([seed])
    const persist = repository.persistImportResults
    const writes = vi.spyOn(repository, 'persistImportResults').mockImplementation(async (...args) => {
      await repository.patchTransaction({ id: seed.transactions[0]!.id, reviewStatus: 'confirmed' })
      return persist(...args)
    })
    const parses = vi.spyOn(registry, 'parseDocument')
    await act(async () => {
      await expect(app.importFiles([{ name: 'synthetic.html', type: 'text/html', size: bytes.byteLength, arrayBuffer: async () => bytes } as File])).rejects.toThrow('本次操作已回滚')
    })
    expect(writes).toHaveBeenCalledTimes(3)
    expect(parses).toHaveBeenCalledTimes(1)
    expect(await db.transactions.count()).toBe(1)
    expect(await db.imports.count()).toBe(1)
    expect(await db.attachments.count()).toBe(0)
    writes.mockRestore()
    await act(async () => { await app.importFiles([{ name: 'synthetic.html', type: 'text/html', size: bytes.byteLength, arrayBuffer: async () => bytes } as File]) })
    expect(await db.transactions.count()).toBe(15)
    expect(await db.imports.count()).toBe(2)
    expect(await db.attachments.count()).toBe(1)
  })
  it('rejects contradictory bank summaries instead of trusting whichever file writes last', async () => {
    const parsed = syntheticStatement(['消费 合成商户A'])
    parsed.summary = { ...parsed.summary, previousBalanceMinor: 0, currentBalanceMinor: 12880, newDebitMinor: 12880, newCreditMinor: 0 }
    const first = ingestParsedStatement(parsed, { fileName: 'first.txt', fileHash: 'first', fileSize: 1, sourceType: 'text' }, await repository.readSnapshot())
    await repository.persistImportResults([first])
    const before = await repository.readSnapshot()
    const next = syntheticStatement(['消费 合成商户B'])
    next.summary = { ...parsed.summary, currentBalanceMinor: 25760, newDebitMinor: 25760 }
    const second = ingestParsedStatement(next, { fileName: 'second.txt', fileHash: 'second', fileSize: 1, sourceType: 'text' }, before)
    await expect(repository.persistImportResults([second])).rejects.toThrow(/银行汇总.*冲突/)
    expect(await repository.readSnapshot()).toEqual(before)
  })
})
