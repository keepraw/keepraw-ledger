import { beforeEach, expect, it } from 'vitest'
import JSZip from 'jszip'
import { db } from '../src/db/db'
import { bocParser } from '../src/parsers/boc'
import { pdfToText } from '../src/parsers/extract'
import type { PdfDocument, SourceDocument } from '../src/parsers/types'
import { ingestParsedStatement } from '../src/core/ingest'
import { applyReviewPatch, effectiveAmountForDirection, effectiveCurrencyForDirection, hasUnresolvedDirection, validDirectionMetadata } from '../src/core/direction'
import { summarize, monthlyTrend, groupByBank, groupBy } from '../src/core/analytics'
import { reconcileStatement, summarizeTransactions } from '../src/core/reconcile'
import { reconcileStatementTransactions } from '../src/core/reconciliation'
import { TRANSACTION_TYPES, type Direction, type Transaction } from '../src/core/types'
import { persistImportResults, patchTransaction, exportDataBackup, importBackup, readSnapshot, type BackupPayload } from '../src/db/repository'
import { DATABASE_JSON, buildFullBackupZip, restoreFullBackupZip } from '../src/backup/archive'
import { readArchiveBytes } from '../src/backup/zipSafety'
import { previewLegacyWorkbook, planLegacyImport } from '../src/importers/legacyImport'
import { EXPORT_COLUMNS, transactionToRow } from '../src/export/tabular'
import { bocAmountColumns } from './fixtures/directionConflicts'
import { nativeWorkbook } from './fixtures/nativeLedger'
import { EMPTY_SNAPSHOT } from './fixtures/identity'

