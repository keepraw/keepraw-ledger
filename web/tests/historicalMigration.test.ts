import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '../src/db/db'
import { exportDataBackup, importBackup, persistLegacyImport, readSnapshot, validateBackup } from '../src/db/repository'
import { buildDuplicateReviewDetails } from '../src/core/migrationAudit'
import { planLegacyImport, previewLegacyWorkbook } from '../src/importers/legacyImport'
import { sha256Hex } from '../src/parsers/extract'
import { EMPTY_SNAPSHOT } from './fixtures/identity'
import { MIGRATION_FORMATS, migrationFixture } from './fixtures/historicalMigration'

beforeEach(async () => { await db.delete(); await db.open() })

describe('TypeScript-only historical migration and recovery', () => {
  it.each(MIGRATION_FORMATS)('$sheet: still skips a previously imported file even if some transactions are missing', async format => {
    const { buffer } = migrationFixture(format)
    const meta = { fileName: 'synthetic-history.xlsx', fileSize: buffer.byteLength, fileHash: await sha256Hex(buffer) }
    const first = planLegacyImport(await previewLegacyWorkbook(buffer, meta, EMPTY_SNAPSHOT), EMPTY_SNAPSHOT)
    await persistLegacyImport(first)
    await db.transactions.delete(first.inserted[0]!.id)
    const before = await readSnapshot()
    const preview = await previewLegacyWorkbook(buffer, meta, before)
    expect(preview.stats).toMatchObject({ duplicateFile: true, alreadyStored: 72 })
    const repeated = planLegacyImport(preview, before)
    expect(repeated.inserted).toEqual([])
    expect(repeated.statements).toEqual([])
    expect(repeated.skipped).toBe(72)
    expect(repeated.record).toMatchObject({ status: 'duplicate', duplicateOf: first.record.id })
    await persistLegacyImport(repeated)
    expect((await readSnapshot()).transactions).toEqual(before.transactions)
    expect((await readSnapshot()).statements).toEqual(before.statements)
  })

  it.each(MIGRATION_FORMATS)('$sheet: migrates all six banks and restores identity, money and duplicate relationships', async (format) => {
    const { buffer, expected } = migrationFixture(format)
    const meta = { fileName: 'synthetic-history.xlsx', fileSize: buffer.byteLength, fileHash: await sha256Hex(buffer) }
    const preview = await previewLegacyWorkbook(buffer, meta, EMPTY_SNAPSHOT)
    expect(preview.stats).toMatchObject({ totalRows: 72, validRows: 72, anomalyRows: 0,
      banks: ['abc', 'boc', 'bocom', 'ccb', 'citic', 'icbc'] })
    expect(preview.anomalies).toEqual([])
    for (const [index, row] of expected.entries()) {
      expect(preview.rows[index]).toMatchObject({ bank: row.bank, cardLast4: row.cardLast4,
        transactionDate: row.transactionDate, postingDate: row.postingDate, description: row.description,
        type: row.type, direction: row.direction, transactionCurrency: row.transactionCurrency,
        transactionAmountMinor: row.transactionAmountMinor, settlementCurrency: row.settlementCurrency,
        settlementAmountMinor: row.settlementAmountMinor, sourceRow: index + 2 })
    }
    const first = planLegacyImport(preview, EMPTY_SNAPSHOT)
    expect(first.inserted).toHaveLength(72)
    expect(first.skipped).toBe(0)
    expect(first.statements).toHaveLength(6)
    expect(first.statements.every((row) => row.status === 'imported' && row.reconciliation.status === 'insufficient')).toBe(true)
    await persistLegacyImport(first)
    const before = await readSnapshot()
    expect(new Set(before.transactions.map((row) => row.id)).size).toBe(72)
    for (const bank of preview.stats.banks) {
      const repeats = before.transactions.filter((row) => row.bank === bank && row.description === `消费 合成商户 ${bank.toUpperCase()}`)
      expect(repeats).toHaveLength(2)
      expect(repeats[0]!.fingerprint).toBe(repeats[1]!.fingerprint)
      expect(new Set(repeats.map((row) => row.occurrence))).toEqual(new Set([1, 2]))
      expect(repeats[0]!.id).not.toBe(repeats[1]!.id)
    }
    const suspects = before.transactions.filter((row) => row.flags.includes('suspected_duplicate'))
    expect(suspects.length).toBeGreaterThanOrEqual(6)
    const relationships = buildDuplicateReviewDetails(before.transactions, suspects)
    expect([...relationships.values()].every((row) => row.candidateCount > 0 && row.candidateIds.length > 0)).toBe(true)

    // Exercise real duplicate import metadata before the JSON round trip.
    const repeated = planLegacyImport(await previewLegacyWorkbook(buffer, meta, before), before)
    expect(repeated.record.status).toBe('duplicate')
    expect(repeated.record.duplicateOf).toBe(first.record.id)
    expect(repeated.inserted).toEqual([])
    await persistLegacyImport(repeated)
    const backup = JSON.parse(JSON.stringify(await exportDataBackup()))
    expect(backup.format).toBe('credit-card-data-backup')
    expect(backup.version).toBe(2)
    expect(validateBackup(backup)).toBe(true)

    await db.delete()
    await db.open()
    expect(await db.transactions.count()).toBe(0)
    await importBackup(backup)
    const restored = await readSnapshot()
    expect(restored.transactions).toEqual(before.transactions)
    expect(restored.imports).toEqual(backup.imports)
    expect(restored.statements).toHaveLength(6)
    expect(restored.statements.every((row) => row.transactionCount === 12)).toBe(true)
    expect(buildDuplicateReviewDetails(restored.transactions, suspects)).toEqual(relationships)

    await importBackup(backup)
    expect((await readSnapshot()).transactions).toEqual(before.transactions)
    const reimport = planLegacyImport(await previewLegacyWorkbook(buffer, meta, restored), restored)
    expect(reimport.inserted).toEqual([])
    expect(reimport.skipped).toBe(72)
    // A renamed/repacked workbook must also match existing occurrences after recovery.
    const other = { ...meta, fileName: 'synthetic-overlap.xlsx', fileHash: 'synthetic-different-file' }
    const overlap = planLegacyImport(await previewLegacyWorkbook(buffer, other, restored), restored)
    expect(overlap.inserted).toEqual([])
    expect(overlap.skipped).toBe(72)
    await persistLegacyImport(overlap)
    expect((await readSnapshot()).transactions).toEqual(before.transactions)
  })
})
