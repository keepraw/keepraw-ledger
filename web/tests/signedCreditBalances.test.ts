import { beforeEach, describe, expect, it } from 'vitest'
import { buildSourceDocument } from '../src/parsers/extract'
import { detectParser, parseDocument } from '../src/parsers/registry'
import { ingestParsedStatement } from '../src/core/ingest'
import { db } from '../src/db/db'
import { persistImportResults, readSnapshot } from '../src/db/repository'
import { SYNTHETIC_CCB_HTML } from './fixtures/ccbEml'
import { SYNTHETIC_ICBC_HTML } from './fixtures/icbcEml'
import { SYNTHETIC_CITIC_HTML } from './fixtures/citicEml'

// Each mutation follows that bank's own documented table, not a shared template.
const cases = [
  { bank: 'ccb', previous: 300000, debit: 650000, credit: 720000, source: SYNTHETIC_CCB_HTML,
    signed: (previous: number, current: number) => SYNTHETIC_CCB_HTML
      .replace('<td>3000.00</td><td>6500.00</td>', `<td>${previous.toFixed(2)}</td><td>6500.00</td>`)
      .replaceAll('<td>2300.00</td>', `<td>${current.toFixed(2)}</td>`) },
  { bank: 'icbc', previous: 500000, debit: 410000, credit: 325000, source: SYNTHETIC_ICBC_HTML,
    signed: (previous: number, current: number) => SYNTHETIC_ICBC_HTML
      .replaceAll('<td>5000.00</td><td>3250.00</td>', `<td>${previous.toFixed(2)}</td><td>3250.00</td>`)
      .replaceAll('<td>5850.00</td>', `<td>${current.toFixed(2)}</td>`) },
  { bank: 'citic', previous: 1000000, debit: 210000, credit: 1000000, source: SYNTHETIC_CITIC_HTML,
    signed: (previous: number, current: number) => SYNTHETIC_CITIC_HTML
      .replace('<td>CNY 2100.00</td>', `<td>CNY ${current.toFixed(2)}</td>`)
      .replace('<td>10000.00</td><td></td><td>10000.00</td>', `<td>${previous.toFixed(2)}</td><td></td><td>10000.00</td>`)
      .replace('<td>2100.00</td><td></td><td>2100.00</td>', `<td>2100.00</td><td></td><td>${current.toFixed(2)}</td>`) },
] as const

beforeEach(async () => { await db.delete(); await db.open() })
async function parse(source: string) {
  const doc = await buildSourceDocument({ fileName: 'synthetic-signed.html', fileHash: 'signed', buffer: new TextEncoder().encode(source).buffer })
  return parseDocument(doc, detectParser(doc)!.parser)
}
async function ingest(source: string, hash: string) {
  return ingestParsedStatement(await parse(source), { fileName: 'synthetic-signed.html', fileHash: hash, fileSize: 1, sourceType: 'html' }, await readSnapshot())
}

for (const fixture of cases) describe(`AUD-010 ${fixture.bank} independent balance semantics`, () => {
  it('preserves explicit negative opening/current balances, equation, details and persistent review state', async () => {
    const previous = -fixture.previous
    const current = previous + fixture.debit - fixture.credit
    const result = await ingest(fixture.signed(previous / 100, current / 100), fixture.bank)
    expect(result.statement!.summary).toMatchObject({ previousBalanceMinor: previous, currentBalanceMinor: current,
      newDebitMinor: fixture.debit, newCreditMinor: fixture.credit })
    expect(result.statement!.reconciliation.status).toBe('passed')
    await persistImportResults([result])
    expect((await db.statements.toArray())[0]!.summary.previousBalanceMinor).toBe(previous)
    expect((await db.statements.toArray())[0]!.reconciliation.status).toBe('passed')
  })

  it('retains positive balances, normal purchases, credits and their original classifications', async () => {
    const baseline = await ingest(fixture.source, 'positive')
    expect(baseline.statement!.summary.previousBalanceMinor).toBe(fixture.previous)
    expect(baseline.statement!.reconciliation.status).toBe('passed')
    const signed = await ingest(fixture.signed(-fixture.previous / 100, (-fixture.previous + fixture.debit - fixture.credit) / 100), 'negative')
    expect(signed.transactions.map(tx => [tx.settlementAmountMinor, tx.type, tx.direction])).toEqual(
      baseline.transactions.map(tx => [tx.settlementAmountMinor, tx.type, tx.direction]))
  })

  it('carries credit balances across consecutive cycles without turning them into debt', async () => {
    const firstCurrent = -fixture.previous + fixture.debit - fixture.credit
    const first = await parse(fixture.signed(-fixture.previous / 100, firstCurrent / 100))
    const nextCurrent = firstCurrent + fixture.debit - fixture.credit
    const next = await parse(fixture.signed(firstCurrent / 100, nextCurrent / 100)
      .replaceAll('2026/07/15-2026/08/14', '2026/08/15-2026/09/14')
      .replaceAll('2026年07月15日', '2026年08月15日').replaceAll('2026年08月14日', '2026年09月14日'))
    expect(next.summary.previousBalanceMinor).toBe(first.summary.currentBalanceMinor)
    expect(next.summary.currentBalanceMinor).toBe(nextCurrent)
    expect(next.summary.previousBalanceMinor).toBeLessThan(0)
  })

  it('reports inconsistent signed balances honestly instead of changing signs to force a pass', async () => {
    const result = await ingest(fixture.signed(-fixture.previous / 100, (fixture.previous + fixture.debit - fixture.credit) / 100), 'mismatch')
    expect(result.statement!.summary.previousBalanceMinor).toBe(-fixture.previous)
    expect(result.statement!.reconciliation.status).toBe('mismatch')
    expect(result.statement!.status).toBe('needs_review')
    await persistImportResults([result])
    expect((await db.statements.toArray())[0]!.reconciliation.status).toBe('mismatch')
  })
})

it('CCB fallback New Balance also preserves the explicit credit sign and stays insufficient without an opening balance', async () => {
  const source = cases[0].signed(-3000, -3700).replace(/<table>\s*<tr><td>账户币种Currency<\/td><td>上期全部应还款额[\s\S]*?<\/table>/, '')
  const result = await ingest(source, 'ccb-fallback')
  expect(result.statement!.summary.currentBalanceMinor).toBe(-370000)
  expect(result.statement!.reconciliation.status).toBe('insufficient')
})

it('ICBC balance table fallback retains negative current balance without the payment overview', async () => {
  const source = cases[1].signed(-5000, -4150).replace(/<table>\s*<tr><td>卡号后四位<\/td><td>币种<\/td>[\s\S]*?<\/table>/, '')
  const result = await ingest(source, 'icbc-fallback')
  expect(result.statement!.summary.currentBalanceMinor).toBe(-415000)
  expect(result.statement!.reconciliation.status).toBe('passed')
})

it('CITIC equation fallback retains credit balance when total-payment overview is absent', async () => {
  const source = cases[2].signed(-10000, -17900).replace(/<table><tr><td>本期应还款总额[\s\S]*?<\/table>/, '')
  const result = await ingest(source, 'citic-fallback')
  expect(result.statement!.summary.currentBalanceMinor).toBe(-1790000)
  expect(result.statement!.summary.previousBalanceMinor).toBe(-1000000)
  expect(result.statement!.reconciliation.status).toBe('passed')
})