beforeEach(async () => { await db.delete(); await db.open() })
function parse(pdf: PdfDocument) {
  const doc: SourceDocument = { fileName: 'synthetic-columns.pdf', fileHash: 'synthetic-columns', fileSize: 1, sourceType: 'pdf',
    pdf, text: pdfToText(pdf), tables: [], html: null, email: null }
  const parsed = bocParser.parse(doc)
  const result = ingestParsedStatement(parsed, { fileName: doc.fileName, fileHash: doc.fileHash, fileSize: 1, sourceType: 'pdf' }, EMPTY_SNAPSHOT)
  return { parsed, result, row: result.transactions.find(tx => tx.rawDescription === '示例超市-东门店')! }
}
function choose(row: Transaction, direction: Direction) {
  return applyReviewPatch(row, { directionResolution: { method: 'user_choice', direction,
    amountSource: direction === 'debit' ? 'debit_column' : 'credit_column' } })
}
const MATRIX = [
  ['152.00', '12.34', 'debit', 15200], ['152.00', '12.34', 'credit', -1234],
  ['12.34', '152.00', 'debit', 1234], ['12.34', '152.00', 'credit', -15200],
] as const
for (const reverse of [false, true]) for (const [debit, credit, direction, expected] of MATRIX) {
  it(`PDF order reverse=${reverse}; ${debit}/${credit} choose ${direction} = ${expected}, all consumers agree without identity/raw mutation`, async () => {
    const { row, result } = parse(bocAmountColumns(debit, credit, reverse))
    expect(result.transactions).toHaveLength(7)
    expect(row.bankColumnAmounts).toEqual({ source: 'boc_pdf', rowBinding: 'single_transaction_anchor',
      debit: { direction: 'debit', rawText: debit, amountMinor: Number(debit.replace('.', '')), currency: 'CNY' },
      credit: { direction: 'credit', rawText: credit, amountMinor: Number(credit.replace('.', '')), currency: 'CNY' } })
    expect(effectiveAmountForDirection(row)).toBeNull(); expect(summarize([row]).transactionCount).toBe(0)
    expect(() => applyReviewPatch(row, { directionResolution: { method: 'user_choice', direction } })).toThrow(/方向/)
    const original = structuredClone(row), resolved = choose(row, direction)
    expect(row).toEqual(original)
    expect(resolved).toMatchObject({ id: row.id, fingerprint: row.fingerprint, occurrence: row.occurrence,
      transactionAmountMinor: row.transactionAmountMinor, settlementAmountMinor: row.settlementAmountMinor,
      bankColumnAmounts: row.bankColumnAmounts, rawText: row.rawText })
    expect(resolved.flags).toEqual(row.flags.filter(flag => flag !== 'amount_direction_unclear'))
    const debitTotal = direction === 'debit' ? expected : 0, creditTotal = direction === 'credit' ? -expected : 0
    const statement = { ...result.statement!, summary: { ...result.statement!.summary, previousBalanceMinor: 0,
      currentBalanceMinor: expected, newDebitMinor: debitTotal, newCreditMinor: creditTotal } }
    for (const type of TRANSACTION_TYPES) {
      const tx = { ...resolved, type }
      expect(effectiveAmountForDirection(tx)).toBe(expected)
      expect(effectiveAmountForDirection(tx, 'transaction')).toBe(expected)
      expect(summarize([tx])).toEqual({ billingDebitMinor: debitTotal, billingCreditMinor: creditTotal, netMinor: expected, transactionCount: 1 })
      expect(monthlyTrend([tx])).toEqual([{ month: '2026-08', debit: debitTotal, credit: creditTotal }])
      expect(groupByBank([tx])).toEqual(direction === 'debit' ? [{ label: 'boc', value: expected }] : [])
      expect(groupBy([tx], () => '合成分类')).toEqual(direction === 'debit' ? [{ label: '合成分类', value: expected }] : [])
      const detailed = reconcileStatement({ summary: statement.summary, transactions: [tx] })
      expect(detailed.status).toBe('passed')
      expect(detailed.checks.find(check => check.id === 'debit_detail')!.actualMinor).toBe(debitTotal)
      expect(detailed.checks.find(check => check.id === 'credit_detail')!.actualMinor).toBe(creditTotal)
      expect(reconcileStatementTransactions(statement, [tx])).toMatchObject({ status: 'passed', transactionCount: 1, transactionTotalMinor: expected })
    }
    expect(reconcileStatement({ summary: statement.summary, transactions: [row] }).status).toBe('mismatch')
    expect(reconcileStatementTransactions(statement, [row]).status).toBe('mismatch')
    await persistImportResults([result])
    await patchTransaction({ id: row.id, directionResolution: resolved.directionResolution })
    await patchTransaction({ id: row.id, directionResolution: resolved.directionResolution })
    expect(await db.transactions.count()).toBe(7)
    const stored = (await db.transactions.get(row.id))!
    expect(effectiveAmountForDirection(stored)).toBe(expected)
    expect(stored).toMatchObject({ id: row.id, fingerprint: row.fingerprint, occurrence: row.occurrence, bankColumnAmounts: row.bankColumnAmounts, rawText: row.rawText })
    const bytes = nativeWorkbook([transactionToRow(stored)], EXPORT_COLUMNS.map(c => c.header))
    const meta = { fileName: 'synthetic-columns.xlsx', fileHash: 'native-columns', fileSize: bytes.byteLength }
    const preview = await previewLegacyWorkbook(bytes, meta, EMPTY_SNAPSHOT)
    expect(preview.anomalies).toEqual([])
    const recovered = planLegacyImport(preview, EMPTY_SNAPSHOT).inserted[0]!
    expect(recovered).toMatchObject({ id: row.id, fingerprint: row.fingerprint, occurrence: row.occurrence,
      transactionAmountMinor: row.transactionAmountMinor, settlementAmountMinor: row.settlementAmountMinor,
      directionResolution: stored.directionResolution, bankColumnAmounts: row.bankColumnAmounts, rawText: row.rawText })
    expect(hasUnresolvedDirection(recovered)).toBe(false)
    expect(effectiveAmountForDirection(recovered)).toBe(expected)
    expect(reconcileStatement({ summary: statement.summary, transactions: [recovered] }).status).toBe('passed')
    expect(reconcileStatementTransactions({ ...statement, id: recovered.statementId }, [recovered]).status).toBe('passed')
    const current = { ...EMPTY_SNAPSHOT, transactions: [stored] }
    expect(planLegacyImport(await previewLegacyWorkbook(bytes, meta, current), current).inserted).toEqual([])
    // Same ID with altered source, even the UNSELECTED column, must not silently overwrite evidence.
    const changed = structuredClone(stored); changed.bankColumnAmounts!.debit.amountMinor = 99900; changed.bankColumnAmounts!.debit.rawText = '999.00'
    const conflict = { ...EMPTY_SNAPSHOT, transactions: [changed] }
    expect((await previewLegacyWorkbook(bytes, meta, conflict)).identityWarnings).toEqual([expect.objectContaining({ blocking: true })])
  })
}
it.each(['CNY', 'USD', 'HKD'])('both columns independently retain the bank %s account currency', currency => {
  const pdf = bocAmountColumns('152.00', '12.34')
  const marker = pdf.pages[0]!.items.find(item => item.text.includes('RMB Transaction Detailed List'))!
  marker.text = `${currency} Transaction Detailed List 交易明细`
  const { row, result } = parse(pdf)
  expect(row.bankColumnAmounts!.debit.currency).toBe(currency); expect(row.bankColumnAmounts!.credit.currency).toBe(currency)
  const chosen = choose(row, 'credit'), expected = -1234
  expect(effectiveCurrencyForDirection(chosen)).toBe(currency)
  expect(effectiveAmountForDirection(chosen)).toBe(expected)
  expect(summarizeTransactions([chosen], currency).netMinor).toBe(expected)
  const summary = { ...result.statement!.summary, components: [{ label: '合成账户', currency, minor: 0 }], previousBalanceMinor: 0,
    currentBalanceMinor: expected, newDebitMinor: 0, newCreditMinor: -expected }
  expect(reconcileStatement({ summary, transactions: [chosen] }).status).toBe('passed')
  expect(reconcileStatementTransactions({ ...result.statement!, summary }, [chosen]).status).toBe('passed')
})
it.each([['152.005', '12.34'], ['152.00', '12.345'], ['bad', '12.34'], ['152.00', '1..2'], ['USD 152.00', '12.34'], ['152.00', 'XXX 12.34']])('strictly rejects either malformed/overprecision/currency leg: %s / %s', (debit, credit) => {
  expect(() => parse(bocAmountColumns(debit!, credit!))).toThrow(/金额|币种/)
})
it('preserves negative source signs and texts independently; selection uses only the chosen column magnitude', () => {
  const { row } = parse(bocAmountColumns('-152.00', '(12.34)'))
  expect(row.bankColumnAmounts).toMatchObject({ debit: { rawText: '-152.00', amountMinor: -15200 }, credit: { rawText: '(12.34)', amountMinor: -1234 } })
  expect(effectiveAmountForDirection(choose(row, 'debit'))).toBe(15200)
  expect(effectiveAmountForDirection(choose(row, 'credit'))).toBe(-1234)
})
it('two independently dated rows stay two independent transactions', () => {
  const pdf = bocAmountColumns('152.00', null), page = pdf.pages[1]!
  const second = page.items.filter(item => item.y === 606).map(item => ({ ...item, y: 470,
    text: item.text === '152.00' ? '12.34' : item.text === '示例超市-东门店' ? '合成独立交易' : item.text,
    x: item.text === '152.00' ? 423 : item.x }))
  page.items.push(...second)
  const { parsed } = parse(pdf)
  expect(parsed.transactions).toHaveLength(8)
  expect(parsed.transactions.filter(tx => tx.bankColumnAmounts)).toEqual([])
  expect(parsed.transactions.find(tx => tx.rawDescription === '合成独立交易')).toMatchObject({ direction: 'credit', settlementAmountMinor: -1234 })
})
it.each(['multiple_dates', 'multiple_cards', 'multiple_values'] as const)('cannot silently merge uncertain row structure: %s', kind => {
  const pdf = bocAmountColumns('152.00', '12.34'), page = pdf.pages[1]!
  const item = page.items.find(item => item.y === 606 && item.text === (kind === 'multiple_dates' ? '2026-08-08' : kind === 'multiple_cards' ? '6505' : '152.00'))!
  page.items.push({ ...item, x: item.x + 1 })
  expect(() => parse(pdf)).toThrow(/锚点|交易日期|同一金额列/)
})
for (const version of [1, 2] as const) for (const zip of [false, true]) for (const resolved of [false, true]) {
  it(`${zip ? 'ZIP' : 'JSON'} V${version}, resolved=${resolved}: both sources, decisions and identity survive immutable/idempotent restore`, async () => {
    const { result, row } = parse(bocAmountColumns('152.00', '12.34'))
    await persistImportResults([result])
    if (resolved) await patchTransaction({ id: row.id, directionResolution: choose(row, 'credit').directionResolution })
    const payload = await exportDataBackup()
    let backup: BackupPayload = payload
    if (version === 1) { const { reviewNotes: _notes, ...rest } = payload as Extract<BackupPayload, { version: 2 }>; backup = { ...rest, version: 1 } }
    const before = structuredClone(backup), amounts = summarize(backup.transactions)
    let archive: Blob | undefined
    if (zip) { const container = await JSZip.loadAsync(await readArchiveBytes((await buildFullBackupZip()).blob)); container.file(DATABASE_JSON, JSON.stringify(backup)); archive = new Blob([await container.generateAsync({ type: 'arraybuffer' })]) }
    await db.delete(); await db.open()
    const restore = () => zip ? restoreFullBackupZip(archive!) : importBackup(backup)
    await restore(); await restore()
    expect(backup).toEqual(before)
    expect((await db.transactions.get(row.id))).toEqual(backup.transactions.find(tx => tx.id === row.id))
    expect(summarize(await db.transactions.toArray())).toEqual(amounts)
    const restored = (await db.transactions.get(row.id))!
    expect(effectiveAmountForDirection(restored)).toBe(resolved ? -1234 : null)
    expect(hasUnresolvedDirection(restored)).toBe(!resolved)
    const invalid = structuredClone(backup), changed = invalid.transactions.find(tx => tx.id === row.id)!
    changed.bankColumnAmounts!.credit.amountMinor = 2000; changed.bankColumnAmounts!.credit.rawText = '20.00'; changed.rawText = changed.rawText.replace('12.34', '20.00')
    const snapshot = await readSnapshot()
    await expect(importBackup(invalid)).rejects.toThrow(/金额来源.*冲突/)
    expect(await readSnapshot()).toEqual(snapshot)
  })
}
it.each(['source_direction', 'raw_minor', 'wrong_column', 'unbound', 'fake_currency', 'fake_relation', 'row_text_mismatch'] as const)('rejects inconsistent source/decision metadata: %s', async kind => {
  const { row } = parse(bocAmountColumns('152.00', '12.34')), tx = structuredClone(choose(row, 'credit'))
  if (kind === 'source_direction') tx.bankColumnAmounts!.credit.direction = 'debit'
  if (kind === 'raw_minor') tx.bankColumnAmounts!.credit.amountMinor = 15200
  if (kind === 'wrong_column') tx.directionResolution!.amountSource = 'debit_column'
  if (kind === 'unbound') delete tx.directionResolution!.amountSource
  if (kind === 'fake_currency') tx.bankColumnAmounts!.credit.currency = 'XXX'
  if (kind === 'row_text_mismatch') tx.rawText = '合成已丢失金额原文'
  if (kind === 'fake_relation') Object.assign(tx.bankColumnAmounts!, { rowBinding: 'two_unproven_transactions' })
  expect(validDirectionMetadata(tx)).toBe(false)
  const cells = transactionToRow(tx), bytes = nativeWorkbook([cells], EXPORT_COLUMNS.map(c => c.header))
  const preview = await previewLegacyWorkbook(bytes, { fileName: 'synthetic-invalid.xlsx', fileHash: 'invalid', fileSize: bytes.byteLength }, EMPTY_SNAPSHOT)
  expect(preview.rows).toEqual([]); expect(preview.anomalies).toEqual([expect.objectContaining({ kind: 'invalid_field' })])
  const valid = parse(bocAmountColumns('152.00', '12.34'))
  await persistImportResults([valid.result]); const backup = await exportDataBackup()
  backup.transactions = [tx]
  await db.delete(); await db.open()
  await expect(importBackup(backup)).rejects.toThrow(/无效记录/)
  expect(await db.transactions.count()).toBe(0); expect(await db.statements.count()).toBe(0)
})
it('old 26-column BOC data never fabricates the lost credit column or trusts an unbound choice', async () => {
  const { row } = parse(bocAmountColumns('152.00', '12.34'))
  const old = { ...row, bankColumnAmounts: undefined, flags: [] as Transaction['flags'], reviewStatus: 'confirmed' as const,
    directionResolution: { method: 'user_choice', direction: 'credit' } as const }
  const bytes = nativeWorkbook([transactionToRow(old).slice(0, 26)], EXPORT_COLUMNS.slice(0, 26).map(c => c.header))
  const preview = await previewLegacyWorkbook(bytes, { fileName: 'synthetic-old26.xlsx', fileHash: 'old26', fileSize: bytes.byteLength }, EMPTY_SNAPSHOT)
  expect(preview.anomalies).toEqual([])
  const restored = planLegacyImport(preview, EMPTY_SNAPSHOT).inserted[0]!
  expect(restored.bankColumnAmounts).toBeUndefined()
  expect(restored.directionResolution).toEqual(old.directionResolution)
  expect(hasUnresolvedDirection(restored)).toBe(true)
  expect(effectiveAmountForDirection(restored)).toBeNull()
  expect(() => applyReviewPatch(restored, { directionResolution: { method: 'user_choice', direction: 'credit' } })).toThrow(/方向/)
})

