import { beforeEach, describe, expect, it } from 'vitest'
import { parseAmountToMinor, currencyExponent } from '../src/core/money'
import { ingestParsedStatement, type IngestResult } from '../src/core/ingest'
import { db } from '../src/db/db'
import { persistImportResults, readSnapshot, setReviewNote } from '../src/db/repository'
import { previewLegacyWorkbook } from '../src/importers/legacyImport'
import { LEGACY_UNIFIED_COLUMNS } from '../src/importers/legacyPythonExportV1'
import { LEGACY_KEEPRAW_COLUMNS } from '../src/importers/legacyKeeprawExportV1'
import { LEGACY_UNIFIED_BILL_COLUMNS } from '../src/importers/legacyUnifiedBillV1'
import { buildDemoDataset } from '../src/demo/demoData'
import type { StatementSummary } from '../src/core/types'
import { buildSourceDocument, pdfToText } from '../src/parsers/extract'
import { detectParser, parseDocument } from '../src/parsers/registry'
import { bocParser } from '../src/parsers/boc'
import type { SourceDocument } from '../src/parsers/types'
import { historyRow, workbookBytes } from './fixtures/legacyWorkbook'
import { buildSyntheticBocPdf } from './fixtures/bocPdf'
import { SYNTHETIC_CCB_HTML } from './fixtures/ccbEml'
import { SYNTHETIC_ICBC_HTML } from './fixtures/icbcEml'
import { SYNTHETIC_ABC_HTML } from './fixtures/abcEml'
import { SYNTHETIC_BOCOM_HTML } from './fixtures/bocomEml'
import { SYNTHETIC_CITIC_HTML } from './fixtures/citicEml'

const EMPTY = { imports: [], statements: [], transactions: [] }
const CURRENCIES = ['CNY', 'USD', 'HKD', 'EUR', 'GBP', 'SGD', 'AUD', 'CAD', 'CHF', 'JPY', 'KRW', 'VND']
const MALFORMED = ['10..25', '1.2.3', '1,2,3.45', '12,34', '1.234,56', 'amount 12.34', '--12.34', '(12.34', '12.345']

function demoImportWithSummary(summary: Partial<StatementSummary> = {}): IngestResult {
  const result = structuredClone(buildDemoDataset()[0]!)
  if (!result.statement) throw new Error('Expected demo statement')
  result.statement = { ...result.statement, summary: { ...result.statement.summary, ...summary } }
  return result
}

function summaryOnlyReimport(stored: IngestResult, summary: Partial<StatementSummary>): IngestResult {
  const incoming = structuredClone(stored)
  if (!incoming.statement) throw new Error('Expected demo statement')
  const fileHash = 'synthetic-summary-reimport'
  const fileName = 'synthetic-summary-reimport.eml'
  incoming.record = {
    ...incoming.record,
    id: `${fileHash}:${incoming.record.parserId}`,
    fileHash,
    fileName,
  }
  incoming.statement = {
    ...incoming.statement,
    sourceFileHash: fileHash,
    sourceFileName: fileName,
    summary: { ...incoming.statement.summary, ...summary },
  }
  incoming.transactions = []
  incoming.inserted = []
  return incoming
}

describe('strict financial amount grammar', () => {
  it.each(MALFORMED)('rejects %s without removing text or guessing separators', (text) => {
    expect(parseAmountToMinor(text, 'CNY')).toBeNull()
  })
  it.each(CURRENCIES)('%s: accepts matching currency and rejects a conflicting column', (currency) => {
    const decimal = currencyExponent(currency) === 0 ? '100' : '100.25'
    const minor = currencyExponent(currency) === 0 ? 100 : 10025
    expect(parseAmountToMinor(decimal, currency)?.minor).toBe(minor)
    expect(parseAmountToMinor(`${currency} ${decimal}`, currency)?.minor).toBe(minor)
    expect(parseAmountToMinor(`${currency} (${decimal})`, currency)?.minor).toBe(-minor)
    const other = currency === 'CNY' ? 'JPY' : 'CNY'
    expect(parseAmountToMinor(`${other} 100`, currency)).toBeNull()
  })
  it('keeps supported bank signs and canonical RMB aliases', () => {
    for (const value of ['CNY -1,234.56', 'CNY (1,234.56)', '1234.56-', '1234.56/C', '1234.56CR']) {
      expect(parseAmountToMinor(value, 'CNY')?.minor).toBe(-123456)
    }
    expect(parseAmountToMinor('CHN -10.25', 'RMB')?.minor).toBe(-1025)
    expect(parseAmountToMinor('人民币10.25元', 'CNY')?.minor).toBe(1025)
    expect(parseAmountToMinor('100.50', 'JPY')).toBeNull()
    expect(parseAmountToMinor('100.00', 'JPY')?.minor).toBe(100)
    expect(() => parseAmountToMinor('KWD 1.000')).toThrow('货币精度')
    expect(() => parseAmountToMinor('1.000', 'KWD')).toThrow('货币精度')
  })
})

