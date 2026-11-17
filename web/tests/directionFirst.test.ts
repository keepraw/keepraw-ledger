import { readArchiveBytes } from '../src/backup/zipSafety'
import Dexie from 'dexie'
import JSZip from 'jszip'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BillDatabase, db } from '../src/db/db'
import { repairDirectionFirst } from '../src/db/directionFirstRepair'
import { exportDataBackup, importBackup, persistImportResults, readSnapshot, type BackupPayload } from '../src/db/repository'
import { buildFullBackupZip, DATABASE_JSON, restoreFullBackupZip } from '../src/backup/archive'
import { repairDirectionReview } from '../src/core/direction'
import { detectDuplicates, findSuspectedDuplicateGroups } from '../src/core/dedupe'
import { summarize, monthlyTrend, groupByBank } from '../src/core/analytics'
import { ingestParsedStatement } from '../src/core/ingest'
import { reconcileStatement } from '../src/core/reconcile'
import { reconcileStatementTransactions } from '../src/core/reconciliation'
import { TRANSACTION_TYPES, type Transaction } from '../src/core/types'
import { buildSourceDocument, pdfToText } from '../src/parsers/extract'
import { detectParser, parseDocument } from '../src/parsers/registry'
import type { SourceDocument } from '../src/parsers/types'
import { planLegacyImport, previewLegacyWorkbook } from '../src/importers/legacyImport'
import { EXPORT_COLUMNS, transactionToRow } from '../src/export/tabular'
import { nativeTransaction, nativeWorkbook } from './fixtures/nativeLedger'
import { ingestSynthetic, syntheticStatement, EMPTY_SNAPSHOT } from './fixtures/identity'
import { historyRow, workbookBytes } from './fixtures/legacyWorkbook'
import { MIGRATION_FORMATS } from './fixtures/historicalMigration'
import { buildSyntheticBocPdf } from './fixtures/bocPdf'
import { SYNTHETIC_CCB_HTML } from './fixtures/ccbEml'
import { SYNTHETIC_ICBC_HTML } from './fixtures/icbcEml'
import { SYNTHETIC_ABC_HTML } from './fixtures/abcEml'
import { SYNTHETIC_BOCOM_HTML } from './fixtures/bocomEml'
import { SYNTHETIC_CITIC_HTML } from './fixtures/citicEml'
import { BANK_SIGN_CONFLICTS, bocAmountColumns } from './fixtures/directionConflicts'

beforeEach(async () => { vi.restoreAllMocks(); await db.delete(); await db.open() })

const descriptions = ['合成未知商户', '疑似退款但无可靠类型', '疑似返现但无可靠类型', '疑似还款但无可靠类型',
  '财付通信用卡还款 财付通支付科技有限公司', '境外交易返现', '还款退款优惠体验商店']
const sources = { ccb: SYNTHETIC_CCB_HTML, icbc: SYNTHETIC_ICBC_HTML, abc: SYNTHETIC_ABC_HTML,
  bocom: SYNTHETIC_BOCOM_HTML, citic: SYNTHETIC_CITIC_HTML }
async function bankDocument(bank: string): Promise<SourceDocument> {
  if (bank === 'boc') {
    const pdf = buildSyntheticBocPdf()
    return { fileName: 'synthetic.pdf', fileHash: 'synthetic', fileSize: 1, sourceType: 'pdf', pdf,
      html: null, tables: [], text: pdfToText(pdf), email: null }
  }
  return buildSourceDocument({ fileName: 'synthetic.html', fileHash: 'synthetic',
    buffer: new TextEncoder().encode(sources[bank as keyof typeof sources]).buffer })
}

