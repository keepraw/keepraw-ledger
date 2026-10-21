import { matchesTransactionDescription } from '../../src/core/descriptionNormalizer'
import { useLayoutEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { AppProvider, useApp } from '../../src/app/AppStore'
import { AppShell } from '../../src/ui/AppShell'
import { db, DEFAULT_SETTINGS } from '../../src/db/db'
import * as repository from '../../src/db/repository'
import { hashLegacyFile, planLegacyImport, previewLegacyWorkbook } from '../../src/importers/legacyImport'
import { validateBackup } from '../../src/backup/validation'
import { applyFilters, DEFAULT_FILTERS } from '../../src/core/analytics'
import { bankName } from '../../src/core/types'
import '../../src/ui/theme.css'

const byteSize = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength
const now = () => performance.now()
const paint = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
let api: ReturnType<typeof useApp>
let commitAt = 0
const longTasks: Array<{ startTime: number; duration: number }> = []
new PerformanceObserver(list => { for (const entry of list.getEntries()) longTasks.push({ startTime: entry.startTime, duration: entry.duration }) }).observe({ type: 'longtask', buffered: true })

function Probe() {
  const current = useApp()
  api = current
  useLayoutEffect(() => { commitAt = now() }, [current.state.transactions])
  useLayoutEffect(() => { if (current.state.ready) window.dispatchEvent(new Event('benchmark-ready')) }, [current.state.ready])
  return <AppShell />
}
createRoot(document.getElementById('root')!).render(<AppProvider><Probe /></AppProvider>)

async function file(name: string) {
  const bytes = await (await fetch(`/__fixture/${name}`)).arrayBuffer()
  return new File([bytes], name, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
}
async function settleUsage() {
  const samples: number[] = []
  for (let i = 0; i < 5; i++) {
    samples.push((await navigator.storage.estimate()).usage ?? 0)
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  return { samples, usage: [...samples].sort((a, b) => a - b)[2]!, details: await navigator.storage.estimate() }
}
async function metrics() {
  const tables: Record<string, { count: number; jsonBytes: number; binaryBytes: number }> = {}
  const values: Record<string, unknown[]> = {}
  for (const table of db.tables) {
    const rows = await table.toArray()
    values[table.name] = rows
    const metadata = table.name === 'attachments' ? rows.map(({ data: _data, ...row }) => row) : rows
    tables[table.name] = { count: rows.length, jsonBytes: byteSize(metadata), binaryBytes: table.name === 'attachments' ? rows.reduce((sum, row) => sum + row.data.byteLength, 0) : 0 }
  }
  const snapshot = await repository.readSnapshot()
  const txs = snapshot.transactions
  const fields = Object.fromEntries(Object.keys(txs[0] ?? {}).map(key => {
    const vals = txs.map(tx => (tx as unknown as Record<string, unknown>)[key])
    const unique = new Set(vals.map(value => JSON.stringify(value)))
    const jsonValueBytes = vals.reduce<number>((sum, value) => sum + byteSize(value), 0)
    const marginalBytes = jsonValueBytes + txs.length * (byteSize(key) + 2) // quoted key + colon + comma
    return [key, { jsonValueBytes, marginalBytes, averageValueBytes: jsonValueBytes / txs.length,
      uniqueValues: unique.size, utf8TextBytes: vals.reduce<number>((sum, value) => sum + (typeof value === 'string' ? new TextEncoder().encode(value).length : 0), 0) }]
  }))
  const indexes = []
  for (const table of db.tables) {
    const native = db.backendDB().transaction(table.name).objectStore(table.name)
    const entries = []
    for (const name of Array.from(native.indexNames)) {
      const index = native.index(name)
      const count = await new Promise<number>((resolve, reject) => { const request = index.count(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
      entries.push({ name, keyPath: index.keyPath, unique: index.unique, count })
    }
    indexes.push({ table: table.name, primaryKey: table.schema.primKey.keyPath, indexes: entries })
  }
  const eq = (a: keyof typeof txs[number], b: keyof typeof txs[number]) => txs.filter(tx => tx[a] === tx[b]).length
  const statementIds = new Set(snapshot.statements.map(row => row.id))
  const importHashes = new Set(snapshot.imports.map(row => row.fileHash))
  const notes = await db.reviewNotes.toArray(), attachments = await db.attachments.toArray()
  const countBy = (key: keyof typeof txs[number]) => {
    const counts: Record<string, number> = {}; for (const tx of txs) { const value = String(tx[key]); counts[value] = (counts[value] ?? 0) + 1 } return counts
  }
  const counterfactuals = Object.fromEntries([
    ['rawDescription'], ['rawText'], ['sourceFileName', 'sourceFileHash'],
    ['rawDescription', 'rawText', 'sourceFileName', 'sourceFileHash'],
  ].map(keys => {
    // Serialization-only copies. No production object or stored row is altered.
    const bytes = byteSize(txs.map(tx => Object.fromEntries(Object.entries(tx).filter(([key]) => !keys.includes(key)))))
    return [keys.join('+'), { jsonBytes: bytes, savedBytes: tables.transactions!.jsonBytes - bytes }]
  }))
  return { tables, fields, indexes, counterfactuals, totalRecordsJsonBytes: Object.values(tables).reduce((sum, t) => sum + t.jsonBytes, 0),
    transactionObjectJsonBytes: txs.reduce((sum, tx) => sum + byteSize(tx), 0),
    equalities: { descriptionRawDescription: eq('description', 'rawDescription'), descriptionRawText: eq('description', 'rawText') },
    distribution: { banks: countBy('bank'), types: countBy('type'), currencies: countBy('transactionCurrency'), flags: txs.filter(tx => tx.flags.length > 0).length,
      repeatedOccurrences: txs.filter(tx => tx.occurrence > 1).length, uniqueIds: new Set(txs.map(tx => tx.id)).size,
      crossCurrency: txs.filter(tx => tx.transactionCurrency !== tx.settlementCurrency).length, negative: txs.filter(tx => tx.settlementAmountMinor < 0).length },
    orphans: { transactions: txs.filter(tx => !statementIds.has(tx.statementId)).length, transactionSources: txs.filter(tx => !importHashes.has(tx.sourceFileHash)).length,
      notes: notes.filter(row => !txs.some(tx => tx.id === row.transactionId)).length, attachments: attachments.filter(row => !importHashes.has(row.fileHash)).length },
    usage: await settleUsage(), backupValid: validateBackup(await repository.exportDataBackup()) }
}

async function normalImport(name: string) {
  const input = await file(name) // fetch is intentionally outside import timing
  const start = now()
  const preview = await api.previewLegacyImport(input)
  const previewEnd = now()
  const record = await api.confirmLegacyImport(preview)
  const confirmEnd = now()
  await paint()
  return { previewMs: previewEnd - start, confirmMs: confirmEnd - previewEnd, totalMs: now() - start,
    record: { status: record.status, transactionCount: record.transactionCount }, valid: preview.stats.validRows, anomalies: preview.anomalies.length,
    longTasks: longTasks.filter(t => t.startTime >= start) }
}
async function components(name: string) {
  const input = await file(name), empty = { transactions: [], statements: [], imports: [] }
  let start = now(); const { buffer, fileHash } = await hashLegacyFile(input); const hashMs = now() - start
  start = now(); const preview = await previewLegacyWorkbook(buffer, { fileName: input.name, fileSize: input.size, fileHash }, empty); const previewMs = now() - start
  start = now(); const plan = planLegacyImport(preview, empty); const planMs = now() - start
  return { hashMs, previewMs, planMs, plan }
}

async function performanceSamples(repeats: number) {
  const samples = []
  // Warm modules and methods once; each recorded read still issues real IndexedDB requests.
  await repository.readSnapshot()
  for (let i = 0; i < repeats; i++) {
    let start = now(); const snapshot = await repository.readSnapshot(); const readMs = now() - start
    start = now(); const all = applyFilters(snapshot.transactions, DEFAULT_FILTERS).filter(() => true)
    const filterAllMs = now() - start
    start = now(); all.sort((a, b) => {
      const left = a.transactionDate, right = b.transactionDate
      if (left === right) return (a.transactionDate ?? '').localeCompare(b.transactionDate ?? '')
      if (left === null) return 1; if (right === null) return -1
      return String(left).localeCompare(String(right)) * -1
    }); const dateSortMs = now() - start
    start = now(); const selected = applyFilters(snapshot.transactions, { ...DEFAULT_FILTERS, banks: ['boc'], from: '2023-01-01', to: '2025-12-31' }).filter(tx =>
      matchesTransactionDescription(tx, '咖啡') || tx.cardLast4.includes('咖啡') || bankName(tx.bank).includes('咖啡'))
    const filteredSearchMs = now() - start
    start = now(); [...snapshot.transactions].sort((a, b) => a.description === b.description ? (a.transactionDate ?? '').localeCompare(b.transactionDate ?? '') : String(a.description).localeCompare(String(b.description)))
    const descriptionSortMs = now() - start
    start = now(); const payload = await repository.exportDataBackup(); const backupReadMs = now() - start
    start = now(); const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }); const backupEncodeBlobMs = now() - start
    const refreshStart = now(); await api.refresh(); const refreshResolvedMs = now() - refreshStart
    await paint(); const refreshPaintMs = now() - refreshStart
    samples.push({ readMs, filterAllMs, dateSortMs, filteredSearchMs, descriptionSortMs, filteredRecords: selected.length,
      backupReadMs, backupEncodeBlobMs, backupTotalMs: backupReadMs + backupEncodeBlobMs, backupBytes: blob.size,
      refreshResolvedMs, refreshCommitMs: commitAt - refreshStart, refreshPaintMs })
  }
  return samples
}

async function scratch(name: string, indexed: boolean) {
  const { plan, ...timings } = await components(name)
  const schema = db.tables.map(table => ({ name: table.name, primary: table.schema.primKey.keyPath,
    indexes: table.schema.indexes.map(index => ({ name: index.name, keyPath: index.keyPath, unique: index.unique, multiEntry: index.multi })) }))
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('synthetic-index-control', 1)
    request.onupgradeneeded = () => { for (const table of schema) {
      const store = request.result.createObjectStore(table.name, { keyPath: table.primary })
      if (indexed) for (const index of table.indexes) {
        if (index.keyPath === undefined) throw new Error(`Missing index key path: ${index.name}`)
        store.createIndex(index.name, index.keyPath, { unique: index.unique, multiEntry: index.multiEntry })
      }
    } }
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error)
  })
  const baseline = await settleUsage()
  const start = now()
  await new Promise<void>((resolve, reject) => {
    const tx = database.transaction(['transactions', 'statements', 'imports'], 'readwrite')
    for (const row of plan.inserted) tx.objectStore('transactions').add(row)
    for (const row of plan.statements) tx.objectStore('statements').add(row)
    tx.objectStore('imports').add(plan.record)
    tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error)
  })
  database.close()
  return { ...timings, indexed, records: plan.inserted.length, persistenceMs: now() - start, baseline, after: await settleUsage() }
}

