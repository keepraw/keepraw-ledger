import { fireEvent, render, screen, cleanup } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { Statement, Transaction } from '../src/core/types'
import { TransactionsPage, sortTransactions } from '../src/ui/pages/TransactionsPage'
import { ReviewPage } from '../src/ui/pages/ReviewPage'
import { ingestSynthetic } from './fixtures/identity'

const app = vi.hoisted(() => ({
  visibleTransactions: [] as Transaction[], visibleStatements: [] as Statement[],
  updateTransaction: vi.fn(), saveNote: vi.fn(), refresh: vi.fn(), state: { demoMode: false, notes: {} },
}))
vi.mock('../src/app/AppStore', () => ({ useApp: () => app }))
afterEach(cleanup)

it('renders the same normalized description and raw tooltip in Transactions and both Review tables', () => {
  const result = ingestSynthetic(['网上消费 支付宝，合成 A-B (HK)'])
  app.visibleTransactions = result.transactions
  app.visibleStatements = [result.statement!]
  const before = structuredClone(result.transactions)
  render(<TransactionsPage />)
  const cell = screen.getByText('支付宝-合成 A-B (HK)')
  expect(cell).toHaveAttribute('title', expect.stringContaining('原始：网上消费 支付宝，合成 A-B (HK)'))
  for (const query of ['支付宝-合成', '网上消费 支付宝', result.transactions[0]!.merchant]) {
    fireEvent.change(screen.getByTestId('transaction-search'), { target: { value: query } })
    expect(screen.getByText('支付宝-合成 A-B (HK)')).toBeVisible()
  }
  cleanup()
  render(<ReviewPage />)
  expect(screen.getByText('支付宝-合成 A-B (HK)')).toHaveAttribute('title', '网上消费 支付宝，合成 A-B (HK)')
  fireEvent.click(screen.getByRole('button', { name: /交易复核/ }))
  expect(screen.getByText('支付宝-合成 A-B (HK)')).toHaveAttribute('title', '网上消费 支付宝，合成 A-B (HK)')
  expect(result.transactions).toEqual(before)
  expect(app.updateTransaction).not.toHaveBeenCalled()
})

it('shows and searches manual values exactly, and sorts by displayed descriptions', () => {
  const result = ingestSynthetic(['网上消费 Zebra', '消费 Alpha'])
  app.visibleTransactions = result.transactions
  app.visibleStatements = [result.statement!]
  expect(sortTransactions(result.transactions, 'description', 'asc').map(tx => tx.rawDescription)).toEqual(['消费 Alpha', '网上消费 Zebra'])
  app.visibleTransactions = [{ ...result.transactions[0]!, description: '消费 我的描述-A:01', merchant: '我的商户', category: '教育' }]
  render(<TransactionsPage />)
  expect(screen.getByText('消费 我的描述-A:01')).toBeVisible()
  fireEvent.change(screen.getByTestId('transaction-search'), { target: { value: '我的商户' } })
  expect(screen.getByText('消费 我的描述-A:01')).toBeVisible()
  expect(screen.getByRole('combobox', { name: '消费 我的描述-A:01 分类' })).toHaveValue('教育')
})
