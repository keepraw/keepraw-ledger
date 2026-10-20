import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, waitFor } from '@testing-library/react'
import { AppProvider, useApp } from '../src/app/AppStore'
import { db, DEFAULT_SETTINGS, saveSettings } from '../src/db/db'
import * as repository from '../src/db/repository'
import { getDemoSnapshot } from '../src/demo/demoStore'
import { deriveStatementState } from '../src/core/statementState'
import { ingestSynthetic } from './fixtures/identity'

let app: ReturnType<typeof useApp>
function Probe() { app = useApp(); return null }
async function mount() {
  const view = render(<AppProvider><Probe /></AppProvider>)
  await waitFor(() => expect(app.state.ready).toBe(true))
  return view
}
async function stored() {
  return { snapshot: await repository.readSnapshot(), notes: await db.reviewNotes.toArray(),
    attachments: await db.attachments.toArray(), revision: await repository.readImportSnapshot().then(s => s.revision) }
}
beforeEach(async () => {
  vi.restoreAllMocks()
  await db.transaction('rw', db.tables, async () => { for (const table of db.tables) await table.clear() })
  await repository.persistImportResults([ingestSynthetic(['消费 合成真实商户'])])
  await repository.setReviewNote('real-orphan', 'real private note')
  await saveSettings({ ...DEFAULT_SETTINGS, demoMode: true })
})

describe('AUD-006 isolated demo transactions', () => {
  it('publishes confirmation, exclusion, category and derived statement changes without a real write', async () => {
    await mount()
    const before = await stored(), persist = vi.spyOn(repository, 'patchTransactionWithStatements')
    const tx = app.visibleTransactions.find(row => row.reviewStatus === 'pending')!
    await act(async () => {
      await Promise.all([
        app.updateTransaction({ id: tx.id, reviewStatus: 'confirmed', flags: [] }),
        app.updateTransaction({ id: tx.id, category: '旅行' }),
      ])
    })
    expect(app.visibleTransactions.find(row => row.id === tx.id)).toMatchObject({ reviewStatus: 'confirmed', flags: [], category: '旅行' })
    const statement = app.visibleStatements.find(row => row.id === tx.statementId)!
    await act(async () => { await app.updateTransaction({ id: tx.id, reviewStatus: 'rejected' }) })
    const updated = app.visibleStatements.find(row => row.id === tx.statementId)!
    expect(updated).toEqual(deriveStatementState(statement, app.visibleTransactions.filter(row => row.statementId === statement.id)))
    expect(updated.reconciliation).not.toEqual(statement.reconciliation)
    expect(persist).not.toHaveBeenCalled()
    expect(await stored()).toEqual(before)
  })

  it('preserves demo edits/notes across switches and refresh, resets both on regeneration and provider reopening', async () => {
    const view = await mount(), tx = app.visibleTransactions[0]!, initial = structuredClone(tx)
    const before = await stored()
    await act(async () => {
      await app.updateTransaction({ id: tx.id, category: '旅行', reviewStatus: 'rejected' })
      await app.saveNote(tx.id, 'demo only')
      await app.setSettings({ demoMode: false })
    })
    expect(app.visibleTransactions.every(row => !row.isDemo)).toBe(true)
    expect(app.state.notes).toEqual({ 'real-orphan': 'real private note' })
    await act(async () => { await app.setSettings({ demoMode: true }); await app.refresh() })
    expect(app.visibleTransactions.find(row => row.id === tx.id)).toMatchObject({ category: '旅行', reviewStatus: 'rejected' })
    expect(app.state.notes).toEqual({ [tx.id]: 'demo only' })
    await act(async () => { await app.loadDemoData() })
    expect(app.visibleTransactions.find(row => row.id === tx.id)).toEqual(initial)
    expect(app.state.notes).toEqual({})
    expect(await stored()).toEqual(before)
    await act(async () => { await app.updateTransaction({ id: tx.id, category: '旅行' }); await app.saveNote(tx.id, 'ephemeral') })
    view.unmount()
    await mount()
    expect(app.visibleTransactions.find(row => row.id === tx.id)).toEqual(initial)
    expect(app.state.notes).toEqual({})
  })

  it('keeps queued demo writes out of IndexedDB even with a real id collision and a mode switch first', async () => {
    const demo = getDemoSnapshot().transactions[0]!
    const real = (await repository.readSnapshot()).transactions[0]!
    await db.transactions.put({ ...real, id: demo.id })
    await mount()
    const before = await stored(), flags: typeof demo.flags = ['uncategorized']
    await act(async () => {
      const switched = app.setSettings({ demoMode: false })
      const update = app.updateTransaction({ id: demo.id, category: '旅行', flags })
      const note = app.saveNote(demo.id, 'demo queued')
      flags.push('suspected_duplicate')
      await Promise.all([switched, update, note])
    })
    expect(await stored()).toEqual(before)
    await act(async () => { await app.setSettings({ demoMode: true }) })
    expect(app.visibleTransactions.find(row => row.id === demo.id)).toMatchObject({ category: '旅行', flags: ['uncategorized'] })
    expect(app.state.notes[demo.id]).toBe('demo queued')
  })

  it('rejects foreign targets and real writes queued behind entering demo; later real edits persist', async () => {
    await mount()
    const id = app.state.transactions[0]!.id, before = await stored()
    await act(async () => { await expect(app.updateTransaction({ id, category: '旅行' })).rejects.toThrow(/演示/) })
    expect(await stored()).toEqual(before)
    await act(async () => { await app.setSettings({ demoMode: false }) })
    await act(async () => {
      const switched = app.setSettings({ demoMode: true })
      const update = app.updateTransaction({ id, category: '旅行' })
      await switched
      await expect(update).rejects.toThrow(/演示/)
    })
    expect(await stored()).toEqual(before)
    await act(async () => { await app.setSettings({ demoMode: false }) })
    await act(async () => { await app.updateTransaction({ id, category: '旅行' }) })
    expect(await db.transactions.get(id)).toMatchObject({ category: '旅行' })
    expect(app.visibleTransactions[0]).toMatchObject({ category: '旅行' })
  })

  it('rejects queued edits and notes from the prior demo generation', async () => {
    await mount()
    const tx = app.visibleTransactions[0]!, before = await stored()
    await act(async () => {
      const reset = app.loadDemoData()
      const update = app.updateTransaction({ id: tx.id, category: '旅行' })
      const note = app.saveNote(tx.id, 'stale note')
      await reset
      await expect(update).rejects.toThrow(/重新生成/)
      await expect(note).rejects.toThrow(/重新生成/)
    })
    expect(app.visibleTransactions[0]).toEqual(tx)
    expect(app.state.notes).toEqual({})
    expect(await stored()).toEqual(before)
  })

  it('rejects leaving demo ownership without poisoning later edits or mutating the cached initial dataset', async () => {
    await mount()
    const tx = app.visibleTransactions[0]!, before = await stored()
    const initial = structuredClone(getDemoSnapshot())
    for (const patch of [{ id: tx.id, isDemo: false }, { id: tx.id, statementId: app.state.statements[0]!.id }]) {
      await act(async () => { await expect(app.updateTransaction(patch)).rejects.toThrow(/演示账单/) })
    }
    await act(async () => { await app.updateTransaction({ id: tx.id, category: '旅行' }) })
    expect(app.visibleTransactions[0]!.category).toBe('旅行')
    expect(getDemoSnapshot()).toEqual(initial)
    expect(await stored()).toEqual(before)
  })
})
