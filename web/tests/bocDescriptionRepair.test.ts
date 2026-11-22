import { beforeEach, expect, it, vi } from 'vitest'
import { db } from '../src/db/db'
import { repairBocDescriptions } from '../src/db/bocDescriptionRepair'
import { bumpLedgerRevision, readLedgerRevision } from '../src/db/ledgerRevision'
import { exportDataBackup, importBackup, persistImportResults, readSnapshot, saveOriginalFile, setReviewNote } from '../src/db/repository'
import { bocParser } from '../src/parsers/boc'
import { buildSourceDocument, pdfToText, sha256Hex } from '../src/parsers/extract'
import { ingestParsedStatement } from '../src/core/ingest'
import { transactionFingerprint } from '../src/core/identity'
import { transactionId } from '../src/core/dedupe'
import { buildSyntheticBocPdf } from './fixtures/bocPdf'
import type { SourceDocument } from '../src/parsers/types'
import type { Transaction } from '../src/core/types'
import * as XLSX from 'xlsx'
import { LEDGER_EXPORT_COLUMNS, ledgerTransactionToRow } from '../src/export/tabular'
import { previewLegacyWorkbook } from '../src/importers/legacyImport'

vi.mock('../src/parsers/extract', async importOriginal => ({
  ...await importOriginal<typeof import('../src/parsers/extract')>(), buildSourceDocument: vi.fn(),
}))

const repairedDescription = '支付宝-阿里健康大药房医药连锁有限公司'
const wrongDescription = '药连锁有限公司支付宝-阿里健康大药房医'
const ambiguousFixtureRows = 2
const bytes = new Uint8Array([1, 2, 3]).buffer
function document(): SourceDocument {
  const pdf = buildSyntheticBocPdf('top-down')
  pdf.pages[1]!.items = pdf.pages[1]!.items.map(item => ({ ...item,
    text: item.text === '示例超市-西门店' ? '支付宝-阿里健康大药房医'
      : item.text === '（测试）' ? '药连锁有限公司' : item.text,
  }))
  return { fileName: 'synthetic-boc.pdf', fileSize: bytes.byteLength, fileHash: '', sourceType: 'pdf',
    pdf, text: pdfToText(pdf), html: null, tables: [], email: null }
}

beforeEach(async () => {
  vi.restoreAllMocks(); vi.clearAllMocks()
  vi.mocked(buildSourceDocument).mockImplementation(async () => document())
  await db.delete(); await db.open()
})

async function seed(category: Transaction['category'] = '未分类') {
  const parsed = bocParser.parse(document())
  const fileHash = await sha256Hex(bytes)
  const result = ingestParsedStatement(parsed, { fileName: 'synthetic-boc.pdf', fileHash, fileSize: bytes.byteLength, sourceType: 'pdf' },
    { statements: [], transactions: [], imports: [] })
  result.transactions = result.transactions.map(row => {
    const pageRows = parsed.transactions.filter(other => other.sourcePage === row.sourcePage)
    const old = { ...row, sourceRow: pageRows.length - 1 - row.sourceRow }
    if (row.description === repairedDescription) {
      old.description = wrongDescription; old.rawDescription = wrongDescription
      old.category = category; old.reviewStatus = 'confirmed'
      old.fingerprint = transactionFingerprint(old)
      old.id = transactionId(old.fingerprint, old.occurrence)
    }
    return old
  })
  result.inserted = result.transactions
  await persistImportResults([result])
  await saveOriginalFile({ data: bytes, fileHash, fileName: 'synthetic-boc.pdf', importId: result.record.id, parserId: parsed.parserId })
  const target = result.transactions.find(row => row.description === wrongDescription)!
  expect(target).toBeDefined()
  await setReviewNote(target.id, 'synthetic user note')
  return { target, result, parsed, fileHash }
}