describe('all historical adapters expose invalid monetary legs', () => {
  const formats = [
    ['标准字段', LEGACY_UNIFIED_COLUMNS, 'python', ['transaction_amount', 'settlement_amount']],
    ['交易明细', LEGACY_KEEPRAW_COLUMNS, 'keepraw', ['交易金额', '结算金额']],
    ['统一账单', LEGACY_UNIFIED_BILL_COLUMNS, 'unified', ['交易金额', '入账金额']],
  ] as const
  for (const [sheet, headers, format, columns] of formats) {
    for (const column of columns) {
      it.each([...MALFORMED, 'USD 100.00', 'KWD 100.00'])(`${sheet}/${column}: excludes %s with a source row`, async (value) => {
        const buffer = workbookBytes(sheet, headers, [historyRow({ [column]: value }, format)])
        const preview = await previewLegacyWorkbook(buffer, { fileName: 'synthetic.xlsx', fileHash: 'synthetic', fileSize: buffer.byteLength }, EMPTY)
        expect(preview.rows).toHaveLength(0)
        expect(preview.anomalies).toEqual([expect.objectContaining({ rowNumber: 2, kind: 'amount_unparseable' })])
      })
    }
  }
})

async function document(html: string, hash = 'synthetic'): Promise<SourceDocument> {
  return buildSourceDocument({ fileName: 'synthetic.html', buffer: new TextEncoder().encode(html).buffer, fileHash: hash })
}

async function importHtml(html: string, hash: string) {
  const doc = await document(html, hash)
  const match = detectParser(doc)
  expect(match).not.toBeNull()
  const parsed = parseDocument(doc, match!.parser)
  const result = ingestParsedStatement(parsed, { fileName: 'synthetic.html', fileHash: hash, fileSize: 1, sourceType: 'html' }, await readSnapshot())
  await persistImportResults([result])
  return { parsed, result }
}

const BANK_CASES = [
  ['ccb', SYNTHETIC_CCB_HTML, '<td>CNY</td><td>900.00</td>', '<td>JPY</td><td>100.50</td>'],
  ['icbc', SYNTHETIC_ICBC_HTML, '<td>900.00/RMB</td>', '<td>100.50/JPY</td>'],
  ['abc', SYNTHETIC_ABC_HTML, '<td>900.00/CNY</td>', '<td>100.50/JPY</td>'],
  ['bocom', SYNTHETIC_BOCOM_HTML, '<td>CNY 900.00</td>', '<td>JPY 100.50</td>'],
  ['citic', SYNTHETIC_CITIC_HTML, '<td>CNY -10000.00</td>', '<td>JPY 100.50</td>'],
] as const

