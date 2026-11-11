import * as XLSX from 'xlsx'
import { LEGACY_UNIFIED_COLUMNS } from '../src/importers/legacyPythonExportV1'
import { beforeEach, describe, expect, it } from 'vitest'
import { EXPORT_COLUMNS, transactionToRow } from '../src/export/tabular'
import { transactionDisplayDescription } from '../src/core/descriptionNormalizer'
import { BANKS, TRANSACTION_TYPES } from '../src/core/types'
import { transactionId } from '../src/core/dedupe'
import { db } from '../src/db/db'
import { persistLegacyImport, readImportSnapshot, readSnapshot } from '../src/db/repository'
import { planLegacyImport, previewLegacyWorkbook } from '../src/importers/legacyImport'
import { detectNativeLedgerShape } from '../src/importers/legacyKeeprawLedgerExportV1'
import { LEGACY_KEEPRAW_LEDGER_EXPORT_V1 } from '../src/importers/types'
import { EMPTY_SNAPSHOT } from './fixtures/identity'
import { NATIVE_HEADERS, nativeCells, nativeTransaction, nativeWorkbook } from './fixtures/nativeLedger'

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

  it('validates and persists 18,286 synthetic rows without collapsing repeats', async () => {
    const count = 18_286
    const rows = Array.from({ length: count }, (_, index) => {
      const row = nativeCells()
      row[17] = transactionId(String(row[18]), index + 1); row[19] = String(index + 1)
      return row
    })
    const memoryBefore = process.memoryUsage().rss
    const started = performance.now()
    const result = await preview(rows)
    const plan = planLegacyImport(result, EMPTY_SNAPSHOT)
    expect(result.stats).toMatchObject({ totalRows: count, validRows: count, anomalyRows: 0 })
    expect(new Set(plan.inserted.map(row => row.id)).size).toBe(count)
    expect(plan.inserted[count - 1]!.occurrence).toBe(count)
    await persistLegacyImport(plan)
    expect(await db.transactions.count()).toBe(count)
    const existing = await readSnapshot()
    expect(planLegacyImport(result, existing).inserted).toEqual([])
    const seconds = (performance.now() - started) / 1000
    const retainedGrowth = Math.max(0, process.memoryUsage().rss - memoryBefore)
    console.info(`native XLSX: ${count} rows, parse/plan/persist/replan ${seconds.toFixed(2)}s, RSS delta ${(retainedGrowth / 1024 / 1024).toFixed(1)} MiB, process peak RSS ${(process.resourceUsage().maxRSS / 1024).toFixed(1)} MiB`)
    expect(seconds).toBeLessThan(45)
    expect(retainedGrowth).toBeLessThan(1024 * 1024 * 1024)
  }, 60_000)
})