it.each<Transaction['category']>(['未分类', '旅行'])('repairs only descriptions/fingerprint and preserves inert historical category (%s), preserves IDs/notes/review and is idempotent', async category => {
  const { target, fileHash } = await seed(category)
  const before = await exportDataBackup()
  const revision = await readLedgerRevision()
  expect(await repairBocDescriptions()).toEqual({ updated: 1, skipped: ambiguousFixtureRows, missingFiles: 0, failedFiles: 0 })
  expect(buildSourceDocument).toHaveBeenCalledWith({ fileName: 'synthetic-boc.pdf', fileHash, buffer: bytes })
  const repaired = await db.transactions.get(target.id)
  expect(repaired).toEqual({ ...target, description: repairedDescription, rawDescription: repairedDescription,
    fingerprint: transactionFingerprint({ ...target, description: repairedDescription }), category })
  const after = await exportDataBackup()
  if (before.version !== 2 || after.version !== 2) throw new Error('expected v2 backup')
  expect(after.reviewNotes).toEqual(before.reviewNotes)
  expect(after.imports).toEqual(before.imports)
  expect(after.statements).toEqual(before.statements)
  expect(after.transactions.filter(row => row.id !== target.id)).toEqual(before.transactions.filter(row => row.id !== target.id))
  expect((await readLedgerRevision()).version).toBe(revision.version + 1)
  const committed = await readLedgerRevision()
  expect(await repairBocDescriptions()).toEqual({ updated: 0, skipped: ambiguousFixtureRows, missingFiles: 0, failedFiles: 0 })
  expect(await readLedgerRevision()).toEqual(committed)
  await importBackup(after)
  expect(await db.transactions.get(target.id)).toEqual(repaired)
  const restored = await exportDataBackup()
  if (restored.version !== 2) throw new Error('expected v2 backup')
  expect(restored.reviewNotes).toEqual(before.reviewNotes)
})

it('keeps same-file SHA skipping and exact cross-file deduplication working with stable IDs and refreshed fingerprints', async () => {
  const { parsed, fileHash, target } = await seed()
  await repairBocDescriptions()
  const snapshot = await readSnapshot()
  const sameFile = ingestParsedStatement(parsed, { fileName: 'same.pdf', fileHash, fileSize: 3, sourceType: 'pdf' }, snapshot)
  expect(sameFile.record.status).toBe('duplicate')
  expect(sameFile.inserted).toHaveLength(0)
  const otherFile = ingestParsedStatement(parsed, { fileName: 'another.pdf', fileHash: 'another-hash', fileSize: 3, sourceType: 'pdf' }, snapshot)
  expect(otherFile.inserted).toHaveLength(0)
  expect(otherFile.transactions.some(row => row.id === target.id)).toBe(true)
})

it('recovers repaired descriptions and stable IDs from exported native XLSX', async () => {
  const { target } = await seed()
  await repairBocDescriptions()
  const repaired = (await db.transactions.get(target.id))!
  const book = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([LEDGER_EXPORT_COLUMNS.map(column => column.header), ledgerTransactionToRow(repaired)]), '交易明细')
  const preview = await previewLegacyWorkbook(XLSX.write(book, { type: 'array', bookType: 'xlsx' }),
    { fileName: 'synthetic-repaired.xlsx', fileHash: 'synthetic-repaired', fileSize: 1 }, { transactions: [], statements: [], imports: [] })
  expect(preview.anomalies).toEqual([])
  expect(preview.rows).toHaveLength(1)
  expect(preview.rows[0]).toMatchObject({ id: target.id, fingerprint: repaired.fingerprint, description: repairedDescription })
})

it('skips ambiguous stored and parsed matches instead of trusting potentially reversed row indexes', async () => {
  const { target } = await seed()
  await db.transactions.put({ ...target, id: 'ambiguous-stored', sourceRow: target.sourceRow + 1 })
  expect(await repairBocDescriptions()).toMatchObject({ updated: 0, skipped: ambiguousFixtureRows + 2 })
  expect((await db.transactions.get(target.id))!.description).toBe(wrongDescription)
  await db.transactions.delete('ambiguous-stored')
  const parsed = bocParser.parse(document())
  const candidate = parsed.transactions.find(row => row.description === repairedDescription)!
  vi.spyOn(bocParser, 'parse').mockReturnValue({ ...parsed, transactions: [...parsed.transactions, { ...candidate, sourceRow: candidate.sourceRow + 1 }] })
  const result = await repairBocDescriptions()
  expect(result.updated).toBe(0)
  expect(result.skipped).toBeGreaterThanOrEqual(ambiguousFixtureRows + 1)
  expect((await db.transactions.get(target.id))!.description).toBe(wrongDescription)
})

