import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { ReviewPage } from '../src/ui/pages/ReviewPage'
import { reviewBatchFixture } from './fixtures/reviewBatch'
import type { Transaction, Statement } from '../src/core/types'

const app = vi.hoisted(() => ({ visibleTransactions: [] as Transaction[], visibleStatements: [] as Statement[],
  state: { demoMode: false, notes: {} }, updateTransaction: vi.fn(), reviewTransactions: vi.fn(), saveNote: vi.fn() }))
vi.mock('../src/app/AppStore', () => ({ useApp: () => app }))
beforeEach(() => {
  vi.clearAllMocks()
  app.visibleTransactions = reviewBatchFixture(250).transactions
  app.visibleStatements = []
  app.state.demoMode = false
  app.state.notes = {}
})
it('bounds rendered rows, retains cross-page selection, confirms counts, and preserves selection on failure', async () => {
  app.reviewTransactions.mockRejectedValueOnce(new Error('synthetic atomic failure'))
  render(<ReviewPage />)
  fireEvent.click(screen.getByRole('button', { name: '交易复核 250' }))
  const table = screen.getByTestId('review-table')
  expect(table.querySelectorAll(':scope > tbody > tr')).toHaveLength(100)
  fireEvent.click(screen.getByRole('checkbox', { name: '全选当前页' }))
  expect(screen.getByTestId('review-selection-count')).toHaveTextContent('已选择 100 笔')
  const pagination = screen.getByRole('navigation', { name: '交易复核分页' })
  fireEvent.click(within(pagination).getByRole('button', { name: '下一页' }))
  expect(screen.getByTestId('review-selection-count')).toHaveTextContent('已选择 100 笔')
  fireEvent.click(screen.getByRole('button', { name: '全选全部待复核 250 笔' }))
  fireEvent.click(screen.getByRole('button', { name: /^批量确认$/ }))
  const dialog = screen.getByRole('dialog', { name: '批量确认交易' })
  expect(dialog).toHaveTextContent('250')
  expect(dialog).toHaveTextContent('清除疑似重复标记')
  fireEvent.click(within(dialog).getByRole('button', { name: '确定批量确认' }))
  await screen.findByText('synthetic atomic failure')
  expect(screen.getByTestId('review-selection-count')).toHaveTextContent('已选择 250 笔')
  expect(app.reviewTransactions).toHaveBeenCalledTimes(1)
  expect(app.updateTransaction).not.toHaveBeenCalled()
})

it('disables repeat submission while pending and resets selection when switching between demo and real modes', async () => {
  let resolve!: () => void
  app.reviewTransactions.mockImplementationOnce(() => new Promise<void>(done => { resolve = done }))
  const view = render(<ReviewPage />)
  fireEvent.click(screen.getByRole('button', { name: '交易复核 250' }))
  fireEvent.click(screen.getByRole('checkbox', { name: '全选当前页' }))
  fireEvent.click(screen.getByRole('button', { name: /^批量排除$/ }))
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '确定批量排除' }))
  expect(within(screen.getByRole('dialog')).getByRole('button', { name: '正在提交…' })).toBeDisabled()
  expect(screen.getByRole('checkbox', { name: '全选当前页' })).toBeDisabled()
  expect(app.reviewTransactions).toHaveBeenCalledTimes(1)
  resolve()
  await screen.findByRole('button', { name: /^批量确认$/ })
  // Wait for the async completion before selecting again.
  await vi.waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  fireEvent.click(screen.getByRole('checkbox', { name: '全选当前页' }))
  app.state.demoMode = true
  view.rerender(<ReviewPage />)
  expect(screen.getByTestId('review-selection-count')).toHaveTextContent('已选择 0 笔')
})

it('paginates statement lists, transaction details and review notes as well', () => {
  const fixture = reviewBatchFixture(250)
  app.visibleStatements = Array.from({ length: 250 }, (_, i) => ({ ...fixture.statements[0]!, id: `synthetic-statement-${i}`, status: 'needs_review' }))
  app.visibleTransactions = fixture.transactions.map(row => ({ ...row, statementId: 'synthetic-statement-0' }))
  app.state.notes = Object.fromEntries(fixture.notes.map(row => [row.transactionId, row.note]))
  render(<ReviewPage />)
  const statements = screen.getByRole('navigation', { name: '账单对账分页' })
  expect(statements).toHaveTextContent('第 1 / 3 页')
  expect(screen.getByRole('navigation', { name: '账单交易分页' })).toHaveTextContent('第 1 / 3 页')
  expect(screen.getByRole('navigation', { name: '复核备注分页' })).toHaveTextContent('第 1 / 3 页')
})
