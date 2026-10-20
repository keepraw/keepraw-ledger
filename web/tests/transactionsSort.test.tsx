import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TransactionsPage, sortTransactions } from '../src/ui/pages/TransactionsPage'
import type { Transaction } from '../src/core/types'
import { ingestSynthetic } from './fixtures/identity'

const app = vi.hoisted(() => ({ visibleTransactions: [] as Transaction[], updateTransaction: vi.fn(), state: { demoMode: false } }))
vi.mock('../src/app/AppStore', () => ({ useApp: () => app }))
const base = ingestSynthetic(['sort fixture']).transactions[0]!
const row = (id: string, amount: number, extra: Partial<Transaction> = {}): Transaction => ({
  ...base, id, description: id, transactionDate: '2025-01-01', settlementAmountMinor: amount, ...extra,
})
const ids = () => within(screen.getByTestId('transactions-table')).getAllByRole('row').slice(1).map(tr => tr.children[3]!.textContent)

describe('AUD-007 amount ordering', () => {
  it('renders numeric ascending and descending order, including stable duplicates, zero and safe integer boundaries', () => {
    app.visibleTransactions = [row('100', 10000), row('-2', -200), row('2a', 200), row('-100', -10000),
      row('30', 3000), row('zero', 0), row('2b', 200), row('max', Number.MAX_SAFE_INTEGER), row('min', Number.MIN_SAFE_INTEGER)]
    render(<TransactionsPage />)
    fireEvent.click(screen.getByText(/^金额[ ↑↓]*$/))
    expect(ids()).toEqual(['min', '-100', '-2', 'zero', '2a', '2b', '30', '100', 'max'])
    fireEvent.click(screen.getByText(/^金额[ ↑↓]*$/))
    expect(ids()).toEqual(['max', '100', '30', '2a', '2b', 'zero', '-2', '-100', 'min'])
  })

  it('keeps currency groups in code order in both directions, with historical date ties', () => {
    const rows = [row('usd-low', 1, { settlementCurrency: 'USD' }), row('cny-new', 100, { transactionDate: '2025-01-02' }),
      row('hkd', 100000, { settlementCurrency: 'HKD' }), row('cny-old', 100), row('usd-high', 2, { settlementCurrency: 'USD' })]
    expect(sortTransactions(rows, 'settlementAmountMinor', 'asc').map(tx => tx.id)).toEqual(['cny-old', 'cny-new', 'hkd', 'usd-low', 'usd-high'])
    expect(sortTransactions(rows, 'settlementAmountMinor', 'desc').map(tx => tx.id)).toEqual(['cny-old', 'cny-new', 'hkd', 'usd-high', 'usd-low'])
    expect(rows[0]!.id).toBe('usd-low')
  })

  it('sorts the whole filtered list before pagination and resets the page when sorting', () => {
    app.visibleTransactions = Array.from({ length: 55 }, (_, index) => row(`keep-${index}`, (54 - index) * 100))
    app.visibleTransactions.push(row('excluded', -10000))
    render(<TransactionsPage />)
    fireEvent.change(screen.getByTestId('transaction-search'), { target: { value: 'keep-' } })
    fireEvent.click(screen.getByText(/^金额[ ↑↓]*$/))
    expect(ids()).toEqual(Array.from({ length: 50 }, (_, index) => `keep-${54 - index}`))
    fireEvent.click(screen.getByText('下一页'))
    expect(ids()).toEqual(['keep-4', 'keep-3', 'keep-2', 'keep-1', 'keep-0'])
    fireEvent.click(screen.getByText(/^金额[ ↑↓]*$/))
    expect(ids()[0]).toBe('keep-0')
    expect(ids()).toHaveLength(50)
  })
})