describe('bank sign conflicts preserve rows and raw evidence instead of aborting', () => {
  it.each(BANK_SIGN_CONFLICTS)('$id: parser → ingest → IndexedDB keeps both source signs and all normal rows', async entry => {
    const doc = await buildSourceDocument({ fileName: 'synthetic-conflict.html', fileHash: entry.id,
      buffer: new TextEncoder().encode(entry.html).buffer })
    const parsed = parseDocument(doc, detectParser(doc)!.parser)
    expect(parsed.transactions).toHaveLength(entry.count)
    const conflict = parsed.transactions.find(tx => tx.rawDescription === entry.description)!
    expect(conflict).toMatchObject({ direction: entry.direction, transactionAmountMinor: entry.transactionAmountMinor,
      settlementAmountMinor: entry.settlementAmountMinor, amountDirectionUnclear: true })
    for (const raw of entry.rawSigns) expect(conflict.rawText).toContain(raw)
    const result = ingestParsedStatement(parsed, { fileName: doc.fileName, fileHash: entry.id, fileSize: 1, sourceType: 'html' }, EMPTY_SNAPSHOT)
    await persistImportResults([result])
    const snapshot = await readSnapshot()
    expect(snapshot.transactions).toHaveLength(entry.count)
    const stored = snapshot.transactions.find(tx => tx.rawDescription === entry.description)!
    expect(stored).toMatchObject({ transactionAmountMinor: entry.transactionAmountMinor,
      settlementAmountMinor: entry.settlementAmountMinor, direction: entry.direction,
      reviewStatus: 'pending', flags: expect.arrayContaining(['amount_direction_unclear']), rawText: conflict.rawText })
    expect(result.statement!.reconciliation.status).toBe('mismatch')
    expect(summarize([stored])).toMatchObject({ transactionCount: 0, netMinor: 0 })
    const baseline = parseDocument(await bankDocument(entry.bank), detectParser(doc)!.parser)
    for (const normal of baseline.transactions.filter(tx => tx.rawDescription !== entry.description)) {
      const retained = snapshot.transactions.find(tx => tx.rawDescription === normal.rawDescription && tx.sourceRow === normal.sourceRow)!
      expect(retained).toMatchObject({ transactionAmountMinor: normal.transactionAmountMinor,
        settlementAmountMinor: normal.settlementAmountMinor, direction: normal.direction, rawDescription: normal.rawDescription })
      expect(retained.flags).not.toContain('amount_direction_unclear')
    }
    // Conflicts that can now be saved must also survive native XLSX recovery.
    const bytes = nativeWorkbook(snapshot.transactions.map(transactionToRow), EXPORT_COLUMNS.map(c => c.header))
    const meta = { fileName: 'synthetic-conflicts.xlsx', fileHash: 'native-conflicts', fileSize: bytes.byteLength }
    const preview = await previewLegacyWorkbook(bytes, meta, EMPTY_SNAPSHOT)
    expect(preview.anomalies).toEqual([])
    const recovered = planLegacyImport(preview, EMPTY_SNAPSHOT).inserted
    expect(recovered).toHaveLength(entry.count)
    expect(summarize(recovered)).toEqual(summarize(snapshot.transactions))
    expect(recovered.find(tx => tx.id === stored.id)).toMatchObject({ id: stored.id, fingerprint: stored.fingerprint,
      occurrence: stored.occurrence, direction: stored.direction, transactionAmountMinor: stored.transactionAmountMinor,
      settlementAmountMinor: stored.settlementAmountMinor, rawText: stored.rawText, reviewStatus: 'pending', flags: stored.flags })
    expect(planLegacyImport(await previewLegacyWorkbook(bytes, meta, snapshot), snapshot).inserted).toEqual([])
  })

  it.each(BANK_SIGN_CONFLICTS.filter(entry => /original-(minus|parentheses)/.test(entry.id)))('$id: excess precision still rejects the whole document', async entry => {
    const raw = entry.rawSigns[0]!
    const html = entry.html.replace(raw, raw.replace('.00', '.005'))
    expect(html).not.toBe(entry.html)
    const doc = await buildSourceDocument({ fileName: 'synthetic-precision.html', fileHash: 'precision',
      buffer: new TextEncoder().encode(html).buffer })
    expect(() => parseDocument(doc, detectParser(doc)!.parser)).toThrow(/金额/)
    expect(await db.transactions.count()).toBe(0)
    expect(await db.statements.count()).toBe(0)
  })

  for (const reverse of [false, true]) {
    it.each([
      ['152.00', '12.34', 15200], ['-152.00', '12.34', -15200],
      ['152.00', '-12.34', 15200], ['-152.00', '-12.34', -15200],
    ] as const)(`BOC both columns %s / %s (reverse=${reverse}): signs survive and all seven rows persist`, async (debit, credit, expectedMinor) => {
      const pdf = bocAmountColumns(debit, credit, reverse)
      const doc = { ...await bankDocument('boc'), pdf, text: pdfToText(pdf) }
      const parsed = parseDocument(doc, detectParser(doc)!.parser)
      const result = ingestParsedStatement(parsed, { fileName: 'synthetic-both-columns.pdf', fileHash: 'both', fileSize: 1, sourceType: 'pdf' }, EMPTY_SNAPSHOT)
      await persistImportResults([result])
      const rows = (await readSnapshot()).transactions
      expect(rows).toHaveLength(7)
      const conflict = rows.find(tx => tx.rawDescription === '示例超市-东门店')!
      expect(conflict).toMatchObject({ direction: 'debit', transactionAmountMinor: expectedMinor,
        settlementAmountMinor: expectedMinor, reviewStatus: 'pending', flags: expect.arrayContaining(['amount_direction_unclear']) })
      expect(conflict.rawText).toContain(debit)
      expect(conflict.rawText).toContain(credit)
      expect(result.statement!.status).toBe('needs_review')
      expect(rows.filter(tx => tx.id !== conflict.id).every(tx => !tx.flags.includes('amount_direction_unclear'))).toBe(true)
      const bytes = nativeWorkbook(rows.map(transactionToRow), EXPORT_COLUMNS.map(c => c.header))
      const preview = await previewLegacyWorkbook(bytes, { fileName: 'synthetic-both.xlsx', fileHash: 'native-both', fileSize: bytes.byteLength }, EMPTY_SNAPSHOT)
      expect(preview.anomalies).toEqual([])
      const recovered = planLegacyImport(preview, EMPTY_SNAPSHOT).inserted
      expect(recovered).toHaveLength(7)
      expect(summarize(recovered)).toEqual(summarize(rows))
      expect(recovered.find(tx => tx.id === conflict.id)).toMatchObject({ id: conflict.id, fingerprint: conflict.fingerprint,
        direction: 'debit', transactionAmountMinor: expectedMinor, settlementAmountMinor: expectedMinor,
        rawText: conflict.rawText, reviewStatus: 'pending', flags: conflict.flags })
    })
  }
  it('BOC single negative debit is saved unchanged for direction review', async () => {
    const pdf = bocAmountColumns('-152.00', null)
    const doc = { ...await bankDocument('boc'), pdf, text: pdfToText(pdf) }
    const parsed = parseDocument(doc, detectParser(doc)!.parser)
    const result = ingestParsedStatement(parsed, { fileName: 'synthetic-negative.pdf', fileHash: 'negative', fileSize: 1, sourceType: 'pdf' }, EMPTY_SNAPSHOT)
    await persistImportResults([result])
    expect((await readSnapshot()).transactions.find(tx => tx.rawDescription === '示例超市-东门店'))
      .toMatchObject({ direction: 'debit', transactionAmountMinor: -15200, settlementAmountMinor: -15200,
        reviewStatus: 'pending', flags: expect.arrayContaining(['amount_direction_unclear']) })
  })
  it.each([['152.00', '12.345'], ['152.005', '-12.34'], ['152.00', '10..25']])('BOC validates both columns independently: %s / %s', async (debit, credit) => {
    const pdf = bocAmountColumns(debit!, credit!)
    const doc = { ...await bankDocument('boc'), pdf, text: pdfToText(pdf) }
    expect(() => parseDocument(doc, detectParser(doc)!.parser)).toThrow(/金额/)
    expect(await db.transactions.count()).toBe(0)
  })
})

