import { beforeEach, describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { db } from '../src/db/db'
import { importBackup, exportDataBackup, patchTransaction, persistImportResults, readSnapshot, reviewTransactions, type BackupPayload } from '../src/db/repository'
import { buildFullBackupZip, restoreFullBackupZip, DATABASE_JSON } from '../src/backup/archive'
import { readArchiveBytes } from '../src/backup/zipSafety'
import { applyReviewPatch, effectiveAmountForDirection, effectiveDirection, hasUnresolvedDirection } from '../src/core/direction'
import { summarize, monthlyTrend, groupByBank, groupBy, untrustedAmount } from '../src/core/analytics'
import { reconcileStatement } from '../src/core/reconcile'
import { reconcileStatementTransactions } from '../src/core/reconciliation'
import { ingestParsedStatement } from '../src/core/ingest'
import { TRANSACTION_TYPES, type Direction, type Transaction } from '../src/core/types'
import { buildSourceDocument } from '../src/parsers/extract'
import { abcParser } from '../src/parsers/abc'
import { icbcParser } from '../src/parsers/icbc'
import { SYNTHETIC_ABC_HTML } from './fixtures/abcEml'
import { SYNTHETIC_ICBC_HTML } from './fixtures/icbcEml'
import { EMPTY_SNAPSHOT, ingestSynthetic } from './fixtures/identity'
import { nativeTransaction, nativeWorkbook } from './fixtures/nativeLedger'
import { EXPORT_COLUMNS, transactionToRow } from '../src/export/tabular'
import { planLegacyImport, previewLegacyWorkbook } from '../src/importers/legacyImport'

beforeEach(async () => { await db.delete(); await db.open() })
async function document(html: string) {
  return buildSourceDocument({ fileName: 'synthetic.html', fileHash: 'synthetic-direction', buffer: new TextEncoder().encode(html).buffer })
}
async function abc(original: string, settlement: string, credit = false, sections = true) {
  const doc = await document(SYNTHETIC_ABC_HTML)
  const description = credit ? '还款 卡卡转账' : '网上消费 示例餐厅'
  for (const table of doc.tables) {
    if (!sections) table.rows = table.rows.filter(row => !row.includes('●'))
    for (const row of table.rows) if (row.includes(description)) { row[4] = original; row[5] = settlement }
  }
  const parsed = abcParser.parse(doc)
  const result = ingestParsedStatement(parsed, { fileName: doc.fileName, fileHash: 'synthetic-direction', fileSize: 1, sourceType: 'html' }, EMPTY_SNAPSHOT)
  return { result, parsed, target: result.transactions.find(tx => tx.rawDescription === description)! }
}
async function nativeRestore(rows: Transaction[]) {
  const buffer = nativeWorkbook(rows.map(transactionToRow), EXPORT_COLUMNS.map(c => c.header))
  const meta = { fileName: 'synthetic.xlsx', fileHash: 'synthetic-native', fileSize: buffer.byteLength }
  const preview = await previewLegacyWorkbook(buffer, meta, EMPTY_SNAPSHOT)
  expect(preview.anomalies).toEqual([])
  return { buffer, meta, rows: planLegacyImport(preview, EMPTY_SNAPSHOT).inserted }
}

const ABC_CASES = [
  ['debit original negative / settlement positive', '-68.00/CNY', '68.00/CNY', false, true, true, 'debit', -6800, 6800],
  ['debit original negative / normal bank settlement', '-68.00/CNY', '-68.00/CNY', false, true, true, 'debit', -6800, -6800],
  ['debit original positive / negative settlement is the normal 支出为- convention', '68.00/CNY', '-68.00/CNY', false, true, false, 'debit', 6800, 6800],
  ['debit settlement positive conflict', '68.00/CNY', '68.00/CNY', false, true, true, 'debit', 6800, 6800],
  ['credit conflicting signs', '3000.00/CNY', '-3000.00/CNY', true, true, true, 'credit', 300000, -300000],
  ['no section: negative settlement explicitly means debit', '68.00/CNY', '-68.00/CNY', false, false, false, 'debit', 6800, 6800],
  ['no section: positive settlement explicitly means credit, regardless of merchant', '68.00/CNY', '68.00/CNY', false, false, false, 'credit', -6800, -6800],
] as const

describe('ABC both raw monetary legs', () => {
  it.each(ABC_CASES)('%s', async (_name, original, settlement, credit, sections, conflict, direction, txn, settle) => {
    const { target, parsed, result } = await abc(original, settlement, credit, sections)
    expect(parsed.transactions.find(tx => tx.rawDescription === target.rawDescription)).toMatchObject({ amountDirectionUnclear: conflict })
    expect(target).toMatchObject({ direction, transactionAmountMinor: txn, settlementAmountMinor: settle, directionEvidence: { kind: 'bank' } })
    expect(target.flags.includes('amount_direction_unclear')).toBe(conflict)
    expect(target.rawText).toContain(original); expect(target.rawText).toContain(settlement)
    await persistImportResults([result])
    expect(await db.transactions.get(target.id)).toMatchObject(target)
    const recovered = (await nativeRestore(result.transactions)).rows.find(tx => tx.id === target.id)!
    expect(recovered).toMatchObject({ id: target.id, fingerprint: target.fingerprint, occurrence: target.occurrence,
      transactionAmountMinor: txn, settlementAmountMinor: settle, directionEvidence: target.directionEvidence,
      rawText: target.rawText, flags: target.flags, reviewStatus: target.reviewStatus })
    expect(summarize([target]).transactionCount).toBe(conflict ? 0 : 1)
    if (sections) expect(result.transactions.filter(tx => tx.id !== target.id).every(tx => !tx.flags.includes('amount_direction_unclear'))).toBe(true)
  })
  it.each([['-68.005/CNY', '-68.00/CNY'], ['68.00/XXX', '-68.00/CNY'], ['68.00/CNY', '-68.001/CNY'], ['bad/CNY', '-68.00/CNY']])('rejects unsafe amount/currency %s %s', async (original, settlement) => {
    await expect(abc(original!, settlement!)).rejects.toThrow(/金额/)
    expect(await db.transactions.count()).toBe(0)
  })
})

function issue(direction: Direction, kind: 'bank' | 'missing' = 'bank') {
  return nativeTransaction(1, { transactionCurrency: 'CNY', settlementCurrency: 'CNY', transactionAmountMinor: -100,
    settlementAmountMinor: 150, direction, flags: ['amount_direction_unclear'], reviewStatus: 'pending',
    postingExclusion: null, directionEvidence: { kind, detail: kind === 'bank' ? '合成银行分区' : '缺少有效标记' } })
}
function resolved(row: Transaction, direction: Direction) {
  return applyReviewPatch(row, { directionResolution: { method: row.directionEvidence?.kind === 'bank' ? 'accept_bank' : 'user_choice', direction } })
}
function statement(row: Transaction) {
  const debit = effectiveDirection(row) === 'debit' ? 150 : 0, credit = debit ? 0 : 150
  return { ...ingestSynthetic([]).statement!, id: row.statementId, summary: { ...ingestSynthetic([]).statement!.summary,
    previousBalanceMinor: 0, currentBalanceMinor: debit - credit, newDebitMinor: debit, newCreditMinor: credit } }
}

for (const kind of ['bank', 'missing'] as const) for (const direction of ['debit', 'credit'] as const) {
  it(`${kind} direction resolved as ${direction}: every financial consumer agrees, identity/raw signs stay intact, no double count`, async () => {
    const row = issue(kind === 'missing' ? 'debit' : direction, kind), original = structuredClone(row)
    expect(summarize([row]).transactionCount).toBe(0)
    expect(effectiveAmountForDirection(row)).toBeNull()
    expect(() => applyReviewPatch(row, { reviewStatus: 'confirmed', flags: [] })).toThrow(/方向/)
    // A status imported from an older version is never an explicit direction decision.
    expect(summarize([{ ...row, reviewStatus: 'confirmed' }]).transactionCount).toBe(0)
    const next = resolved(row, direction), sign = direction === 'debit' ? 1 : -1
    expect(row).toEqual(original)
    expect(effectiveAmountForDirection(next)).toBe(150 * sign)
    expect(effectiveAmountForDirection(next, 'transaction')).toBe(100 * sign)
    expect(next).toMatchObject({ id: row.id, fingerprint: row.fingerprint, occurrence: row.occurrence,
      transactionAmountMinor: -100, settlementAmountMinor: 150, rawText: row.rawText, direction: row.direction, reviewStatus: 'confirmed', flags: [] })
    expect(hasUnresolvedDirection(next)).toBe(false)
    const expected = { billingDebitMinor: direction === 'debit' ? 150 : 0, billingCreditMinor: direction === 'credit' ? 150 : 0, netMinor: 150 * sign, transactionCount: 1 }
    for (const type of TRANSACTION_TYPES) {
      const tx = { ...next, type }, s = statement(tx)
      expect(summarize([tx])).toEqual(expected)
      expect(monthlyTrend([tx])).toEqual([{ month: '2024-01', debit: expected.billingDebitMinor, credit: expected.billingCreditMinor }])
      expect(groupByBank([tx])).toEqual(direction === 'debit' ? [{ label: 'boc', value: 150 }] : [])
      expect(groupBy([tx], () => '合成分类')).toEqual(direction === 'debit' ? [{ label: '合成分类', value: 150 }] : [])
      expect(untrustedAmount([tx], [{ ...s, status: 'needs_review' }])).toBe(150)
      expect(reconcileStatement({ summary: s.summary, transactions: [tx] }).status).toBe('passed')
      expect(reconcileStatementTransactions(s, [tx])).toMatchObject({ status: 'passed', transactionTotalMinor: 150 * sign, transactionCount: 1 })
    }
    await db.statements.add(statement(next)); await db.transactions.add(row)
    await expect(patchTransaction({ id: row.id, reviewStatus: 'confirmed', flags: [] })).rejects.toThrow(/方向/)
    await patchTransaction({ id: row.id, directionResolution: next.directionResolution })
    await patchTransaction({ id: row.id, directionResolution: next.directionResolution })
    expect(await db.transactions.count()).toBe(1)
    expect(summarize(await db.transactions.toArray())).toEqual(expected)
    expect((await db.statements.get(row.statementId))!.reconciliation.status).toBe('passed')
    const restored = await nativeRestore([next])
    expect(restored.rows[0]).toMatchObject({ id: next.id, fingerprint: next.fingerprint, occurrence: next.occurrence, direction: next.direction, directionResolution: next.directionResolution, directionEvidence: next.directionEvidence, transactionAmountMinor: -100, settlementAmountMinor: 150, rawText: next.rawText, flags: [], reviewStatus: 'confirmed' })
    expect(summarize(restored.rows)).toEqual(expected)
    const current = { ...EMPTY_SNAPSHOT, transactions: [next] }
    expect(planLegacyImport(await previewLegacyWorkbook(restored.buffer, restored.meta, current), current).inserted).toEqual([])
    const conflicting = { ...current, transactions: [row] }
    await expect(previewLegacyWorkbook(restored.buffer, restored.meta, conflicting)).resolves.toMatchObject({ identityWarnings: [expect.objectContaining({ blocking: true })] })
  })
}

it('ICBC missing positive marker stays unresolved after ordinary/bulk confirmation; explicit choice is required', async () => {
  const doc = await document(SYNTHETIC_ICBC_HTML)
  for (const table of doc.tables) for (const row of table.rows) if (row.includes('手机银行还款转入')) row[6] = '3000.00/RMB'
  const parsed = icbcParser.parse(doc)
  const result = ingestParsedStatement(parsed, { fileName: 'synthetic.html', fileHash: 'missing', fileSize: 1, sourceType: 'html' }, EMPTY_SNAPSHOT)
  const row = result.transactions.find(tx => tx.rawDescription === '手机银行还款转入')!
  expect(row.directionEvidence?.kind).toBe('missing')
  await persistImportResults([result])
  const before = await readSnapshot()
  await expect(reviewTransactions(result.transactions.map(tx => tx.id), 'confirmed')).rejects.toThrow(/方向/)
  expect(await readSnapshot()).toEqual(before)
  expect(() => applyReviewPatch(row, { directionResolution: { method: 'accept_bank', direction: 'debit' } })).toThrow(/方向/)
  expect(summarize([resolved(row, 'credit')]).billingCreditMinor).toBe(300000)
})
it('direction resolution removes only its own flag; ordinary review handles the remaining reasons separately', () => {
  const row = { ...issue('debit'), flags: ['amount_direction_unclear', 'suspected_duplicate', 'low_confidence'] as Transaction['flags'] }
  const next = resolved(row, 'debit')
  expect(next).toMatchObject({ reviewStatus: 'pending', flags: ['suspected_duplicate', 'low_confidence'] })
  expect(hasUnresolvedDirection(next)).toBe(false)
  expect(applyReviewPatch(next, { reviewStatus: 'confirmed', flags: [] })).toMatchObject({ flags: [], reviewStatus: 'confirmed', directionResolution: next.directionResolution })
})

for (const version of [1, 2] as const) for (const zip of [false, true]) {
  it(`${zip ? 'ZIP' : 'JSON'} V${version} keeps explicit decisions, raw signs, pending cases, idempotence and conflict rollback`, async () => {
    const source = ingestSynthetic(['合成备份方向'])
    await persistImportResults([source])
    const rows = [resolved(issue('debit'), 'debit'), { ...issue('credit'), id: 'unresolved', fingerprint: 'synthetic-unresolved', occurrence: 2 },
      { ...resolved(issue('debit', 'missing'), 'credit'), id: 'chosen', fingerprint: 'synthetic-chosen', occurrence: 3 }]
      .map(tx => ({ ...tx, statementId: source.statement!.id }))
    const payload = await exportDataBackup(); payload.transactions = rows
    let backup: BackupPayload = payload
    if (version === 1) { const { reviewNotes: _notes, ...rest } = payload as Extract<BackupPayload, { version: 2 }>; backup = { ...rest, version: 1 } }
    const original = structuredClone(backup)
    let archive: Blob | undefined
    if (zip) {
      const built = await buildFullBackupZip(), container = await JSZip.loadAsync(await readArchiveBytes(built.blob))
      container.file(DATABASE_JSON, JSON.stringify(backup)); archive = new Blob([await container.generateAsync({ type: 'arraybuffer' })])
    }
    await db.delete(); await db.open()
    const restore = () => zip ? restoreFullBackupZip(archive!) : importBackup(backup)
    await restore(); await restore()
    expect(backup).toEqual(original)
    const stored = await db.transactions.toArray()
    for (const row of rows) expect(stored.find(tx => tx.id === row.id)).toMatchObject(row)
    expect(summarize(stored)).toEqual({ billingDebitMinor: 150, billingCreditMinor: 150, netMinor: 0, transactionCount: 2 })
    const before = await readSnapshot(), changed = structuredClone(backup)
    changed.transactions[2]!.directionResolution!.direction = 'debit'
    await expect(importBackup(changed)).rejects.toThrow(/方向决定冲突/)
    expect(await readSnapshot()).toEqual(before)
  })
}

it('26-column explicit low-confidence and unrelated flags survive native → JSON backup cleanup', async () => {
  const source = ingestSynthetic(['合成显式标记'])
  await persistImportResults([source])
  const tx = { ...resolved(issue('debit'), 'debit'), flags: ['low_confidence', 'suspected_duplicate'] as Transaction['flags'], reviewStatus: 'pending' as const }
  const restored = (await nativeRestore([tx])).rows[0]!
  expect(restored).toMatchObject({ reviewFlagsSource: 'native_export', flags: tx.flags, directionResolution: tx.directionResolution })
  const payload = await exportDataBackup(); payload.transactions = [{ ...restored, statementId: source.statement!.id }]
  await db.delete(); await db.open(); await importBackup(payload)
  expect((await db.transactions.toArray())[0]).toMatchObject({ reviewFlagsSource: 'native_export', flags: tx.flags, reviewStatus: 'pending', directionResolution: tx.directionResolution })
})

it.each([20, 21, 22, 23] as const)('frozen native %i columns still restore unchanged identity and require explicit choice for missing old evidence', async width => {
  const tx = issue('credit'), current = transactionToRow(tx)
  const headers: string[] = EXPORT_COLUMNS.slice(0, width).map(c => c.header)
  if (width <= 21) headers[9] = '交易类型'
  const buffer = nativeWorkbook([current.slice(0, width)], headers)
  const preview = await previewLegacyWorkbook(buffer, { fileName: 'synthetic-old.xlsx', fileHash: 'old', fileSize: buffer.byteLength }, EMPTY_SNAPSHOT)
  expect(preview.anomalies).toEqual([])
  const row = planLegacyImport(preview, EMPTY_SNAPSHOT).inserted[0]!
  expect(row).toMatchObject({ id: tx.id, fingerprint: tx.fingerprint, occurrence: tx.occurrence, transactionAmountMinor: -100, settlementAmountMinor: 150, flags: ['amount_direction_unclear'], reviewStatus: 'pending' })
  expect(hasUnresolvedDirection(row)).toBe(true)
  expect(() => applyReviewPatch(row, { reviewStatus: 'confirmed', flags: [] })).toThrow(/方向/)
})

it.each([
  ['bank direction cannot be changed by accept_bank', { kind: 'bank', detail: '合成分区' }, { method: 'accept_bank', direction: 'credit' }],
  ['missing evidence cannot accept placeholder', { kind: 'missing', detail: '无可靠方向' }, { method: 'accept_bank', direction: 'debit' }],
  ['invalid evidence rejected', { kind: 'merchant', detail: '还款' }, { method: 'user_choice', direction: 'credit' }],
])('malformed native direction metadata rejects restore: %s', async (_label, evidence, resolution) => {
  const tx = issue('debit'), cells = transactionToRow(tx)
  cells[23] = JSON.stringify(evidence); cells[24] = JSON.stringify(resolution)
  const buffer = nativeWorkbook([cells], EXPORT_COLUMNS.map(c => c.header))
  const preview = await previewLegacyWorkbook(buffer, { fileName: 'synthetic-invalid.xlsx', fileHash: 'invalid', fileSize: buffer.byteLength }, EMPTY_SNAPSHOT)
  expect(preview.rows).toEqual([])
  expect(preview.anomalies).toEqual([expect.objectContaining({ kind: 'invalid_field' })])
})

it('readable archive displays effective direction/amounts and retains source evidence in Technical Metadata', async () => {
  const { transactionToHumanRow, transactionToMetadataRow, LEDGER_METADATA_HEADERS } = await import('../src/export/ledgerArchive')
  const tx = resolved(issue('debit', 'missing'), 'credit')
  expect(transactionToHumanRow(tx).slice(5)).toEqual(['贷', 'CNY', '-1.00', 'CNY', '-1.50'])
  const cells = transactionToMetadataRow(tx, ''), at = (field: string) => cells[LEDGER_METADATA_HEADERS.indexOf(field as typeof LEDGER_METADATA_HEADERS[number])]
  expect(at('stored_direction')).toBe('debit')
  expect(at('raw_transaction_amount_minor')).toBe('-100'); expect(at('raw_settlement_amount_minor')).toBe('150')
  expect(at('direction_resolution')).toBe(JSON.stringify(tx.directionResolution)); expect(at('raw_text')).toBe(tx.rawText)
})
