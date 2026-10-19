import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '../src/db/db'
import { persistImportResults, readSnapshot } from '../src/db/repository'
import { ingestParsedStatement } from '../src/core/ingest'
import { ccbParser } from '../src/parsers/ccb'
import { abcParser } from '../src/parsers/abc'
import { bocomParser } from '../src/parsers/bocom'
import { icbcParser } from '../src/parsers/icbc'
import { citicParser } from '../src/parsers/citic'
import { extractTables, extractText, sanitizeHtml } from '../src/parsers/html'
import type { BankParser, SourceDocument } from '../src/parsers/types'
import { SYNTHETIC_CCB_HTML } from './fixtures/ccbEml'
import { SYNTHETIC_ABC_HTML } from './fixtures/abcEml'
import { SYNTHETIC_BOCOM_HTML } from './fixtures/bocomEml'
import { SYNTHETIC_ICBC_HTML } from './fixtures/icbcEml'
import { SYNTHETIC_CITIC_HTML } from './fixtures/citicEml'

beforeEach(async () => { await db.delete(); await db.open() })
function doc(html: string): SourceDocument {
  const safe = sanitizeHtml(html)
  return { fileName: 'synthetic.html', fileSize: 1, fileHash: 'synthetic', sourceType: 'html', html: safe,
    tables: extractTables(safe), text: extractText(safe), pdf: null, email: null }
}
const cases: Array<{ parser: BankParser; html: string; description: number; date: number; invalidDate: string; marker: string }> = [
  { parser: ccbParser, html: SYNTHETIC_CCB_HTML, description: 3, date: 0, invalidDate: '2026-13-99', marker: 'The End' },
  { parser: abcParser, html: SYNTHETIC_ABC_HTML, description: 3, date: 0, invalidDate: '1399', marker: '积分' },
  { parser: bocomParser, html: SYNTHETIC_BOCOM_HTML, description: 4, date: 1, invalidDate: '13/99', marker: '风险提示' },
  { parser: icbcParser, html: SYNTHETIC_ICBC_HTML, description: 4, date: 1, invalidDate: '2026-13-99', marker: '工银i豆' },
  { parser: citicParser, html: SYNTHETIC_CITIC_HTML, description: 4, date: 0, invalidDate: '20261399', marker: '征信' },
]
function restaurant(source: SourceDocument) {
  return source.tables.flatMap(table => table.rows).find(row => row.some(cell => /示例餐厅/.test(cell)))!
}

describe('AUD-008 format-specific transaction completeness', () => {
  for (const entry of cases) {
    const { parser, html, description, date, invalidDate, marker } = entry
    it.each([marker, '违约金', 'The End', '合计'])(`${parser.bank}: preserves a merchant containing %s and all subsequent rows`, () => {
      const source = doc(html), baseline = parser.parse(doc(html))
      restaurant(source)[description] = `消费 合成门店 ${marker} 违约金 The End 合计`
      const parsed = parser.parse(source)
      expect(parsed.transactions).toHaveLength(baseline.transactions.length)
      expect(parsed.transactions.map(row => row.sourceRow)).toEqual(baseline.transactions.map(row => row.sourceRow))
      expect(parsed.transactions.find(row => row.description.includes('合成门店'))).toMatchObject({ direction: 'debit', settlementAmountMinor: 6800 })
    })
    it(`${parser.bank}: rejects a recognized row with an invalid transaction date`, () => {
      const source = doc(html)
      restaurant(source)[date] = invalidDate
      expect(() => parser.parse(source)).toThrow(/交易行|交易日期/)
    })
    it(`${parser.bank}: rejects a truncated transaction instead of silently dropping it`, () => {
      const source = doc(html)
      restaurant(source).pop()
      expect(() => parser.parse(source)).toThrow(/交易行|交易金额/)
    })
  }
  it('CCB: retains all 17 rows including the three USD rows outside the CNY bank total', async () => {
    const row = (description: string) => `<tr><td>2026-08-10</td><td>2026-08-10</td><td>5678</td><td>消费 ${description}</td><td>USD</td><td>10.00</td><td>USD</td><td>10.00</td></tr>`
    const html = SYNTHETIC_CCB_HTML.replace('<tr><td>*** 结束 The End ***</td></tr>', ['audit before', 'The End Store', 'audit after'].map(row).join('') + '<tr><td>*** 结束 The End ***</td></tr>')
    const parsed = ccbParser.parse(doc(html))
    expect(parsed.transactions).toHaveLength(17)
    const result = ingestParsedStatement(parsed, { fileName: 'synthetic.html', fileHash: 'usd', fileSize: 1, sourceType: 'html' }, await readSnapshot())
    await persistImportResults([result])
    const snapshot = await readSnapshot()
    expect(snapshot.transactions).toHaveLength(17)
    expect(snapshot.transactions.filter(row => row.settlementCurrency === 'USD').map(row => row.settlementAmountMinor)).toEqual([1000, 1000, 1000])
    expect(result.record.message).toContain('其他币种')
    const duplicate = ingestParsedStatement(parsed, { fileName: 'synthetic.html', fileHash: 'usd', fileSize: 1, sourceType: 'html' }, snapshot)
    await persistImportResults([duplicate])
    expect(await db.transactions.count()).toBe(17)
  })
  it('BOCOM: a repeated header inside the repayment table cannot switch later credits into debits', () => {
    const source = doc(SYNTHETIC_BOCOM_HTML)
    const table = source.tables.find(table => table.rows.some(row => /信用卡还款/.test(row.join(' '))))!
    table.rows.splice(3, 0, [...table.rows[1]!])
    const parsed = bocomParser.parse(source)
    expect(parsed.transactions.filter(row => row.direction === 'credit')).toHaveLength(3)
    expect(parsed.transactions).toHaveLength(14)
  })
})