describe('six bank parsers: descriptions never gate booking or determine direction', () => {
  for (const bank of ['boc', ...Object.keys(sources)]) {
    it.each(['debit', 'credit'] as const)(`${bank}: unknown %s and merchant keywords keep bank amounts and direction`, async direction => {
      for (const description of descriptions) {
        const doc = await bankDocument(bank)
        const parser = detectParser(doc)!.parser
        const baseline = parseDocument(doc, parser)
        const target = baseline.transactions.find(tx => tx.direction === direction && !tx.postingExclusion)!
        let replaced = false
        if (doc.pdf) {
          // Use an unwrapped, synthetic description on each side of the PDF's amount columns.
          const old = direction === 'credit' ? '网银转账-还款' : '示例超市-东门店'
          for (const page of doc.pdf.pages) for (const item of page.items) {
            if (item.text === old) { item.text = description; replaced = true }
          }
          doc.text = pdfToText(doc.pdf)
        } else {
          for (const table of doc.tables) for (const row of table.rows) {
            const index = row.indexOf(target.rawDescription)
            if (index < 0) continue
            row[index] = description
            if (bank === 'icbc') row[3] = '银行未注明业务性质'
            replaced = true
          }
        }
        expect(replaced).toBe(true)
        const parsed = parseDocument(doc, parser)
        const changed = parsed.transactions.find(tx => tx.rawDescription === description)!
        expect(changed.direction).toBe(direction)
        if (bank !== 'boc') {
          expect(changed.transactionAmountMinor).toBe(target.transactionAmountMinor)
          expect(changed.settlementAmountMinor).toBe(target.settlementAmountMinor)
        }
        const result = ingestParsedStatement(parsed, { fileName: doc.fileName, fileHash: 'synthetic', fileSize: 1,
          sourceType: doc.sourceType }, EMPTY_SNAPSHOT)
        const stored = result.transactions.find(tx => tx.rawDescription === description)!
        expect(stored).toMatchObject({ direction, reviewStatus: 'ok', category: '未分类', rawDescription: description })
        expect(stored.flags).not.toContain('transaction_type_unclear')
        expect(stored.flags).not.toContain('amount_direction_unclear')
        expect(result.statement!.status).toBe('reconciled')
      }
    })
  }
  it('BOC keeps simultaneous debit and credit amount columns in direction review', async () => {
    const doc = await bankDocument('boc')
    const page = doc.pdf!.pages[1]!
    const debit = page.items.find(item => item.text === '152.00')!
    page.items.push({ ...debit, x: 425, text: '152.00' })
    doc.text = pdfToText(doc.pdf!)
    const parsed = parseDocument(doc, detectParser(doc)!.parser)
    const result = ingestParsedStatement(parsed, { fileName: 'synthetic.pdf', fileHash: 'conflict', fileSize: 1, sourceType: 'pdf' }, EMPTY_SNAPSHOT)
    expect(result.transactions.find(tx => tx.rawDescription === '示例超市-东门店')).toMatchObject({ reviewStatus: 'pending' })
    expect(result.transactions.find(tx => tx.rawDescription === '示例超市-东门店')!.flags).toContain('amount_direction_unclear')
  })
  it('ABC keeps a section/sign contradiction in direction review after normalization', async () => {
    const doc = await bankDocument('abc')
    for (const table of doc.tables) for (const row of table.rows) {
      if (row.includes('还款 卡卡转账')) row[5] = '-3000.00/CNY'
    }
    const parsed = parseDocument(doc, detectParser(doc)!.parser)
    const result = ingestParsedStatement(parsed, { fileName: 'synthetic.html', fileHash: 'conflict', fileSize: 1, sourceType: 'html' }, EMPTY_SNAPSHOT)
    expect(result.transactions.find(tx => tx.rawDescription === '还款 卡卡转账')).toMatchObject({
      flags: ['amount_direction_unclear', 'statement_mismatch'], reviewStatus: 'pending', direction: 'credit' })
    expect(result.statement!.reconciliation.status).toBe('mismatch')
  })
  it('ICBC never uses a business token to fill in a missing positive-amount direction marker', async () => {
    for (const token of ['还款', '退款', '优惠', '银行未注明']) {
      const doc = await bankDocument('icbc')
      for (const table of doc.tables) for (const row of table.rows) {
        if (row.includes('手机银行还款转入')) { row[3] = token; row[6] = '3000.00/RMB' }
      }
      const parsed = parseDocument(doc, detectParser(doc)!.parser)
      const result = ingestParsedStatement(parsed, { fileName: 'synthetic.html', fileHash: 'missing-direction', fileSize: 1, sourceType: 'html' }, EMPTY_SNAPSHOT)
      const row = result.transactions.find(tx => tx.rawDescription === '手机银行还款转入')!
      expect(row.reviewStatus).toBe('pending')
      expect(row.flags).toContain('amount_direction_unclear')
      expect(summarize([row])).toMatchObject({ transactionCount: 0, netMinor: 0 })
    }
  })
})

