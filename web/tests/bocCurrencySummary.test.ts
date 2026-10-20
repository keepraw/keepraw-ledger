import { beforeEach, expect, it } from 'vitest'
import { bocParser } from '../src/parsers/boc'
import { pdfToText } from '../src/parsers/extract'
import type { PdfDocument, SourceDocument } from '../src/parsers/types'
import { ingestParsedStatement } from '../src/core/ingest'
import { db } from '../src/db/db'
import { persistImportResults, readSnapshot } from '../src/db/repository'
import { bocCurrencyLayout } from './fixtures/bocCurrencyPdf'

function doc(pdf: PdfDocument): SourceDocument {
  return { fileName: 'synthetic-boc-currency.pdf', fileHash: 'boc-currency', fileSize: 1, sourceType: 'pdf', pdf, text: pdfToText(pdf), html: null, tables: [], email: null }
}
function result(pdf: PdfDocument) {
  return ingestParsedStatement(bocParser.parse(doc(pdf)), { fileName: 'synthetic-boc-currency.pdf', fileHash: 'boc-currency', fileSize: 1, sourceType: 'pdf' }, { statements: [], transactions: [], imports: [] })
}
beforeEach(async () => { await db.delete(); await db.open() })

it.each([
  ['USD', 'CNY', 'HKD'], ['HKD', 'USD', 'CNY'], ['CNY', 'HKD', 'USD'],
  ['USD', 'HKD', 'CNY'], ['CNY', 'USD', 'HKD'], ['HKD', 'CNY', 'USD'],
])('selects CNY by scope in summary order %s/%s/%s, retaining actual evidence currencies', (...currencies) => {
  const parsed = bocParser.parse(doc(bocCurrencyLayout(currencies)))
  expect(parsed.summary.components[0]!.currency).toBe('CNY')
  expect(new Set(parsed.summary.components.map(item => item.currency))).toEqual(new Set(['CNY', 'USD', 'HKD']))
  expect(result(bocCurrencyLayout(currencies)).statement!.reconciliation.status).toBe('passed')
})

it.each(['USD', 'HKD'])('never relabels %s as CNY or passes equal numbers against RMB details', async (currency) => {
  const imported = result(bocCurrencyLayout([currency]))
  expect(imported.statement!.summary.components.some(item => item.currency === 'CNY')).toBe(false)
  expect(imported.statement!.summary.components.some(item => item.currency === currency)).toBe(true)
  expect(imported.statement!.summary.currentBalanceMinor).toBeNull()
  expect(imported.statement!.reconciliation.status).toBe('insufficient')
  expect(imported.statement!.status).toBe('needs_review')
  await persistImportResults([imported])
  const stored = (await readSnapshot()).statements[0]!
  expect(stored.summary.components.every(item => item.currency === currency)).toBe(true)
  expect(stored.reconciliation.status).toBe('insufficient')
})

it('rejects ambiguous currency labels without borrowing the unrelated card overview', () => {
  const pdf = bocCurrencyLayout(['外币账户'])
  expect(result(pdf).statement!.reconciliation.status).toBe('insufficient')
  expect(result(pdf).statement!.summary.currentBalanceMinor).toBeNull()
})

it('does not use equal CNY numbers from a different account or merge duplicate account summaries', () => {
  const wrong = bocCurrencyLayout(['USD'], { secondAccount: true })
  expect(result(wrong).statement!.reconciliation.status).toBe('insufficient')
  const duplicate = bocCurrencyLayout(['CNY', 'CNY'])
  expect(result(duplicate).statement!.reconciliation.status).toBe('insufficient')
})

it('preserves USD transactions separately while reconciling only the matching CNY account', async () => {
  const imported = result(bocCurrencyLayout(['CNY', 'USD'], { foreignDetails: true }))
  expect(imported.transactions).toHaveLength(14)
  expect(imported.transactions.filter(tx => tx.settlementCurrency === 'USD')).toHaveLength(7)
  expect(imported.transactions.filter(tx => tx.settlementCurrency === 'CNY')).toHaveLength(7)
  expect(imported.statement!.reconciliation.status).toBe('passed')
  expect(imported.statement!.reconciliation.checks.find(check => check.id === 'other_currencies')!.status).toBe('skipped')
  await persistImportResults([imported])
  expect((await db.transactions.toArray()).filter(tx => tx.settlementCurrency === 'USD')).toHaveLength(7)
})


it('does not guess contradictory summary currency markers or inherit an unreadable account heading', () => {
  const contradictory = bocCurrencyLayout(['人民币/USD'])
  expect(result(contradictory).statement!.reconciliation.status).toBe('insufficient')
  const missingAccount = bocCurrencyLayout(['CNY'])
  missingAccount.pages[0]!.items = missingAccount.pages[0]!.items.map(item => item.text.includes('测试白金') ? { ...item, text: '测试白金信用卡(卡号：无法识别)' } : item)
  expect(result(missingAccount).statement!.reconciliation.status).toBe('insufficient')
})

it('keeps Hong Kong dollar details and their signed amounts without RMB conversion', () => {
  const imported = result(bocCurrencyLayout(['CNY', 'HKD'], { foreignDetails: true, foreignCurrency: 'HKD' }))
  const hkd = imported.transactions.filter(tx => tx.settlementCurrency === 'HKD')
  expect(hkd).toHaveLength(7)
  expect(hkd.map(tx => tx.settlementAmountMinor)).toEqual([4800, 15200, 100000, -300000, -100000, -100000, -60000])
  expect(imported.statement!.reconciliation.status).toBe('passed')
})

it('scopes the same layout when the extracted PDF row axis is reversed', () => {
  const pdf = bocCurrencyLayout(['USD', 'CNY', 'HKD'], { foreignDetails: true })
  pdf.pages = pdf.pages.map(page => ({ ...page, items: page.items.map(item => ({ ...item, y: page.height - item.y })) }))
  const imported = result(pdf)
  expect(imported.statement!.reconciliation.status).toBe('passed')
  expect(imported.transactions.filter(tx => tx.settlementCurrency === 'USD')).toHaveLength(7)
})


it('uses the CNY detail account instead of the first foreign card in the overview', () => {
  const pdf = bocCurrencyLayout(['USD', 'CNY'])
  pdf.pages[0]!.items.push({ text: '6259 0737 **** 9999', x: 34, y: 480, width: 78, height: 10 })
  const parsed = bocParser.parse(doc(pdf))
  expect(parsed.cardLast4).toBe('6505')
  expect(result(pdf).statement!.reconciliation.status).toBe('passed')
})