it('bank reimport retains an existing human decision; changed companion source cannot be silently deduplicated', () => {
  const { result, row, parsed } = parse(bocAmountColumns('152.00', '12.34'))
  const current = { statements: [result.statement!], transactions: result.transactions.map(tx => tx.id === row.id ? choose(tx, 'credit') : tx), imports: [] }
  const meta = { fileName: 'synthetic-reimport.pdf', fileHash: 'different-file', fileSize: 1, sourceType: 'pdf' as const }
  const replay = ingestParsedStatement(parsed, meta, current)
  expect(replay.inserted).toEqual([])
  expect(effectiveAmountForDirection(replay.transactions.find(tx => tx.id === row.id)!)).toBe(-1234)
  const changed = parse(bocAmountColumns('152.00', '20.00')).parsed
  expect(() => ingestParsedStatement(changed, meta, current)).toThrow(/双列金额来源冲突/)
  expect(effectiveAmountForDirection(current.transactions.find(tx => tx.id === row.id)!)).toBe(-1234)
})
it('zero and equal-valued columns remain independent sources, not a sum', () => {
  for (const [debit, credit] of [['0.00', '12.34'], ['152.00', '152.00']]) {
    const { row } = parse(bocAmountColumns(debit!, credit!))
    expect(effectiveAmountForDirection(choose(row, 'debit'))).toBe(Number(debit!.replace('.', '')))
    expect(effectiveAmountForDirection(choose(row, 'credit'))).toBe(-Number(credit!.replace('.', '')))
  }
})
it('bank-column metadata and a prior amount-source choice are immutable under restore and patch', async () => {
  const { result, row } = parse(bocAmountColumns('152.00', '12.34'))
  await persistImportResults([result]); await patchTransaction({ id: row.id, directionResolution: choose(row, 'credit').directionResolution })
  const before = await readSnapshot(), altered = structuredClone(row.bankColumnAmounts!)
  altered.credit.rawText = '20.00'; altered.credit.amountMinor = 2000
  await expect(patchTransaction({ id: row.id, bankColumnAmounts: altered })).rejects.toThrow(/原始双列/)
  const payload = await exportDataBackup(), incoming = payload.transactions.find(tx => tx.id === row.id)!
  incoming.directionResolution = { method: 'user_choice', direction: 'debit', amountSource: 'debit_column' }
  await expect(importBackup(payload)).rejects.toThrow(/方向决定冲突/)
  expect(await readSnapshot()).toEqual(before)
})