describe('three historical adapters', () => {
  for (const format of MIGRATION_FORMATS) {
    it(`${format.sheet}: books unknown debit/credit and keeps real monetary conflicts`, async () => {
      const rows = descriptions.flatMap((description, index) => [100 + index, -100 - index].map(amount => historyRow({ description,
        说明: description, 交易详情: description, transaction_amount: amount, settlement_amount: amount,
        交易金额: amount, 结算金额: amount, 入账金额: amount }, format.format)))
      rows.push(historyRow({ transaction_amount: 999, settlement_amount: -999, 交易金额: 999, 结算金额: -999, 入账金额: -999 }, format.format))
      const bytes = workbookBytes(format.sheet, format.columns, rows)
      const preview = await previewLegacyWorkbook(bytes, { fileName: 'synthetic.xlsx', fileHash: 'synthetic', fileSize: bytes.byteLength }, EMPTY_SNAPSHOT)
      const plan = planLegacyImport(preview, EMPTY_SNAPSHOT)
      expect(plan.inserted).toHaveLength(rows.length)
      for (const row of plan.inserted.slice(0, -1)) {
        expect(row).toMatchObject({ reviewStatus: 'ok', category: '未分类', flags: [] })
        expect(row.direction).toBe(row.settlementAmountMinor < 0 ? 'credit' : 'debit')
      }
      expect(plan.inserted.at(-1)).toMatchObject({ reviewStatus: 'pending', flags: ['amount_direction_unclear'] })
    })
  }
})