async function lifecycle(name: string, alternate: string) {
  const stages: Array<{ label: string; counts: Record<string, number>; usage: Awaited<ReturnType<typeof settleUsage>> }> = []
  const checkpoint = async (label: string) => {
    stages.push({ label, counts: Object.fromEntries(await Promise.all(db.tables.map(async t => [t.name, await t.count()]))), usage: await settleUsage() })
  }
  await checkpoint('initial')
  for (let i = 0; i < 5; i++) { await normalImport(name); await checkpoint(`identical-import-${i + 1}`) }
  await normalImport(alternate); await checkpoint('different-hash-same-business-rows')
  const tx = (await repository.readSnapshot()).transactions[0]!
  for (let i = 0; i < 10; i++) { await api.updateTransaction({ id: tx.id, category: i % 2 ? tx.category : '其他' }); await api.saveNote(tx.id, `合成测试备注 ${i}`); await api.backupData() }
  await checkpoint('ten-edit-note-backup-cycles')
  await api.saveNote(tx.id, ''); await checkpoint('delete-synthetic-note')
  const snapshot = await repository.readSnapshot()
  const imports = snapshot.imports.filter(record => record.status === 'duplicate')
  return { stages, duplicateRecords: imports.map(record => ({ id: record.id, transactionCount: record.transactionCount, duplicateOf: record.duplicateOf })), metrics: await metrics() }
}

