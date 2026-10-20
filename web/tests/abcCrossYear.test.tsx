import { beforeEach, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { resolveAbcDate, abcParser } from '../src/parsers/abc'
import { buildSourceDocument } from '../src/parsers/extract'
import { parseDocument } from '../src/parsers/registry'
import { ingestParsedStatement } from '../src/core/ingest'
import { db } from '../src/db/db'
import { persistImportResults, readSnapshot } from '../src/db/repository'
import { DashboardPage } from '../src/ui/pages/DashboardPage'
import type { Statement, Transaction } from '../src/core/types'
import { CROSS_YEAR_ABC_HTML } from './fixtures/abcEml'

const app = vi.hoisted(() => ({ visibleTransactions: [] as Transaction[], visibleStatements: [] as Statement[], state: { demoMode: false } }))
vi.mock('../src/app/AppStore', () => ({ useApp: () => app }))
const cycle = { start: '2025-12-15', end: '2026-01-14' }
beforeEach(async () => { await db.delete(); await db.open() })

it.each([
  ['1220', '2025-12-20'], ['12/20', '2025-12-20'], ['12.20', '2025-12-20'],
  ['1215', '2025-12-15'], ['12/31', '2025-12-31'], ['0101', '2026-01-01'], ['01/14', '2026-01-14'],
])('resolves %s from the cycle without guessing the end year', (raw, expected) => {
  expect(resolveAbcDate(raw, cycle)).toBe(expected)
})

it.each([
  ['02/29', { start: '2024-02-15', end: '2024-03-14' }, '2024-02-29'],
  ['0229', { start: '2025-02-15', end: '2025-03-14' }, null],
  ['02/30', cycle, null], ['12/20', { start: null, end: null }, null],
  ['1220', { start: null, end: '2026-01-14' }, null],
  ['12/20', { start: '2024-12-01', end: '2026-01-14' }, null],
  ['12/20', { start: '2026-01-14', end: '2025-12-15' }, null],
])('validates calendar and unique cycle evidence for %s', (raw, period, expected) => {
  expect(resolveAbcDate(raw, period)).toBe(expected)
})

async function parse(html = CROSS_YEAR_ABC_HTML) {
  const doc = await buildSourceDocument({ fileName: 'synthetic-cross-year.html', buffer: new TextEncoder().encode(html).buffer, fileHash: 'abc-cross-year' })
  return parseDocument(doc, abcParser)
}

it('accepts a posting just after the cycle across New Year, but rejects unresolved nonempty posting dates', async () => {
  const html = CROSS_YEAR_ABC_HTML.replace('2025/12/15-2026/01/14', '2025/12/01-2025/12/31')
    .replace('12/20', '1231').replace('1221', '01/02')
    .replace('0105', '12/30').replace('01/06', '1231')
  const parsed = await parse(html)
  expect(parsed.transactions[0]!.postingDate).toBe('2026-01-02')
  await expect(parse(html.replace('01/02', '02/30'))).rejects.toThrow(/交易行/)
  await expect(parse(html.replace('01/02', '01/20'))).rejects.toThrow(/交易行/)
  await expect(parse(CROSS_YEAR_ABC_HTML.replace('2025/12/15-2026/01/14', '未提供'))).rejects.toThrow(/交易行/)
})

it('persists both dates, keeps repeat identity and renders Dashboard year/month totals from the complete parse chain', async () => {
  const parsed = await parse()
  expect(parsed.transactions.map(tx => [tx.transactionDate, tx.postingDate])).toEqual([
    ['2025-12-20', '2025-12-21'], ['2026-01-05', '2026-01-06'],
  ])
  const source = { fileName: 'synthetic-cross-year.html', fileHash: 'abc-cross-year', fileSize: 1, sourceType: 'html' as const }
  const result = ingestParsedStatement(parsed, source, await readSnapshot())
  await persistImportResults([result])
  const snapshot = await readSnapshot()
  expect(snapshot.transactions.map(tx => tx.transactionDate).sort()).toEqual(['2025-12-20', '2026-01-05'])
  expect(snapshot.transactions.map(tx => tx.postingDate).sort()).toEqual(['2025-12-21', '2026-01-06'])
  expect(ingestParsedStatement(parsed, source, snapshot).record.status).toBe('duplicate')
  const equivalent = await parse(CROSS_YEAR_ABC_HTML.replace('12/20', '1220').replace('0105', '01/05'))
  expect(ingestParsedStatement(equivalent, { ...source, fileHash: 'equivalent-format' }, snapshot).inserted).toHaveLength(0)
  app.visibleTransactions = snapshot.transactions
  app.visibleStatements = snapshot.statements
  render(<DashboardPage />)
  expect(screen.getByRole('group', { name: '2025-12，消费金额 100.00 元，退款金额 0.00 元' })).toBeInTheDocument()
  expect(screen.getByRole('group', { name: '2026-01，消费金额 200.00 元，退款金额 0.00 元' })).toBeInTheDocument()
})