it('totals, trends and both reconciliation engines ignore every legacy type value', () => {
  const debit = nativeTransaction(1, { transactionCurrency: 'CNY', settlementCurrency: 'CNY', transactionAmountMinor: 1150,
    settlementAmountMinor: 1150, flags: [], reviewStatus: 'ok' })
  const credit = { ...debit, id: 'credit', direction: 'credit' as const, transactionAmountMinor: -100, settlementAmountMinor: -100 }
  const summary = { ...syntheticStatement([]).summary, previousBalanceMinor: 0, currentBalanceMinor: 1050,
    newDebitMinor: 1000, newCreditMinor: 100, chargeMinor: 100, interestMinor: 50 }
  const statement = { ...ingestSynthetic([]).statement!, id: debit.statementId, summary }
  for (const type of TRANSACTION_TYPES) {
    const rows = [{ ...debit, type }, { ...credit, type }]
    expect(summarize(rows)).toEqual({ billingDebitMinor: 1150, billingCreditMinor: 100, netMinor: 1050, transactionCount: 2 })
    expect(monthlyTrend(rows)).toEqual([{ month: '2024-01', debit: 1150, credit: 100 }])
    expect(groupByBank(rows)).toEqual([{ label: 'boc', value: 1150 }])
    const reconciliation = reconcileStatement({ summary, transactions: rows })
    expect(reconciliation.status).toBe('passed')
    expect(reconciliation.checks.find(c => c.id === 'charges_detail')).toMatchObject({ status: 'skipped', actualMinor: null })
    expect(reconcileStatementTransactions(statement, rows).status).toBe('passed')
    expect(reconcileStatement({ summary: { ...summary, newDebitMinor: 999 }, transactions: rows }).status).toBe('mismatch')
  }
  const offset = [{ ...debit, transactionAmountMinor: 1250, settlementAmountMinor: 1250 },
    { ...credit, transactionAmountMinor: -200, settlementAmountMinor: -200 }]
  expect(reconcileStatementTransactions(statement, offset)).toMatchObject({ status: 'mismatch', differenceMinor: 0 })
  const conflict = { ...debit, direction: 'credit' as const }
  expect(reconcileStatement({ summary, transactions: [conflict, credit] }).status).toBe('mismatch')
  expect(reconcileStatementTransactions(statement, [conflict, credit])).toMatchObject({ status: 'mismatch', transactionTotalMinor: -100, differenceMinor: 1150 })
  expect(summarize([conflict])).toMatchObject({ transactionCount: 0, netMinor: 0 })
})

it.each(['ok', 'pending', 'confirmed', 'rejected'] as const)('native XLSX keeps a real monetary conflict with exported status %s', async status => {
  const row = nativeTransaction(1, { reviewStatus: status, direction: 'credit', type: 'payment', category: '旅行',
    transactionAmountMinor: 100, settlementAmountMinor: -100 })
  const bytes = nativeWorkbook([transactionToRow(row)], EXPORT_COLUMNS.map(c => c.header))
  const preview = await previewLegacyWorkbook(bytes, { fileName: 'synthetic.xlsx', fileHash: 'conflict', fileSize: bytes.byteLength }, EMPTY_SNAPSHOT)
  expect(preview.anomalies).toEqual([])
  expect(planLegacyImport(preview, EMPTY_SNAPSHOT).inserted[0]).toMatchObject({ id: row.id, fingerprint: row.fingerprint,
    category: '旅行', flags: ['uncategorized', 'amount_direction_unclear'], reviewStatus: status === 'ok' ? 'pending' : status })
})

it.each(['ok', 'pending', 'confirmed', 'rejected'] as const)('native XLSX preserves a settlement/direction conflict with exported status %s', async status => {
  const row = nativeTransaction(1, { reviewStatus: status, direction: 'debit', type: 'purchase',
    transactionAmountMinor: -100, settlementAmountMinor: -100 })
  const bytes = nativeWorkbook([transactionToRow(row)], EXPORT_COLUMNS.map(c => c.header))
  const meta = { fileName: 'synthetic-direction.xlsx', fileHash: 'settlement-conflict', fileSize: bytes.byteLength }
  const preview = await previewLegacyWorkbook(bytes, meta, EMPTY_SNAPSHOT)
  expect(preview.anomalies).toEqual([])
  expect(planLegacyImport(preview, EMPTY_SNAPSHOT).inserted[0]).toMatchObject({ id: row.id, fingerprint: row.fingerprint,
    direction: 'debit', transactionAmountMinor: -100, settlementAmountMinor: -100,
    flags: ['uncategorized', 'amount_direction_unclear'], reviewStatus: status === 'ok' ? 'pending' : status })
  // A conflicting direction under an ALREADY STORED ID still blocks recovery.
  const existing = { ...EMPTY_SNAPSHOT, transactions: [{ ...row, direction: 'credit' as const }] }
  const conflicting = await previewLegacyWorkbook(bytes, meta, existing)
  expect(conflicting.identityWarnings).toEqual([expect.objectContaining({ blocking: true })])
  expect(() => planLegacyImport(conflicting, existing)).toThrow('交易标识冲突')
})

