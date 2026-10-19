import { beforeEach, expect, it, vi } from 'vitest'
import { act, render, waitFor } from '@testing-library/react'
import { AppProvider, useApp } from '../src/app/AppStore'
import { db, DEFAULT_SETTINGS, saveSettings } from '../src/db/db'
import { hashLegacyFile } from '../src/importers/legacyImport'
import { saveOriginalFile } from '../src/db/repository'
import * as repository from '../src/db/repository'
import { readLedgerRevision } from '../src/db/ledgerRevision'

let app: ReturnType<typeof useApp>
function Probe() { app = useApp(); return null }
beforeEach(async () => {
  vi.restoreAllMocks(); await db.delete(); await db.open()
  await saveSettings(DEFAULT_SETTINGS)
  // Avoid first-visit Demo without manufacturing financial records.
  await db.imports.put({ id: 'placeholder' } as never)
  render(<AppProvider><Probe /></AppProvider>)
  await waitFor(() => expect(app.state.ready).toBe(true))
  await db.imports.clear()
})
function file(size: number) {
  return { name: 'synthetic.pdf', size, type: 'application/pdf', arrayBuffer: vi.fn(async () => new ArrayBuffer(0)) } as unknown as File
}

it.each([25 * 1024 * 1024 + 1, 64 * 1024 * 1024 + 1])('rejects %i bytes before reading, hashing or archiving', async size => {
  const input = file(size)
  await act(async () => {
    const result = await app.importFiles([input])
    expect(result[0]).toMatchObject({ status: 'failed' })
    expect(result[0]!.message).toMatch(/25.*MiB/)
  })
  expect(input.arrayBuffer).not.toHaveBeenCalled()
  expect(await db.attachments.count()).toBe(0)
  expect(await db.transactions.count()).toBe(0)
})

it('rejects an over-budget batch before any file read or persistent mutation', async () => {
  const inputs = Array.from({ length: 5 }, () => file(25 * 1024 * 1024))
  await act(async () => { await expect(app.importFiles(inputs)).rejects.toThrow(/100.*MiB/) })
  for (const input of inputs) expect(input.arrayBuffer).not.toHaveBeenCalled()
  expect(await db.imports.count()).toBe(0)
  expect(await db.attachments.count()).toBe(0)
})

it('bounds history uploads before their full read and hash', async () => {
  const input = file(25 * 1024 * 1024 + 1)
  await expect(hashLegacyFile(input)).rejects.toThrow(/25.*MiB/)
  expect(input.arrayBuffer).not.toHaveBeenCalled()
})

it('refuses an oversized raw-evidence write before making its evidence copy', async () => {
  const data = new ArrayBuffer(64 * 1024 * 1024 + 1)
  const copy = vi.spyOn(data, 'slice')
  await expect(saveOriginalFile({ data, fileHash: 'synthetic', fileName: 'synthetic.bin', importId: 'synthetic', parserId: 'synthetic' })).rejects.toThrow(/64.*MiB/)
  expect(copy).not.toHaveBeenCalled()
  expect(await db.attachments.count()).toBe(0)
})

it('accepts the 25 MiB upload boundary for reading', async () => {
  const input = file(25 * 1024 * 1024)
  await hashLegacyFile(input)
  expect(input.arrayBuffer).toHaveBeenCalledOnce()
})

it('external choices preserve bytes, participate in revisions and roll back on failure', async () => {
  await saveOriginalFile({ data: new Uint8Array([1, 2, 3]).buffer, fileHash: 'synthetic', fileName: 'synthetic.bin', importId: 'synthetic', parserId: 'synthetic' })
  const before = await db.attachments.get('synthetic')
  const revision = await readLedgerRevision()
  await repository.setArchiveFileExternal('synthetic', true, revision)
  expect(await db.attachments.get('synthetic')).toEqual(before)
  expect(await repository.isArchiveFileExternal('synthetic')).toBe(true)
  await expect(repository.setArchiveFileExternal('synthetic', false, revision)).rejects.toThrow(/其他标签页/)
  const current = await readLedgerRevision()
  vi.spyOn(db.settings, 'put').mockRejectedValueOnce(new Error('synthetic quota'))
  await expect(repository.setArchiveFileExternal('synthetic', false, current)).rejects.toThrow('synthetic quota')
  expect(await readLedgerRevision()).toEqual(current)
  expect(await repository.isArchiveFileExternal('synthetic')).toBe(true)
  expect(await db.attachments.get('synthetic')).toEqual(before)
})