async function attachmentExperiment(name: string) {
  const input = await file(name), { buffer, fileHash } = await hashLegacyFile(input)
  const record = (await db.imports.toArray()).find(row => row.fileHash === fileHash)!
  const before = await settleUsage()
  for (let i = 0; i < 5; i++) await repository.saveOriginalFile({ fileName: name, fileHash, data: buffer, importId: record.id, parserId: record.parserId })
  return { before, after: await metrics(), inputBytes: buffer.byteLength }
}

Object.assign(window, { benchmark: {
  ready: () => Boolean(api?.state.ready), count: () => api?.state.transactions.length ?? 0,
  disableDemo: async () => { await api.setSettings({ ...DEFAULT_SETTINGS, demoMode: false }); await paint() },
  metrics, normalImport, performanceSamples, components: async (name: string) => { const { plan: _plan, ...result } = await components(name); return result },
  persistenceSample: async () => {
    const snapshot = await repository.readSnapshot(), record = snapshot.imports[0]!
    await db.transaction('rw', db.transactions, db.statements, db.imports, async () => { await db.transactions.clear(); await db.statements.clear(); await db.imports.clear() })
    const start = now(); await repository.persistLegacyImport({ record, statements: snapshot.statements, inserted: snapshot.transactions }); return now() - start
  },
  lifecycle, attachmentExperiment, scratch, usage: settleUsage,
  backupRoundTrip: async () => {
    const payload = await repository.exportDataBackup()
    const input = new File([JSON.stringify(payload, null, 2)], 'synthetic-self-backup.json', { type: 'application/json' })
    return { bytes: input.size, result: await api.restore(input) }
  },
  openMs: async () => { db.close(); const start = now(); await db.open(); return now() - start },
} })