it('duplicate financial candidates do not depend on legacy type and never mix settlement currencies or directions', () => {
  const first = nativeTransaction(1)
  const second = nativeTransaction(2, { description: 'Another synthetic merchant', rawDescription: 'Another synthetic merchant', type: 'fee' })
  const differentCurrency = { ...second, id: 'other-currency', settlementCurrency: 'JPY' }
  const differentDirection = { ...second, id: 'other-direction', direction: 'credit' as const }
  for (const type of TRANSACTION_TYPES) {
    const candidate = { ...second, type }
    expect(detectDuplicates([candidate], [first]).suspectedDuplicates.has(candidate.id)).toBe(true)
    expect(findSuspectedDuplicateGroups([first, candidate]).has(candidate.id)).toBe(true)
  }
  expect(findSuspectedDuplicateGroups([first, differentCurrency, differentDirection]).size).toBe(0)
})

function historicalRows(): Transaction[] {
  const cases: Array<[Transaction['reviewStatus'], string[], number, number, Transaction['direction']]> = [
    ['pending', ['transaction_type_unclear'], 100, 100, 'debit'],
    ['pending', ['transaction_type_unclear'], -100, -100, 'credit'],
    ['pending', ['transaction_type_unclear', 'suspected_duplicate'], 100, 100, 'debit'],
    ['pending', ['transaction_type_unclear'], 100, -100, 'credit'],
    ['pending', ['transaction_type_unclear'], -100, 100, 'debit'],
    ['pending', ['transaction_type_unclear'], -100, -100, 'debit'],
    ['pending', ['transaction_type_unclear', 'amount_direction_unclear'], 100, 100, 'debit'],
    ['confirmed', ['transaction_type_unclear'], 100, -100, 'credit'],
    ['rejected', ['transaction_type_unclear'], 100, 100, 'debit'],
    ['pending', ['low_confidence'], 100, 100, 'debit'],
    ['pending', ['transaction_type_unclear'], 0, -100, 'credit'],
    ['ok', ['transaction_type_unclear'], -100, 100, 'debit'],
    ['ok', ['transaction_type_unclear', 'suspected_duplicate'], 100, -100, 'credit'],
    ['confirmed', ['transaction_type_unclear', 'date_missing'], 100, -100, 'credit'],
    ['rejected', ['transaction_type_unclear', 'low_confidence'], -100, 100, 'debit'],
    ['ok', ['amount_direction_unclear'], 100, -100, 'credit'],
    ['ok', ['transaction_type_unclear'], 100, 100, 'debit'],
    ['ok', ['transaction_type_unclear', 'amount_direction_unclear'], -100, 100, 'debit'],
  ]
  return cases.map(([reviewStatus, flags, transactionAmountMinor, settlementAmountMinor, direction], index) =>
    ({ ...nativeTransaction(index + 1, { transactionCurrency: 'CNY', settlementCurrency: 'CNY' }),
      reviewStatus, flags, transactionAmountMinor, settlementAmountMinor, direction }) as Transaction)
}
function expectedRepairs(rows: Transaction[]) {
  // Independent literal state/flag references; compare every other field exactly.
  const expected: Array<[Transaction['reviewStatus'], string[]]> = [
    ['ok', []], ['ok', []], ['pending', ['suspected_duplicate']],
    ['pending', ['amount_direction_unclear']], ['pending', ['amount_direction_unclear']],
    ['pending', ['amount_direction_unclear']], ['pending', ['amount_direction_unclear']],
    ['confirmed', ['amount_direction_unclear']], ['rejected', []], ['pending', ['low_confidence']], ['ok', []],
    ['pending', ['amount_direction_unclear']], ['pending', ['suspected_duplicate', 'amount_direction_unclear']],
    ['confirmed', ['date_missing', 'amount_direction_unclear']], ['rejected', ['low_confidence', 'amount_direction_unclear']],
    ['pending', ['amount_direction_unclear']], ['ok', []], ['pending', ['amount_direction_unclear']],
  ]
  return rows.map((row, index) => ({ ...row, reviewStatus: expected[index]![0], flags: expected[index]![1] }))
}

