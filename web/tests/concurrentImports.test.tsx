import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppProvider, useApp } from '../src/app/AppStore'
import { db, DEFAULT_SETTINGS } from '../src/db/db'
import * as repository from '../src/db/repository'
import { failedImportRecord } from '../src/core/ingest'
import { SYNTHETIC_CCB_HTML } from './fixtures/ccbEml'
import { historyRow, workbookBytes } from './fixtures/legacyWorkbook'
import { LEGACY_UNIFIED_COLUMNS } from '../src/importers/legacyPythonExportV1'

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
      const done = app.importFiles([{ name: 'synthetic.html', type: 'text/html', size: bytes.byteLength, arrayBuffer: async () => bytes } as File])
      await waitFor(() => expect(archiving).toBe(true))
      await repository.clearAllData({ includeDemo: true })
      barrier.release(); await done
    })
    expect(await db.transactions.count()).toBe(0)
    expect(await db.imports.count()).toBe(0)
    expect(await db.attachments.count()).toBe(0)
  })
})