it('a debit-only original-principal exclusion never hides the selected credit column, and cycle postings are never double-counted', async () => {
  const pdf = bocAmountColumns('152.00', '12.34')
  pdf.pages[1]!.items.find(item => item.text === '示例超市-东门店')!.text = '分期原始 合成原始本金'
  const { result } = parse(pdf), original = result.transactions.find(tx => tx.bankColumnAmounts)!
  expect(original.postingExclusion).toMatchObject({ source: 'bank_original_marker' })
  const cycle: Transaction = { ...original, id: 'synthetic-cycle', description: '合成每期入账', rawDescription: '合成每期入账',
    direction: 'debit', bankColumnAmounts: undefined, postingExclusion: null, flags: [], reviewStatus: 'ok',
    directionEvidence: { kind: 'bank', detail: '合成每期入账列' }, transactionAmountMinor: 100, settlementAmountMinor: 100 }
  for (const direction of ['debit', 'credit'] as const) {
    const rows = [choose(original, direction), cycle], credit = direction === 'credit' ? 1234 : 0
    expect(summarize(rows)).toEqual({ billingDebitMinor: 100, billingCreditMinor: credit, netMinor: 100 - credit, transactionCount: direction === 'credit' ? 2 : 1 })
    const summary = { ...result.statement!.summary, previousBalanceMinor: 0, currentBalanceMinor: 100 - credit, newDebitMinor: 100, newCreditMinor: credit }
    expect(reconcileStatement({ summary, transactions: rows }).status).toBe('passed')
    expect(reconcileStatementTransactions({ ...result.statement!, summary }, rows).status).toBe('passed')
    expect(rows[0]!.postingExclusion).toEqual(original.postingExclusion)
  }
  await persistImportResults([result])
  await patchTransaction({ id: original.id, directionResolution: choose(original, 'credit').directionResolution })
  const payload = await exportDataBackup(), before = await readSnapshot()
  const changed = payload.transactions.find(tx => tx.id === original.id)!
  changed.postingExclusion = { source: 'legacy_installment_exclusion', detail: '合成冲突排除依据' }
  await expect(importBackup(payload)).rejects.toThrow(/入账排除依据冲突/)
  expect(await readSnapshot()).toEqual(before)
})