const schema = { statements: 'id', transactions: 'id, statementId', imports: 'id', settings: 'key', reviewNotes: 'transactionId', attachments: 'fileHash' }

it('v5 → v6 repairs atomically and idempotently, preserving every other property and store', async () => {
  const name = 'synthetic-direction-upgrade'
  await Dexie.delete(name)
  const old = new Dexie(name); old.version(5).stores(schema)
  const rows = historicalRows()
  await old.table('transactions').bulkAdd(rows)
  for (const [store, key] of Object.entries({ statements: 'id', imports: 'id', settings: 'key', reviewNotes: 'transactionId', attachments: 'fileHash' })) {
    await old.table(store).put({ [key]: 'synthetic', preserved: '原文\n备注', bytes: new Uint8Array([1, 2, 3]).buffer })
  }
  const readOther = (database: Dexie) => Promise.all(database.tables.filter(t => t.name !== 'transactions').map(t => t.toArray()))
  const other = await readOther(old); old.close()
  const upgraded = new BillDatabase(name)
  try {
    await upgraded.open()
    expect(upgraded.verno).toBe(6)
    expect(await upgraded.transactions.toArray()).toEqual(expectedRepairs(rows).sort((a, b) => a.id.localeCompare(b.id)))
    expect(await readOther(upgraded)).toEqual(other)
    await upgraded.transaction('rw', upgraded.transactions, tx => repairDirectionFirst(tx))
    upgraded.close(); await upgraded.open()
    expect(await upgraded.transactions.toArray()).toEqual(expectedRepairs(rows).sort((a, b) => a.id.localeCompare(b.id)))
  } finally { await upgraded.delete() }
})

it('an abort after v6 repair rolls back all edits and the version, then retries cleanly', async () => {
  const name = 'synthetic-direction-abort'
  await Dexie.delete(name)
  const old = new Dexie(name); old.version(5).stores(schema)
  const rows = historicalRows(); await old.table('transactions').bulkAdd(rows); old.close()
  const failing = new BillDatabase(name)
  failing.version(7).stores({}).upgrade(() => { throw new Error('synthetic failure after direction repair') })
  await expect(failing.open()).rejects.toThrow('synthetic failure after direction repair'); failing.close()
  const rollback = new Dexie(name)
  await rollback.open()
  expect(rollback.verno).toBe(5)
  expect(await rollback.table('transactions').toArray()).toEqual([...rows].sort((a, b) => a.id.localeCompare(b.id)))
  rollback.close()
  const retry = new BillDatabase(name)
  try { await retry.open(); expect(await retry.transactions.toArray()).toEqual(expectedRepairs(rows).sort((a, b) => a.id.localeCompare(b.id))) }
  finally { await retry.delete() }
})

async function oldBackup(version: 1 | 2): Promise<BackupPayload> {
  const result = ingestSynthetic(['合成备份商户'])
  await persistImportResults([result])
  const payload = await exportDataBackup()
  payload.transactions = historicalRows().map(row => ({ ...row, statementId: result.statement!.id }))
  payload.statements[0]!.transactionCount = payload.transactions.length
  if (version === 1) { const { reviewNotes: _notes, ...v1 } = payload as Extract<BackupPayload, { version: 2 }>; return { ...v1, version: 1 } }
  return payload
}
for (const version of [1, 2] as const) {
  it(`JSON V${version} restores old flags immutably, with financial conflicts and rollback intact`, async () => {
    const payload = await oldBackup(version)
    const original = structuredClone(payload)
    await db.delete(); await db.open()
    await importBackup(payload); await importBackup(payload)
    expect(payload).toEqual(original)
    expect((await db.transactions.toArray()).sort((a, b) => a.occurrence - b.occurrence)).toEqual(expectedRepairs(original.transactions))
    const before = await readSnapshot()
    const invalid = structuredClone(payload); invalid.transactions[0]!.settlementAmountMinor++
    await expect(importBackup(invalid)).rejects.toThrow('交易标识冲突')
    expect(await readSnapshot()).toEqual(before)
    await db.delete(); await db.open()
    vi.spyOn(db.imports, 'bulkAdd').mockRejectedValueOnce(new Error('synthetic write failure'))
    await expect(importBackup(payload)).rejects.toThrow('synthetic write failure')
    expect(await db.transactions.count()).toBe(0); expect(await db.statements.count()).toBe(0)
  })
  it(`ZIP with JSON V${version} uses the same old-flag repair and is idempotent`, async () => {
    const payload = await oldBackup(version)
    const { blob } = await buildFullBackupZip()
    const zip = await JSZip.loadAsync(await readArchiveBytes(blob))
    zip.file(DATABASE_JSON, JSON.stringify(payload))
    const archive = new Blob([await zip.generateAsync({ type: 'arraybuffer' })])
    await db.delete(); await db.open()
    await restoreFullBackupZip(archive); await restoreFullBackupZip(archive)
    expect((await db.transactions.toArray()).sort((a, b) => a.occurrence - b.occurrence)).toEqual(expectedRepairs(payload.transactions))
  })
}

