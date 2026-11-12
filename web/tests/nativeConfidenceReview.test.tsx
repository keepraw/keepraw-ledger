import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { ReviewPage } from '../src/ui/pages/ReviewPage'
import type { Transaction } from '../src/core/types'
import { planLegacyImport, previewLegacyWorkbook } from '../src/importers/legacyImport'
import { ingestParsedStatement } from '../src/core/ingest'
import { bocParser } from '../src/parsers/boc'
import { pdfToText } from '../src/parsers/extract'
import { buildSyntheticBocPdf } from './fixtures/bocPdf'
import { EMPTY_SNAPSHOT } from './fixtures/identity'
import { nativeCells, nativeWorkbook } from './fixtures/nativeLedger'

const app = vi.hoisted(() => ({ visibleTransactions: [] as Transaction[], visibleStatements: [],
  state: { demoMode: false, notes: {} }, updateTransaction: vi.fn(), saveNote: vi.fn() }))
vi.mock('../src/app/AppStore', () => ({ useApp: () => app }))

it('reviews pending and genuine flags while preserving every exported native decision', async () => {
  const statuses = ['ok', 'confirmed', 'pending', 'rejected'] as const
  const rows = statuses.map((status, index) => { const row = nativeCells(index + 1); row[12] = status; return row })
  const preview = await previewLegacyWorkbook(nativeWorkbook(rows),
    { fileName: 'synthetic.xlsx', fileHash: 'synthetic', fileSize: 1 }, EMPTY_SNAPSHOT)
  const native = planLegacyImport(preview, EMPTY_SNAPSHOT).inserted
  expect(native.map(tx => tx.reviewStatus)).toEqual(statuses)
  expect(native.every(tx => tx.confidence === 0 && tx.flags.length === 0)).toBe(true)
  expect(preview.reviewIssues).toHaveLength(1)
  expect(preview.reviewIssues![0]!.detail).toContain('不触发逐笔复核')
  const duplicate: Transaction = { ...native[0]!, id: 'synthetic-duplicate', flags: ['suspected_duplicate'] }

  // Exercise the real bank parser's fallback confidence, then the normal ingestion path.
  const pdf = buildSyntheticBocPdf()
  pdf.pages[1]!.items = pdf.pages[1]!.items.filter(item => item.x < 290 || item.x >= 420)
  const parsed = bocParser.parse({ fileName: 'synthetic.pdf', fileHash: 'bank', fileSize: 1,
    sourceType: 'pdf', pdf, text: pdfToText(pdf), html: null, tables: [], email: null })
  expect(parsed.transactions.some(tx => tx.confidence < 0.8)).toBe(true)
  const bank = ingestParsedStatement(parsed, { fileName: 'synthetic.pdf', fileHash: 'bank', fileSize: 1,
    sourceType: 'pdf' }, EMPTY_SNAPSHOT).transactions.find(tx => tx.flags.includes('low_confidence'))!
  expect(bank).toBeDefined()
  app.visibleTransactions = [...native, duplicate, bank]
  render(<ReviewPage />)
  fireEvent.click(screen.getByRole('button', { name: '交易复核 3' }))
  expect(screen.getByTestId('review-table').querySelectorAll(':scope > tbody > tr')).toHaveLength(3)
  expect(screen.getByTestId('review-table')).toHaveTextContent('解析置信度低')
  expect(screen.getByTestId('review-table')).toHaveTextContent('疑似重复')
  expect(native[3]!.reviewStatus).toBe('rejected')
})
