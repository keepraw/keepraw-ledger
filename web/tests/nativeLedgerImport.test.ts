import * as XLSX from 'xlsx'
import { LEGACY_UNIFIED_COLUMNS } from '../src/importers/legacyPythonExportV1'
import { beforeEach, describe, expect, it } from 'vitest'
import { EXPORT_COLUMNS, transactionToRow } from '../src/export/tabular'
import { transactionDisplayDescription } from '../src/core/descriptionNormalizer'
import { BANKS, TRANSACTION_TYPES } from '../src/core/types'
import { transactionId } from '../src/core/dedupe'
import { sha256Hex } from '../src/parsers/extract'
import { db } from '../src/db/db'
import { persistLegacyImport, readImportSnapshot, readSnapshot } from '../src/db/repository'
import { planLegacyImport, previewLegacyWorkbook } from '../src/importers/legacyImport'
import { detectNativeLedgerShape } from '../src/importers/legacyKeeprawLedgerExportV1'
import { LEGACY_KEEPRAW_LEDGER_EXPORT_V1 } from '../src/importers/types'
import { EMPTY_SNAPSHOT } from './fixtures/identity'
import { NATIVE_DISPLAY_CASES, NATIVE_HEADERS, nativeCells, nativeDisplayCells, nativeTransaction, nativeWorkbook } from './fixtures/nativeLedger'

const meta = { fileName: 'synthetic-native.xlsx', fileSize: 1, fileHash: 'synthetic-native-hash' }
const preview = (rows?: unknown[][], headers?: string[]) => previewLegacyWorkbook(nativeWorkbook(rows, headers), meta, EMPTY_SNAPSHOT)
beforeEach(async () => { await db.delete(); await db.open() })