it.each<Partial<Transaction>>([
  { transactionDate: '2000-01-01' }, { postingDate: '2000-01-01' }, { transactionDate: null },
  { cardLast4: '9999' }, { transactionAmountMinor: 999 }, { settlementAmountMinor: 999 },
  { transactionCurrency: 'USD' }, { settlementCurrency: 'USD' }, { sourcePage: 999 }, { sourceRow: 999 },
])('skips a row whose strict match fields changed: %j', async patch => {
  const { target } = await seed()
  await db.transactions.update(target.id, patch)
  expect(await repairBocDescriptions()).toMatchObject({ updated: 0, skipped: ambiguousFixtureRows + 1 })
  expect((await db.transactions.get(target.id))!.description).toBe(wrongDescription)
})

it('reports missing files and extraction failures without modifying any transaction', async () => {
  const { result, fileHash } = await seed()
  const before = await db.transactions.toArray()
  vi.mocked(buildSourceDocument).mockRejectedValueOnce(new Error('synthetic extraction failure'))
  expect(await repairBocDescriptions()).toEqual({ updated: 0, skipped: result.transactions.length, missingFiles: 0, failedFiles: 1 })
  await db.attachments.delete(fileHash)
  expect(await repairBocDescriptions()).toEqual({ updated: 0, skipped: result.transactions.length, missingFiles: 1, failedFiles: 0 })
  expect(await db.transactions.toArray()).toEqual(before)
})

it('repairs external-designated files when the local bytes remain, and deduplicates import references', async () => {
  const { result, fileHash } = await seed()
  await db.settings.put({ key: `archive:external:${fileHash}`, value: true })
  await db.imports.put({ ...result.record, id: 'synthetic-duplicate', status: 'duplicate' })
  expect(await repairBocDescriptions()).toMatchObject({ updated: 1, skipped: ambiguousFixtureRows })
  expect(buildSourceDocument).toHaveBeenCalledTimes(1)
})

it('rejects substituted bytes or a different statement identity without modifying rows', async () => {
  const { result, fileHash } = await seed()
  const before = await db.transactions.toArray()
  await db.attachments.update(fileHash, { data: new Uint8Array([4]).buffer })
  expect(await repairBocDescriptions()).toMatchObject({ updated: 0, failedFiles: 1, skipped: result.transactions.length })
  expect(buildSourceDocument).not.toHaveBeenCalled()
  await db.attachments.update(fileHash, { data: bytes })
  await db.statements.update(result.statement!.id, { cardLast4: '9999' })
  expect(await repairBocDescriptions()).toMatchObject({ updated: 0, failedFiles: 1, skipped: result.transactions.length })
  expect(await db.transactions.toArray()).toEqual(before)
})

it('rejects concurrent ledger changes and rolls back financial writes if the revision update fails', async () => {
  await seed()
  const before = await db.transactions.toArray()
  vi.mocked(buildSourceDocument).mockImplementationOnce(async () => {
    await db.transaction('rw', db.settings, () => bumpLedgerRevision())
    return document()
  })
  await expect(repairBocDescriptions()).rejects.toThrow(/其他标签页/)
  expect(await db.transactions.toArray()).toEqual(before)
  const revision = await readLedgerRevision()
  vi.spyOn(db.settings, 'put').mockRejectedValueOnce(new Error('synthetic quota'))
  await expect(repairBocDescriptions()).rejects.toThrow('synthetic quota')
  expect(await db.transactions.toArray()).toEqual(before)
  expect(await readLedgerRevision()).toEqual(revision)
})

it('handles an empty ledger and rejects demo mode before extracting files', async () => {
  expect(await repairBocDescriptions()).toEqual({ updated: 0, skipped: 0, missingFiles: 0, failedFiles: 0 })
  await seed()
  await db.settings.put({ key: 'app', value: { demoMode: true } })
  await expect(repairBocDescriptions()).rejects.toThrow(/关闭演示模式/)
  expect(buildSourceDocument).not.toHaveBeenCalled()
})
