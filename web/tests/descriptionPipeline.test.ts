import { expect, it } from 'vitest'
import { ingestParsedStatement } from '../src/core/ingest'
import { transactionDisplayDescription } from '../src/core/descriptionNormalizer'
import { buildSourceDocument, pdfToText } from '../src/parsers/extract'
import { detectParser, parseDocument } from '../src/parsers/registry'
import type { SourceDocument } from '../src/parsers/types'
import { buildSyntheticBocPdf } from './fixtures/bocPdf'
import { SYNTHETIC_CCB_HTML } from './fixtures/ccbEml'
import { SYNTHETIC_ICBC_HTML } from './fixtures/icbcEml'
import { SYNTHETIC_ABC_HTML } from './fixtures/abcEml'
import { SYNTHETIC_BOCOM_HTML } from './fixtures/bocomEml'
import { SYNTHETIC_CITIC_HTML } from './fixtures/citicEml'
import { EMPTY_SNAPSHOT } from './fixtures/identity'

const sources = { abc: SYNTHETIC_ABC_HTML, icbc: SYNTHETIC_ICBC_HTML, ccb: SYNTHETIC_CCB_HTML,
  bocom: SYNTHETIC_BOCOM_HTML, citic: SYNTHETIC_CITIC_HTML }
const raw = '网上消费 支付宝，合成 A-B (HK)'

it.each(['boc', 'abc', 'icbc', 'ccb', 'bocom', 'citic'] as const)('%s: real parser → ingest → display preserves source, identity, money and duplicate occurrences', async bank => {
  let doc: SourceDocument
  if (bank === 'boc') {
    const pdf = buildSyntheticBocPdf()
    for (const page of pdf.pages) for (const item of page.items) {
      if (item.text === '示例超市-东门店') item.text = raw
    }
    doc = { fileName: 'synthetic.pdf', fileHash: 'synthetic', fileSize: 1, sourceType: 'pdf', pdf,
      html: null, tables: [], text: pdfToText(pdf), email: null }
  } else {
    // Replace one known merchant cell, leaving dates, money, sections and bank type tokens intact.
    const target = bank === 'abc' ? '网上消费 示例商城' : bank === 'bocom' ? '消费 财付通-示例商城' : bank === 'citic' ? '支付宝－示例商城' : '示例商城'
    expect(sources[bank]).toContain(target)
    doc = await buildSourceDocument({ fileName: 'synthetic.html', fileHash: 'synthetic',
      buffer: new TextEncoder().encode(sources[bank].replace(target, raw)).buffer })
  }
  const parsed = parseDocument(doc, detectParser(doc)!.parser)
  const first = ingestParsedStatement(parsed, { fileName: doc.fileName, fileHash: 'one', fileSize: 1, sourceType: doc.sourceType }, EMPTY_SNAPSHOT)
  const row = first.transactions.find(tx => tx.rawDescription === raw)!
  expect(row).toBeDefined()
  const before = structuredClone(first)
  expect(transactionDisplayDescription(row)).toBe('支付宝-合成 A-B (HK)')
  expect(row.merchant).toBe('支付宝-合成 A-B (HK)')
  expect(row).toMatchObject({ description: raw, rawDescription: raw, type: 'purchase', direction: 'debit' })
  expect(first).toEqual(before)
  const repeat = ingestParsedStatement(parsed, { fileName: 'repacked', fileHash: 'two', fileSize: 1, sourceType: doc.sourceType }, {
    imports: [], statements: [first.statement!], transactions: first.transactions,
  })
  expect(repeat.inserted).toEqual([])
  expect(repeat.skippedDuplicates.map(tx => [tx.id, tx.fingerprint, tx.occurrence, tx.settlementAmountMinor])).toEqual(
    first.transactions.map(tx => [tx.id, tx.fingerprint, tx.occurrence, tx.settlementAmountMinor]))
  expect(repeat.statement?.reconciliation).toEqual(first.statement?.reconciliation)
})
