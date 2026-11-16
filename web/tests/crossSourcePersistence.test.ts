import { beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { db } from '../src/db/db'
import { exportDataBackup, importBackup, persistImportResults, persistLegacyImport, readSnapshot, setReviewNote, validateBackup } from '../src/db/repository'
import { ingestParsedStatement } from '../src/core/ingest'
import { legacyTypeForIdentity } from '../src/core/classify'
import { auditMigrationRows } from '../src/core/migrationAudit'
import type { ParsedTransaction } from '../src/parsers/types'
import { LEGACY_UNIFIED_COLUMNS } from '../src/importers/legacyPythonExportV1'
import { planLegacyImport, previewLegacyWorkbook } from '../src/importers/legacyImport'
import { syntheticStatement } from './fixtures/identity'
import { historyRow, workbookBytes } from './fixtures/legacyWorkbook'

beforeEach(async () => { await db.delete(); await db.open() })

function workbook(description: string, count = 1) {
  return workbookBytes('标准字段', LEGACY_UNIFIED_COLUMNS, Array.from({ length: count }, () => historyRow({ description })))
}
async function storeLegacy(buffer: ArrayBuffer, fileHash = 'legacy') {
  const existing = await readSnapshot()
  const preview = await previewLegacyWorkbook(buffer, { fileName: 'synthetic.xlsx', fileSize: buffer.byteLength, fileHash }, existing)
  const plan = planLegacyImport(preview, existing)
  await persistLegacyImport(plan)
  return { preview, inserted: plan.inserted }
}
async function storeNative(description: string, changes: Partial<ParsedTransaction> = {}, count = 1, hash = 'native') {
  const parsed = syntheticStatement(Array(count).fill(description))
  parsed.transactions = parsed.transactions.map((row) => ({ ...row, ...changes }))
  const result = ingestParsedStatement(parsed, { fileName: 'synthetic.txt', fileHash: hash, fileSize: 1, sourceType: 'text' }, await readSnapshot())
  await persistImportResults([result])
  return result
}
const VARIANTS: Array<[string, string, Partial<ParsedTransaction>]> = [
  ['installment classification', '1/3期-商户分期-合成通讯', { type: legacyTypeForIdentity('分期扣款', 'debit') }],
  ['posting date', '消费 合成商户', { postingDate: '2024-01-07' }],
  ['description normalization', '消费 商户(历史)', { description: '消费 商户(银行)', rawDescription: '消费 商户(银行)' }],
  ['original currency', '消费 合成商户', { transactionCurrency: 'USD', transactionAmountMinor: 1800 }],
  ['original amount', '消费 合成商户', { transactionAmountMinor: 12881 }],
]

describe('real import plans and IndexedDB cross-source integrity', () => {
  for (const order of ['legacy-first', 'native-first'] as const) {
    it.each(VARIANTS)(`${order}: preserves and reviews %s disagreements without touching user edits`, async (_name, description, changes) => {
      const buffer = workbook(description)
      if (order === 'legacy-first') await storeLegacy(buffer)
      else await storeNative(description, changes)
      const first = (await db.transactions.toArray())[0]!
      const edited = { ...first, category: '旅行' as const, reviewStatus: 'confirmed' as const, flags: [] }
      await db.transactions.put(edited)
      await setReviewNote(edited.id, 'Synthetic review note')
      const next = order === 'legacy-first' ? await storeNative(description, changes) : await storeLegacy(buffer)
      expect(next.inserted).toHaveLength(1)
      expect(next.inserted[0]!.flags).toContain('suspected_duplicate')
      expect(next.inserted[0]!.reviewStatus).toBe('pending')
      expect(await db.transactions.count()).toBe(2)
      expect(await db.transactions.get(edited.id)).toEqual(edited)
      expect((await db.reviewNotes.get(edited.id))!.note).toBe('Synthetic review note')
      await storeLegacy(buffer)
      await storeNative(description, changes)
      expect(await db.transactions.count()).toBe(2)
      expect(await db.transactions.get(edited.id)).toEqual(edited)
    })
  }
  it.each(['legacy-first', 'native-first'])('%s: preserves cashback vs payment and negative money', async (order) => {
    const description = '美食天天乐-合成商户'
    const buffer = workbookBytes('标准字段', LEGACY_UNIFIED_COLUMNS, [historyRow({ description, transaction_amount: -10, settlement_amount: -10 })])
    const changes: Partial<ParsedTransaction> = { type: legacyTypeForIdentity('刷卡金', 'credit'), direction: 'credit', transactionAmountMinor: -1000, settlementAmountMinor: -1000 }
    if (order === 'legacy-first') { await storeLegacy(buffer); await storeNative(description, changes) }
    else { await storeNative(description, changes); await storeLegacy(buffer) }
    const rows = await db.transactions.toArray()
    expect(rows).toHaveLength(2)
    expect(rows.every((row) => row.direction === 'credit' && row.settlementAmountMinor === -1000)).toBe(true)
    expect(new Set(rows.map((row) => row.type))).toEqual(new Set(['payment', 'cashback']))
    expect(rows.some((row) => row.flags.includes('suspected_duplicate'))).toBe(true)
  })
  it.each(['legacy-first', 'native-first'])('%s: preserves maximum identical purchase multiplicity across overlapping files', async (order) => {
    const description = '消费 合成重复商户'
    if (order === 'legacy-first') { await storeLegacy(workbook(description, 2)); await storeNative(description, {}, 3) }
    else { await storeNative(description, {}, 3); await storeLegacy(workbook(description, 2)) }
    const rows = await db.transactions.toArray()
    expect(rows).toHaveLength(3)
    expect(new Set(rows.map((row) => row.id)).size).toBe(3)
    expect(rows.map((row) => row.occurrence).sort()).toEqual([1, 2, 3])
    await storeLegacy(workbook(description, 3), 'legacy-overlap')
    await storeNative(description, {}, 2, 'native-overlap')
    expect(await db.transactions.count()).toBe(3)
  })
  it('keeps two legitimate repeated occurrences on each side of ambiguous classification', async () => {
    const description = '1/3期-商户分期-合成通讯'
    await storeLegacy(workbook(description, 2))
    await storeNative(description, { type: 'installment_payment' }, 2)
    expect(await db.transactions.count()).toBe(4)
    await storeNative(description, { type: 'installment_payment' }, 2, 'native-overlap')
    expect(await db.transactions.count()).toBe(4)
  })
  it('audits incompatible native IDs and occurrences without mutating the snapshot', async () => {
    await storeNative('消费 合成商户')
    const snapshot = await readSnapshot()
    const before = structuredClone(snapshot)
    const existing = snapshot.transactions[0]!
    const rows = [1, 2, 3].map((index) => ({ ...existing, id: `python-id-${index}` }))
    const audit = auditMigrationRows(rows, snapshot.transactions)
    expect(audit.exactCandidates).toBe(1)
    expect(audit.unmatched).toBe(2)
    expect(audit.merged).toBe(false)
    expect(snapshot).toEqual(before)
    expect(await readSnapshot()).toEqual(before)
    expect(auditMigrationRows([{ ...existing, description: '另一家合成商户' }], snapshot.transactions).reviewCandidates).toBe(1)
  })
  it('round-trips new historical provenance through version-2 JSON with exact note recovery', async () => {
    await storeLegacy(workbook('消费 合成商户', 2))
    await storeNative('消费 合成商户', { transactionCurrency: 'USD', transactionAmountMinor: 1800 })
    const original = await readSnapshot()
    await setReviewNote(original.transactions[0]!.id, 'Synthetic note included in v2')
    const backup = await exportDataBackup()
    if (backup.version !== 2) throw new Error('expected V2')
    expect(backup.reviewNotes).toHaveLength(1)
    expect(backup.reviewNotes[0]).toMatchObject({ transactionId: original.transactions[0]!.id, note: 'Synthetic note included in v2' })
    await db.delete(); await db.open()
    await importBackup(JSON.parse(JSON.stringify(backup)))
    expect(await db.transactions.toArray()).toEqual(original.transactions)
    expect(await db.reviewNotes.count()).toBe(1)
    expect((await db.reviewNotes.get(original.transactions[0]!.id))?.note).toBe('Synthetic note included in v2')
    await importBackup(backup)
    expect(await db.transactions.count()).toBe(3)
    // Historical V1 payloads carry no notes: fresh V1 restores invent none.
    const v1 = { ...JSON.parse(JSON.stringify(backup)), version: 1 } as Record<string, unknown>
    delete v1.reviewNotes
    expect(validateBackup(v1)).toBe(true)
    await db.delete(); await db.open()
    await importBackup(v1 as never)
    expect(await db.reviewNotes.count()).toBe(0)
  })
  it('runs the TypeScript audit CLI on synthetic XLSX/JSON without writing either source', async () => {
    await storeNative('消费 合成商户', { type: 'installment_payment' })
    const directory = mkdtempSync(join(tmpdir(), 'keepraw-audit-'))
    try {
      const xlsxPath = join(directory, 'synthetic.xlsx')
      const backupPath = join(directory, 'synthetic.json')
      writeFileSync(xlsxPath, new Uint8Array(workbook('消费 合成商户')))
      writeFileSync(backupPath, JSON.stringify(await exportDataBackup()))
      const before = [readFileSync(xlsxPath), readFileSync(backupPath)]
      const output = execFileSync(process.execPath, ['scripts/migration-audit.mjs', '--legacy', xlsxPath, '--backup', backupPath], { encoding: 'utf8' })
      const report = JSON.parse(output)
      expect(report.audit.reviewCandidates).toBe(1)
      expect(report.audit.merged).toBe(false)
      expect(output).not.toContain('合成商户')
      expect([readFileSync(xlsxPath), readFileSync(backupPath)]).toEqual(before)
    } finally { rmSync(directory, { recursive: true, force: true }) }
  }, 30_000)
})