describe('real parser → ingest → persistence financial integrity', () => {
  beforeEach(async () => { await db.delete(); await db.open() })

  it.each(BANK_CASES)('%s: invalid original precision aborts rather than losing or fabricating a row', async (_bank, source, before, after) => {
    await importHtml(source, 'valid-source')
    const snapshot = await readSnapshot()
    await setReviewNote(snapshot.transactions[0]!.id, 'Synthetic retained review note')
    const changed = source.replace(before, after)
    expect(changed).not.toBe(source)
    await expect(importHtml(changed, 'invalid-source')).rejects.toThrow(/金额|精度/)
    expect(await readSnapshot()).toEqual(snapshot)
    expect((await db.reviewNotes.toArray())[0]!.note).toBe('Synthetic retained review note')
  })

  it.each(BANK_CASES)('%s: invalid settlement text cannot fall back to original money', async (bank, source, before) => {
    const start = source.indexOf(before)
    let nextCellStart = source.indexOf('<td>', start + before.length)
    if (bank === 'ccb') nextCellStart = source.indexOf('<td>', source.indexOf('</td>', nextCellStart) + 5)
    const nextCellEnd = source.indexOf('</td>', nextCellStart) + 5
    const changed = source.slice(0, nextCellStart) + '<td>10..25</td>' + source.slice(nextCellEnd)
    await expect(importHtml(changed, 'invalid-settlement')).rejects.toThrow(/金额|精度/)
    expect(await db.transactions.count()).toBe(0)
    expect(await db.statements.count()).toBe(0)
  })

  it('CCB: conflicting original currency cannot become 10000 JPY in a reconciled statement', async () => {
    const changed = SYNTHETIC_CCB_HTML.replace('<td>CNY</td><td>900.00</td>', '<td>JPY</td><td>CNY 100.00</td>')
    await expect(importHtml(changed, 'currency-conflict')).rejects.toThrow('金额')
    expect(await db.transactions.count()).toBe(0)
  })

  it('CCB: a conflicting negative original leg is saved with its source sign for review', async () => {
    const changed = SYNTHETIC_CCB_HTML.replace('<td>CNY</td><td>900.00</td>', '<td>CNY</td><td>CNY -900.00</td>')
    const { parsed, result } = await importHtml(changed, 'direction-conflict')
    expect(await db.transactions.count()).toBe(parsed.transactions.length)
    expect((await db.transactions.toArray()).find(row => row.rawDescription === '商户分期-示例通讯-分3期'))
      .toMatchObject({ transactionAmountMinor: -90000, settlementAmountMinor: 90000, direction: 'debit', reviewStatus: 'pending',
        flags: expect.arrayContaining(['amount_direction_unclear']), rawText: expect.stringContaining('CNY -900.00') })
    expect(result.statement!.status).toBe('needs_review')
  })

  it.each(['CNY -3000.00', 'CNY (3000.00)'])('CCB: %s remains negative credit after persistence', async (amount) => {
    const changed = SYNTHETIC_CCB_HTML.replaceAll('<td>-3000.00</td>', `<td>${amount}</td>`)
    const { parsed, result } = await importHtml(changed, 'signed-source')
    expect(parsed.transactions).toHaveLength(14)
    expect(result.statement!.status).toBe('reconciled')
    expect((await db.transactions.toArray()).find((tx) => tx.type === 'payment'))
      .toMatchObject({ transactionAmountMinor: -300000, settlementAmountMinor: -300000, direction: 'credit' })
  })

  it('ICBC: a parsed minus survives when no structured direction is provided', async () => {
    const changed = SYNTHETIC_ICBC_HTML.replace('<td>3000.00/RMB</td><td>3000.00/RMB(存入)</td>', '<td>CNY -3000.00/RMB</td><td>CNY (3000.00)/RMB</td>')
    await importHtml(changed, 'icbc-signed')
    expect((await db.transactions.toArray()).find((tx) => tx.type === 'payment'))
      .toMatchObject({ transactionAmountMinor: -300000, settlementAmountMinor: -300000, direction: 'credit' })
  })

  it('CITIC: parenthesized prefixed credit is not omitted or turned positive', async () => {
    const changed = SYNTHETIC_CITIC_HTML.replaceAll('CNY -10000.00', 'CNY (10000.00)')
    const { parsed } = await importHtml(changed, 'citic-signed')
    expect(parsed.transactions).toHaveLength(5)
    expect((await db.transactions.toArray()).find((tx) => tx.type === 'payment'))
      .toMatchObject({ transactionAmountMinor: -1000000, settlementAmountMinor: -1000000, direction: 'credit' })
  })

  it('BOC PDF: a recognized malformed amount row aborts instead of disappearing', async () => {
    const pdf = buildSyntheticBocPdf()
    const amount = pdf.pages[1]!.items.find((item) => item.text === '1000.00' && item.x > 500)!
    amount.text = '10..25'
    const doc: SourceDocument = { fileName: 'synthetic.pdf', fileHash: 'invalid-pdf', fileSize: 1, sourceType: 'pdf', pdf,
      html: null, tables: [], text: pdfToText(pdf), email: null }
    await expect((async () => {
      const parsed = bocParser.parse(doc)
      const result = ingestParsedStatement(parsed, { fileName: doc.fileName, fileHash: doc.fileHash, fileSize: 1, sourceType: 'pdf' }, await readSnapshot())
      await persistImportResults([result])
    })()).rejects.toThrow('金额')
    expect(await db.transactions.count()).toBe(0)
  })
})

describe('persisting optional summary fields', () => {
  beforeEach(async () => { await db.delete(); await db.open() })

  it('upgrades a legacy summary when the incoming parser adds adjustment and detail basis', async () => {
    const stored = demoImportWithSummary()
    delete stored.statement!.summary.adjustmentMinor
    delete stored.statement!.summary.detailBasis
    await persistImportResults([stored])

    await persistImportResults([summaryOnlyReimport(stored, { adjustmentMinor: 0, detailBasis: 'net' })])

    const upgraded = await db.statements.get(stored.statement!.id)
    expect(upgraded?.summary.adjustmentMinor).toBe(0)
    expect(upgraded?.summary.detailBasis).toBe('net')
  })

  it('rejects a changed adjustment when the stored summary has one', async () => {
    const stored = demoImportWithSummary({ adjustmentMinor: 30, detailBasis: 'gross' })
    await persistImportResults([stored])

    await expect(
      persistImportResults([summaryOnlyReimport(stored, { adjustmentMinor: 50 })]),
    ).rejects.toThrow('同一账期的银行汇总存在冲突')
  })

  it('rejects a changed detail basis when the stored summary has one', async () => {
    const stored = demoImportWithSummary({ adjustmentMinor: 0, detailBasis: 'gross' })
    await persistImportResults([stored])

    await expect(
      persistImportResults([summaryOnlyReimport(stored, { detailBasis: 'net' })]),
    ).rejects.toThrow('同一账期的银行汇总存在冲突')
  })
})