it('v6 and restore preserve historical installment exclusions without using type for new postings', async () => {
  const name = 'synthetic-installment-exclusion'
  await Dexie.delete(name)
  const old = new Dexie(name); old.version(5).stores(schema)
  const original = nativeTransaction(1, { type: 'installment_original', flags: [], reviewStatus: 'ok',
    transactionCurrency: 'CNY', settlementCurrency: 'CNY', transactionAmountMinor: 90000, settlementAmountMinor: 90000 })
  const posted = nativeTransaction(2, { ...original, id: 'posted', fingerprint: 'posted', type: 'installment_original',
    transactionAmountMinor: 30000, settlementAmountMinor: 30000, postingExclusion: null })
  await old.table('transactions').bulkAdd([original, posted]); old.close()
  const upgraded = new BillDatabase(name)
  try {
    await upgraded.open()
    const row = (await upgraded.transactions.get(original.id))!
    expect(row.postingExclusion).toMatchObject({ source: 'legacy_installment_exclusion' })
    expect({ ...row, postingExclusion: undefined }).toEqual({ ...original, postingExclusion: undefined })
    expect(summarize([row, posted])).toMatchObject({ billingDebitMinor: 30000, transactionCount: 1 })
    const { normalizeRestoredTransaction } = await import('../src/db/restoreTransaction')
    expect(normalizeRestoredTransaction(original)).toEqual(row)
    expect(normalizeRestoredTransaction(posted)).toEqual(posted)
    expect(original).not.toHaveProperty('postingExclusion')
    const phantom = { ...posted, origin: 'legacy_import' as const, sourceId: 'legacy-keepraw-ledger-export-v1',
      reviewStatus: 'pending' as const, flags: ['transaction_type_unclear', 'low_confidence'] } as unknown as Transaction
    expect(normalizeRestoredTransaction(phantom)).toMatchObject({ flags: [], reviewStatus: 'ok' })
  } finally { await upgraded.delete() }
})

it('native XLSX preserves evidence, identity and duplicate recognition without reading legacy type as finance', async () => {
  const doc = await bankDocument('bocom')
  const parsed = parseDocument(doc, detectParser(doc)!.parser)
  const result = ingestParsedStatement(parsed, { fileName: doc.fileName, fileHash: 'synthetic', fileSize: 1, sourceType: 'html' }, EMPTY_SNAPSHOT)
  const original = result.transactions.find(tx => tx.postingExclusion)!
  expect(original.postingExclusion).toMatchObject({ source: 'bocom_plan' })
  const bytes = nativeWorkbook(result.transactions.map(transactionToRow), EXPORT_COLUMNS.map(c => c.header))
  const meta = { fileName: 'synthetic-native.xlsx', fileHash: 'synthetic-native', fileSize: bytes.byteLength }
  const preview = await previewLegacyWorkbook(bytes, meta, EMPTY_SNAPSHOT)
  expect(preview.anomalies).toEqual([])
  const plan = planLegacyImport(preview, EMPTY_SNAPSHOT)
  expect(plan.inserted.map(tx => [tx.id, tx.fingerprint, tx.occurrence])).toEqual(result.transactions.map(tx => [tx.id, tx.fingerprint, tx.occurrence]))
  expect(plan.inserted.find(tx => tx.id === original.id)!.postingExclusion).toEqual(original.postingExclusion)
  expect(summarize(plan.inserted)).toEqual(summarize(result.transactions))
  const existing = { statements: plan.statements, transactions: plan.inserted, imports: [] }
  expect(planLegacyImport(await previewLegacyWorkbook(bytes, meta, existing), existing).inserted).toEqual([])
  const oldBytes = nativeWorkbook(result.transactions.map(tx => transactionToRow(tx).slice(0, 21)),
    [...EXPORT_COLUMNS.slice(0, 21).map(c => c.header === '历史类型（仅身份兼容）' ? '交易类型' : c.header)])
  expect(planLegacyImport(await previewLegacyWorkbook(oldBytes, meta, existing), existing).inserted).toEqual([])
  const changedTypes = result.transactions.map(tx => ({ ...tx, type: 'payment' as const }))
  expect(summarize(changedTypes)).toEqual(summarize(result.transactions))
  expect(repairDirectionReview(original)).toBe(original)
})
