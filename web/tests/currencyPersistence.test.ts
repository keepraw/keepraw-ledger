import { beforeEach, expect, it } from 'vitest'
import { db } from '../src/db/db'
import { readSnapshot, persistImportResults } from '../src/db/repository'
import { ingestParsedStatement } from '../src/core/ingest'
import { parseAmountToMinor } from '../src/core/money'
import { detectParser, parseDocument } from '../src/parsers/registry'
import { buildSourceDocument } from '../src/parsers/extract'
import { parseLegacyAmount } from '../src/importers/legacyPythonExportV1'
import { SYNTHETIC_CCB_HTML } from './fixtures/ccbEml'
import { SYNTHETIC_ICBC_HTML } from './fixtures/icbcEml'
import { SYNTHETIC_ABC_HTML } from './fixtures/abcEml'
import { SYNTHETIC_BOCOM_HTML } from './fixtures/bocomEml'
import { SYNTHETIC_CITIC_HTML } from './fixtures/citicEml'

beforeEach(async () => { await db.delete(); await db.open() })

const CASES = [
  ['ccb', SYNTHETIC_CCB_HTML, /<td>CNY<\/td><td>-?[\d,.]+<\/td>/, '<td>JPY</td><td>-100.00</td>'],
  ['icbc', SYNTHETIC_ICBC_HTML, /<td>3000\.00\/RMB<\/td>/, '<td>100.00/JPY</td>'],
  ['abc', SYNTHETIC_ABC_HTML, /<td>[\d,.]+\/CNY<\/td>/, '<td>100.00/JPY</td>'],
  ['bocom', SYNTHETIC_BOCOM_HTML, /<td>CNY [\d,.]+<\/td>/, '<td>JPY 100.00</td>'],
  ['citic', SYNTHETIC_CITIC_HTML, /<td>CNY -10000\.00<\/td>/, '<td>JPY -100.00</td>'],
] as const

it.each(CASES)('%s: preserves signed zero-decimal original money through real parser, ingest and IndexedDB', async (bank, source, pattern, replacement) => {
  async function parse(html: string) {
    const buffer = new TextEncoder().encode(html).buffer
    const doc = await buildSourceDocument({ fileName: 'synthetic.html', buffer, fileHash: `synthetic-${bank}` })
    const match = detectParser(doc)
    expect(match?.parser.bank).toBe(bank)
    return parseDocument(doc, match!.parser)
  }
  const baseline = await parse(source)
  const altered = source.replace(pattern, replacement)
  expect(altered).not.toBe(source)
  const parsed = await parse(altered)
  expect(parsed.transactions).toHaveLength(baseline.transactions.length)
  const foreign = parsed.transactions.find((row) => row.transactionCurrency === 'JPY')
  expect(foreign).toBeDefined()
  expect(Math.abs(foreign!.transactionAmountMinor)).toBe(100)
  const result = ingestParsedStatement(parsed, { fileName: 'synthetic.html', fileHash: `synthetic-${bank}`, fileSize: 1, sourceType: 'html' }, await readSnapshot())
  await persistImportResults([result])
  const stored = (await db.transactions.toArray()).find((row) => row.transactionCurrency === 'JPY')!
  expect(stored.transactionAmountMinor).toBe(foreign!.transactionAmountMinor)
  expect(stored.settlementAmountMinor).toBe(foreign!.settlementAmountMinor)
  expect(stored.direction).toBe(foreign!.direction)
  expect(await db.transactions.count()).toBe(baseline.transactions.length)
})

it('keeps currency-prefixed negative and parenthesized signs and exact numeric currency units', () => {
  expect(parseAmountToMinor('CNY -10.25')?.minor).toBe(-1025)
  expect(parseAmountToMinor('JPY (100.00)')?.minor).toBe(-100)
  expect(parseAmountToMinor(100, 'JPY')?.minor).toBe(100)
  expect(parseAmountToMinor(1.5, 'JPY')).toBeNull()
  expect(parseLegacyAmount('USD -10.25', 'USD')).toBe(-1025)
  expect(parseLegacyAmount('CNY (10.25)', 'CNY')).toBe(-1025)
})

it('fails an unsupported native currency before partial import instead of guessing precision', async () => {
  const html = SYNTHETIC_CCB_HTML.replace(/<td>CNY<\/td><td>-?[\d,.]+<\/td>/, '<td>KWD</td><td>100.00</td>')
  const doc = await buildSourceDocument({ fileName: 'synthetic.html', buffer: new TextEncoder().encode(html).buffer, fileHash: 'unsupported-currency' })
  const match = detectParser(doc)!
  expect(() => parseDocument(doc, match.parser)).toThrow('货币精度')
  expect(await db.transactions.count()).toBe(0)
})