describe('native Keepraw-Ledger XLSX round trip', () => {
  it('freezes the exact 20-column historical schema and the actual 21-column exporter', async () => {
    expect(NATIVE_HEADERS).toHaveLength(20)
    expect(EXPORT_COLUMNS.map(column => column.header)).toEqual([...NATIVE_HEADERS, '原始描述'])
    expect(detectNativeLedgerShape(NATIVE_HEADERS)).toBe(20)
    expect(detectNativeLedgerShape([...NATIVE_HEADERS, '原始描述'])).toBe(21)
    expect((await preview()).stats).toMatchObject({ formatId: LEGACY_KEEPRAW_LEDGER_EXPORT_V1, totalRows: 2,
      validRows: 2, anomalyRows: 0, banks: ['boc'], cards: ['boc / 0012'], dateRange: { min: '2024-01-05', max: '2024-01-05' } })
  })

  it('rejects every missing/renamed/duplicate header, extra columns and reordered schemas', async () => {
    for (let index = 0; index < NATIVE_HEADERS.length; index++) {
      const missing = NATIVE_HEADERS.filter((_, position) => position !== index)
      const renamed = NATIVE_HEADERS.map((header, position) => position === index ? `${header} renamed` : header)
      const duplicate = NATIVE_HEADERS.map((header, position) => position === index ? NATIVE_HEADERS[(index + 1) % 20]! : header)
      for (const headers of [missing, renamed, duplicate]) {
        expect(detectNativeLedgerShape(headers)).toBeNull()
        await expect(preview([nativeCells()], headers)).rejects.toThrow()
      }
    }
    for (const headers of [[...NATIVE_HEADERS, '说明'], [...NATIVE_HEADERS].reverse(), [...NATIVE_HEADERS, '结算币种', '结算金额', '说明']]) {
      await expect(preview([nativeCells()], headers)).rejects.toThrow()
    }
  })

  it('rejects a workbook with two recognized migration sources', async () => {
    const book = XLSX.read(nativeWorkbook(), { type: 'array' })
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([[...LEGACY_UNIFIED_COLUMNS]]), '标准字段')
    const buffer = XLSX.write(book, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer
    await expect(previewLegacyWorkbook(buffer, meta, EMPTY_SNAPSHOT)).rejects.toThrow(/多个可识别/)
  })

  it('maps every available field; retains sparse occurrences and both monetary legs', async () => {
    const result = planLegacyImport(await preview(), EMPTY_SNAPSHOT)
    expect(result.inserted).toHaveLength(2)
    const { statementId: _statementId, confidence: _confidence, flags: _flags, sourceRow: _sourceRow, ...expected } = nativeTransaction()
    expect(result.inserted[0]).toMatchObject({ ...expected, confidence: 0, flags: ['low_confidence'], sourceRow: 2,
      origin: 'legacy_import', sourceId: LEGACY_KEEPRAW_LEDGER_EXPORT_V1 })
    expect(result.inserted.map(row => row.occurrence)).toEqual([1, 3])
    expect(result.inserted[1]!.id).toBe(nativeTransaction(3).id)
    expect(result.statements[0]!.reconciliation.status).toBe('insufficient')
  })

  it('keeps native IDs when rows are reordered and retains XLSX row provenance across blank rows', async () => {
    const result = await preview([nativeCells(3), [], nativeCells(1)])
    expect(result.stats).toMatchObject({ totalRows: 2, validRows: 2 })
    expect(result.rows.map(row => [row.id, row.occurrence, row.sourceRow])).toEqual([
      [nativeTransaction(3).id, 3, 2], [nativeTransaction(1).id, 1, 4],
    ])
  })

  it.each(['ok', 'pending', 'confirmed', 'rejected'] as const)('preserves exported review status %s and empty source metadata', async reviewStatus => {
    const tx = nativeTransaction(1, { reviewStatus, sourceFileName: '', sourceFileHash: '', sourcePage: null, rawText: '' })
    const result = await preview([transactionToRow(tx)], [...NATIVE_HEADERS, '原始描述'])
    expect(planLegacyImport(result, EMPTY_SNAPSHOT).inserted[0]).toMatchObject({ reviewStatus,
      sourceFileName: '', sourceFileHash: '', sourcePage: null, rawText: '' })
  })

  it('round trips the actual exporter, including display normalization, raw text and all transaction types', async () => {
    for (const type of TRANSACTION_TYPES) {
      const tx = nativeTransaction(4, { type, description: '消费 Synthetic Store', rawDescription: '消费 Synthetic Store', reviewStatus: 'rejected' })
      const result = await preview([transactionToRow(tx)], [...NATIVE_HEADERS, '原始描述'])
      expect(result.anomalies).toEqual([])
      expect(result.rows[0]).toMatchObject({ description: tx.description, rawDescription: tx.rawDescription, type,
        id: tx.id, fingerprint: tx.fingerprint, occurrence: 4 })
      expect(planLegacyImport(result, EMPTY_SNAPSHOT).inserted[0]!.reviewStatus).toBe('rejected')
    }
    for (const bank of Object.keys(BANKS) as Array<keyof typeof BANKS>) {
      const tx = nativeTransaction(1, { bank, description: 'Synthetic Store', rawDescription: 'Synthetic Store /',
        transactionCurrency: 'JPY', transactionAmountMinor: -123, settlementAmountMinor: -9625, direction: 'credit', type: 'refund' })
      const result = await preview([transactionToRow(tx)], [...NATIVE_HEADERS, '原始描述'])
      expect(result.anomalies).toEqual([])
      expect(result.rows[0]).toMatchObject({ id: tx.id, bank, transactionAmountMinor: -123, direction: 'credit', type: 'refund' })
    }
  })

  it('preserves an intentionally empty raw description when the exported identity still verifies', async () => {
    const tx = nativeTransaction(1, { rawDescription: '' })
    const result = await preview([transactionToRow(tx)], [...NATIVE_HEADERS, '原始描述'])
    expect(result.anomalies).toEqual([])
    expect(planLegacyImport(result, EMPTY_SNAPSHOT).inserted[0]).toMatchObject({ id: tx.id,
      description: tx.description, rawDescription: '' })
    const invalid: unknown[] = transactionToRow(tx); invalid[20] = 123
    expect((await preview([invalid], [...NATIVE_HEADERS, '原始描述'])).anomalies[0]!.kind).toBe('invalid_field')
  })

  it('reports unrecoverable display identity in 20 columns instead of generating replacement IDs', async () => {
    const tx = nativeTransaction(1, { description: '消费 Synthetic Store', rawDescription: '消费 Synthetic Store' })
    const old = transactionToRow(tx).slice(0, 20)
    expect(transactionDisplayDescription(tx)).not.toBe(tx.description)
    const result = await preview([old])
    expect(result.stats.validRows).toBe(0)
    expect(result.anomalies[0]!.kind).toBe('identity_conflict')
  })

  it.each(NATIVE_DISPLAY_CASES)('accepts verified 20-column identity despite another display conversion: %s → %s', async (description, displayedAgain) => {
    const tx = nativeTransaction(7, { description, rawDescription: description })
    expect(transactionDisplayDescription(tx)).toBe(displayedAgain)
    const row = nativeDisplayCells(description, 7)
    const result = await preview([row])
    expect(result.stats).toMatchObject({ totalRows: 1, validRows: 1, anomalyRows: 0 })
    expect(result.anomalies).toEqual([])
    expect(planLegacyImport(result, EMPTY_SNAPSHOT).inserted[0]).toMatchObject({
      id: tx.id, fingerprint: tx.fingerprint, occurrence: 7, description, rawDescription: description,
    })
  })

  it.each(NATIVE_DISPLAY_CASES)('retains strict 21-column raw-description and display validation: %s', async description => {
    const tx = nativeTransaction(7, { description, rawDescription: description })
    const headers = [...NATIVE_HEADERS, '原始描述']
    const valid = await preview([transactionToRow(tx)], headers)
    expect(valid.stats).toMatchObject({ validRows: 1, anomalyRows: 0 })
    expect(valid.rows[0]).toMatchObject({ id: tx.id, description, rawDescription: description })
    // Fingerprint and ID still verify, but the raw text cannot produce this
    // stale display value. Only the 20-column schema may omit that check.
    const inconsistent = [...nativeDisplayCells(description, 7), description]
    const invalid = await preview([inconsistent], headers)
    expect(invalid.rows).toEqual([])
    expect(invalid.anomalies[0]!.kind).toBe('identity_conflict')
  })

  it.each(['', 'garbage', '1.001', '9007199254740999', 'USD 1.00', true, Infinity, 'NaN'])('rejects invalid money %s independently', async value => {
    for (const index of [6, 8]) {
      const row = nativeCells(); row[index] = value
      const result = await preview([row])
      expect(result.rows).toEqual([])
      expect(result.anomalies[0]!.kind).toBe('amount_unparseable')
    }
  })

  it.each([[5, ''], [5, 'XYZ'], [7, ''], [2, '2024-02-30'], [3, 'wrong'], [0, 'Unknown bank'],
    [1, 12], [4, ''], [9, 'unknown'], [10, '贷'], [11, 'custom'], [12, 'invalid'], [15, '0'],
    [17, 'fake-id'], [18, '0000000000000000'], [19, '0'], [19, '2'], [19, '9007199254740992']])('reports invalid field at %s', async (index, value) => {
    const row = nativeCells(); row[index as number] = value
    const result = await preview([row])
    expect(result.rows).toEqual([])
    expect(result.anomalies[0]!.rowNumber).toBe(2)
  })

  it('retains nullable dates without filling from the other leg', async () => {
    const tx = nativeTransaction(2, { transactionDate: null })
    const result = await preview([transactionToRow(tx)], [...NATIVE_HEADERS, '原始描述'])
    expect(result.rows[0]).toMatchObject({ id: tx.id, transactionDate: null, postingDate: tx.postingDate })
    expect(result.stats.dateRange).toEqual({ min: tx.postingDate, max: tx.postingDate })
    const row = nativeCells(); row[2] = ''; row[3] = ''
    expect((await preview([row])).anomalies[0]!.kind).toBe('date_unparseable')
  })

  it('excludes every workbook row sharing an ambiguous ID', async () => {
    const result = await preview([nativeCells(), nativeCells()])
    expect(result.rows).toEqual([])
    expect(result.stats).toMatchObject({ totalRows: 2, anomalyRows: 2 })
    expect(result.anomalies.map(row => row.kind)).toEqual(['identity_conflict', 'identity_conflict'])
    const invalid = nativeCells(); invalid[8] = 'broken-money'
    const mixed = await preview([nativeCells(), invalid])
    expect(mixed.rows).toEqual([])
    expect(mixed.stats.anomalyRows).toBe(2)
  })

  it('preserves identities in a fresh DB and skips same-file and repacked imports without changing user metadata', async () => {
    const first = await preview()
    await persistLegacyImport(planLegacyImport(first, EMPTY_SNAPSHOT))
    const before = await readSnapshot()
    expect(before.transactions.map(tx => tx.id).sort()).toEqual([nativeTransaction().id, nativeTransaction(3).id].sort())
    await db.transactions.update(nativeTransaction().id, { category: '其他', reviewStatus: 'rejected', confidence: 1, flags: [] })
    const edited = await readSnapshot()
    for (const fileHash of [meta.fileHash, 'synthetic-repacked']) {
      const next = await previewLegacyWorkbook(nativeWorkbook(), { ...meta, fileHash }, edited)
      expect(next.stats.alreadyStored).toBe(2)
      const plan = planLegacyImport(next, edited)
      expect(plan.inserted).toEqual([])
      await persistLegacyImport(plan)
      expect((await readSnapshot()).transactions).toEqual(edited.transactions)
    }
  })

  it('recognizes an original bank-parser ID without creating an empty migration statement', async () => {
    const first = planLegacyImport(await preview([nativeCells()]), EMPTY_SNAPSHOT)
    const original = { ...first.inserted[0]!, statementId: 'synthetic-original-period', origin: 'parser' as const,
      sourceId: undefined, confidence: 0.97, flags: [] }
    await db.statements.add({ ...first.statements[0]!, id: original.statementId, statementKey: original.statementId,
      cycleStart: '2024-01-01', cycleEnd: '2024-01-31' })
    await db.transactions.add(original)
    const before = await readSnapshot()
    const incoming = await previewLegacyWorkbook(nativeWorkbook([nativeCells()]), meta, before)
    expect(incoming.stats.alreadyStored).toBe(1)
    const plan = planLegacyImport(incoming, before)
    expect(plan.inserted).toEqual([])
    expect(plan.statements).toEqual([])
    await persistLegacyImport(plan)
    const after = await readSnapshot()
    expect(after.transactions).toEqual(before.transactions)
    expect(after.statements).toEqual(before.statements)
  })

  async function seedPartialImport() {
    const cells = [nativeCells(1), nativeDisplayCells(), nativeCells(3)]
    const buffer = nativeWorkbook(cells)
    const fileMeta = { ...meta, fileSize: buffer.byteLength, fileHash: await sha256Hex(buffer) }
    const full = await previewLegacyWorkbook(buffer, fileMeta, EMPTY_SNAPSHOT)
    // Reproduce the old parser's partial result for these exact same bytes.
    const oldRows = full.rows.filter(row => transactionDisplayDescription(row) === row.description)
    expect(oldRows).toHaveLength(2)
    await persistLegacyImport(planLegacyImport({ ...full, rows: oldRows,
      stats: { ...full.stats, validRows: 2, anomalyRows: 1 },
      anomalies: [{ rowNumber: 3, kind: 'identity_conflict', detail: 'Old display equality check' }],
    }, EMPTY_SNAPSHOT))
    const id = String(cells[0]![17])
    await db.transactions.update(id, { category: '其他', reviewStatus: 'rejected', confidence: 1,
      flags: [], rawDescription: 'Local raw description', rawText: 'Local source evidence', sourceRow: 99,
      sourceFileName: 'local-source.txt', sourceFileHash: 'local-source-hash', sourcePage: 42 })
    await db.reviewNotes.put({ transactionId: id, note: 'Local review note\n保留原文', updatedAt: '2024-02-01T00:00:00Z' })
    return { buffer, fileMeta, missingId: String(cells[1]![17]), before: await readSnapshot() }
  }

  it('recovers only missing IDs from a partially imported identical file, preserves edits and notes, then inserts zero', async () => {
    const { buffer, fileMeta, missingId, before } = await seedPartialImport()
    const notes = await db.reviewNotes.toArray()
    const next = await previewLegacyWorkbook(buffer, fileMeta, before)
    expect(next.stats).toMatchObject({ duplicateFile: true, totalRows: 3, validRows: 3, anomalyRows: 0, alreadyStored: 2 })
    const { revision } = await readImportSnapshot()
    const plan = planLegacyImport(next, before)
    expect(plan.inserted.map(row => row.id)).toEqual([missingId])
    expect(plan.skipped).toBe(2)
    expect(plan.record).toMatchObject({ status: 'imported', transactionCount: 1, duplicateOf: null })
    expect(plan.record.message).toContain('增量恢复')
    expect(plan.record.message).toContain('新增 1 笔，跳过 2 笔已存在')
    expect(plan.statements).toHaveLength(1)
    await persistLegacyImport(plan, revision)
    const recovered = await readSnapshot()
    expect(recovered.transactions).toHaveLength(3)
    for (const tx of before.transactions) expect(await db.transactions.get(tx.id)).toEqual(tx)
    expect(await db.reviewNotes.toArray()).toEqual(notes)
    expect(recovered.statements[0]).toMatchObject({ ...before.statements[0], transactionCount: 3 })

    const repeat = await previewLegacyWorkbook(buffer, fileMeta, recovered)
    expect(repeat.stats).toMatchObject({ duplicateFile: true, alreadyStored: 3 })
    const second = planLegacyImport(repeat, recovered)
    expect(second.inserted).toEqual([])
    expect(second.skipped).toBe(3)
    expect(second.statements).toEqual([])
    expect(second.record).toMatchObject({ status: 'duplicate', transactionCount: 0, duplicateOf: plan.record.id })
    await persistLegacyImport(second)
    expect((await readSnapshot()).transactions).toEqual(recovered.transactions)
    expect((await readSnapshot()).statements).toEqual(recovered.statements)
    expect(await db.reviewNotes.toArray()).toEqual(notes)
  })

  it('blocks conflicts in partially imported files at confirmation without inserting any missing rows', async () => {
    const { buffer, fileMeta, before } = await seedPartialImport()
    const next = await previewLegacyWorkbook(buffer, fileMeta, before)
    await db.transactions.update(before.transactions[0]!.id, { transactionAmountMinor: 999 })
    const conflicting = await readSnapshot()
    expect(() => planLegacyImport(next, conflicting)).toThrow(/交易标识冲突/)
    expect(await readSnapshot()).toEqual(conflicting)
    const blocked = await previewLegacyWorkbook(buffer, fileMeta, conflicting)
    expect(blocked.identityWarnings?.some(issue => issue.blocking)).toBe(true)
  })

  it('rolls back recovery, import history and statements if a missing ID collides after planning', async () => {
    const { buffer, fileMeta, before } = await seedPartialImport()
    const plan = planLegacyImport(await previewLegacyWorkbook(buffer, fileMeta, before), before)
    await db.transactions.add({ ...plan.inserted[0]!, transactionAmountMinor: 999 })
    const concurrent = await readSnapshot()
    await expect(persistLegacyImport(plan)).rejects.toThrow()
    expect(await readSnapshot()).toEqual(concurrent)
  })

  it('creates required statements when recovery reaches a bank/card excluded entirely in the original import', async () => {
    const recoveredTx = nativeTransaction(1, { bank: 'icbc' })
    const buffer = nativeWorkbook([nativeCells(), transactionToRow(recoveredTx).slice(0, 20)])
    const full = await previewLegacyWorkbook(buffer, meta, EMPTY_SNAPSHOT)
    await persistLegacyImport(planLegacyImport({ ...full, rows: full.rows.slice(0, 1) }, EMPTY_SNAPSHOT))
    const existing = await readSnapshot()
    const plan = planLegacyImport(await previewLegacyWorkbook(buffer, meta, existing), existing)
    expect(plan.inserted.map(row => row.id)).toEqual([recoveredTx.id])
    expect(plan.statements).toHaveLength(1)
    await persistLegacyImport(plan)
    const recovered = await readSnapshot()
    expect(recovered.statements).toHaveLength(2)
    expect(recovered.transactions.every(tx => recovered.statements.some(statement => statement.id === tx.statementId))).toBe(true)
  })

  it('does not consume a different stored occurrence with matching business fields', async () => {
    const prior = planLegacyImport(await preview([nativeCells(1)]), EMPTY_SNAPSHOT)
    await persistLegacyImport(prior)
    const existing = await readSnapshot()
    const next = await previewLegacyWorkbook(nativeWorkbook([nativeCells(3)]), { ...meta, fileHash: 'other-native' }, existing)
    expect(next.stats.alreadyStored).toBe(0)
    expect(next.identityWarnings?.some(warning => !warning.blocking)).toBe(true)
    const plan = planLegacyImport(next, existing)
    expect(plan.inserted[0]).toMatchObject({ id: nativeTransaction(3).id, occurrence: 3, reviewStatus: 'pending' })
    expect(plan.inserted[0]!.flags).toContain('suspected_duplicate')
    await persistLegacyImport(plan)
    expect(await db.transactions.get(nativeTransaction().id)).toEqual(existing.transactions[0])
    expect(await db.transactions.count()).toBe(2)
  })

  it.each(['transactionAmountMinor', 'settlementAmountMinor', 'description', 'postingDate', 'direction'] as const)('blocks an existing ID with conflicting %s, including on confirmation after preview', async field => {
    const first = await preview()
    const current = planLegacyImport(first, EMPTY_SNAPSHOT)
    const changed = { ...current.inserted[0]!, [field]: field.endsWith('Minor') ? 10 : 'different' }
    const existing = { ...EMPTY_SNAPSHOT, imports: [current.record], transactions: [changed] }
    const next = await previewLegacyWorkbook(nativeWorkbook(), meta, existing)
    expect(next.stats).toMatchObject({ duplicateFile: true, alreadyStored: 0 })
    expect(next.identityWarnings?.filter(warning => warning.rowNumber === 2)).toHaveLength(1)
    expect(next.identityWarnings?.some(warning => warning.blocking)).toBe(true)
    expect(() => planLegacyImport(first, existing)).toThrow(/交易标识冲突/)
  })

  it('rolls back the entire import if a colliding ID appears after planning', async () => {
    const plan = planLegacyImport(await preview(), EMPTY_SNAPSHOT)
    await db.transactions.add({ ...plan.inserted[1]!, transactionAmountMinor: 1 })
    await expect(persistLegacyImport(plan)).rejects.toThrow()
    expect(await db.imports.count()).toBe(0)
    expect(await db.statements.count()).toBe(0)
    expect(await db.transactions.count()).toBe(1)
  })

  it('rejects a stale optimistic commit without modifying the ledger', async () => {
    const plan = planLegacyImport(await preview(), EMPTY_SNAPSHOT)
    const { revision } = await readImportSnapshot()
    await persistLegacyImport(plan, revision)
    await expect(persistLegacyImport({ ...plan, inserted: [] }, revision)).rejects.toThrow()
    expect(await db.transactions.count()).toBe(2)
  })

  it('recovers 488 of 18,286 synthetic rows from the same partially imported file, then inserts zero', async () => {
    const count = 18_286
    const alreadyStored = 17_798
    const rows = Array.from({ length: count }, (_, index) => {
      const row = index < alreadyStored ? nativeCells() : nativeDisplayCells()
      row[17] = transactionId(String(row[18]), index + 1); row[19] = String(index + 1)
      return row
    })
    const memoryBefore = process.memoryUsage().rss
    const started = performance.now()
    const buffer = nativeWorkbook(rows)
    const fileMeta = { ...meta, fileSize: buffer.byteLength, fileHash: await sha256Hex(buffer) }
    const result = await previewLegacyWorkbook(buffer, fileMeta, EMPTY_SNAPSHOT)
    const original = { ...result, rows: result.rows.slice(0, alreadyStored),
      stats: { ...result.stats, validRows: alreadyStored, anomalyRows: count - alreadyStored } }
    await persistLegacyImport(planLegacyImport(original, EMPTY_SNAPSHOT))
    expect(await db.transactions.count()).toBe(alreadyStored)
    const partial = await readSnapshot()
    const fixed = await previewLegacyWorkbook(buffer, fileMeta, partial)
    expect(fixed.stats).toMatchObject({ duplicateFile: true, alreadyStored })
    const plan = planLegacyImport(fixed, partial)
    expect(result.stats).toMatchObject({ totalRows: count, validRows: count, anomalyRows: 0 })
    expect(new Set(plan.inserted.map(row => row.id)).size).toBe(488)
    expect(plan.skipped).toBe(alreadyStored)
    expect(plan.inserted[487]!.occurrence).toBe(count)
    await persistLegacyImport(plan)
    expect(await db.transactions.count()).toBe(count)
    const existing = await readSnapshot()
    const byId = new Map(existing.transactions.map(tx => [tx.id, tx]))
    expect(result.rows.filter(row => !byId.has(row.id))).toEqual([])
    for (const tx of partial.transactions) expect(byId.get(tx.id)).toEqual(tx)
    expect(planLegacyImport(result, existing).inserted).toEqual([])
    const seconds = (performance.now() - started) / 1000
    const retainedGrowth = Math.max(0, process.memoryUsage().rss - memoryBefore)
    console.info(`synthetic native XLSX: ${count} valid, ${alreadyStored} stored, 488 recovered, 0 missing, 0 on repeat; ${seconds.toFixed(2)}s, RSS delta ${(retainedGrowth / 1024 / 1024).toFixed(1)} MiB, process peak RSS ${(process.resourceUsage().maxRSS / 1024).toFixed(1)} MiB`)
    expect(seconds).toBeLessThan(45)
    expect(retainedGrowth).toBeLessThan(1024 * 1024 * 1024)
  }, 60_000)
})

