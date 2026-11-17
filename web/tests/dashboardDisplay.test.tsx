import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DashboardPage } from '../src/ui/pages/DashboardPage'
import { groupBy, monthlyTrend, summarize } from '../src/core/analytics'
import { bankName, type BankId, type Statement, type Transaction } from '../src/core/types'
import { ingestSynthetic } from './fixtures/identity'

const app = vi.hoisted(() => ({
  visibleTransactions: [] as Transaction[],
  visibleStatements: [] as Statement[],
  updateTransaction: vi.fn(),
  saveNote: vi.fn(),
  refresh: vi.fn(),
  state: { demoMode: false, notes: {} },
}))
vi.mock('../src/app/AppStore', () => ({ useApp: () => app }))

const banks: BankId[] = ['boc', 'ccb', 'icbc', 'abc', 'bocom', 'citic']

function makeBase() {
  const result = ingestSynthetic(['消费 Dashboard 固定合成样例'])
  const first = { ...result.transactions[0]!, sourceFileName: 'dashboard-fixed-synthetic.html' }
  const statement = { ...result.statement!, status: 'imported' as const }
  return { first, statement }
}

function monthAt(index: number): string {
  const year = 2020 + Math.floor(index / 12)
  const month = (index % 12) + 1
  return `${year}-${String(month).padStart(2, '0')}`
}

function makeTransaction(
  base: Transaction,
  index: number,
  overrides: Partial<Transaction> = {},
): Transaction {
  const month = monthAt(index)
  return {
    ...base,
    id: `dashboard-synthetic-${index}`,
    statementId: 'dashboard-synthetic-statement',
    transactionDate: `${month}-15`,
    postingDate: `${month}-16`,
    bank: 'boc',
    cardLast4: '0000',
    settlementCurrency: 'CNY',
    settlementAmountMinor: 1_000 + index,
    transactionAmountMinor: 1_000 + index,
    type: 'purchase',
    direction: 'debit',
    reviewStatus: 'ok',
    flags: [],
    ...overrides,
  }
}

function setLedger(transactions: Transaction[], statements?: Statement[]) {
  app.visibleTransactions = transactions
  app.visibleStatements = statements ?? [
    { ...makeBase().statement, id: 'dashboard-synthetic-statement', status: 'imported' },
  ]
}

function monthKeys() {
  return screen.getAllByTestId('monthly-bar').map((column) => column.getAttribute('data-chart-key'))
}

beforeEach(() => {
  app.visibleTransactions = []
  app.visibleStatements = []
  app.state = { demoMode: false, notes: {} }
  vi.clearAllMocks()
})

describe('Dashboard monthly trend presentation', () => {
  it.each([6, 12, 24, 60])('shows the latest window and exposes every year for %i recorded months', (count) => {
    const { first } = makeBase()
    const transactions = Array.from({ length: count }, (_, index) => makeTransaction(first, index))
    setLedger(transactions)
    const expectedTrend = monthlyTrend(transactions)
    const expectedSummary = summarize(transactions)
    const expectedCards = groupBy(transactions, (row) => `${bankName(row.bank)} ·${row.cardLast4}`)

    render(<DashboardPage />)

    const recentMonths = expectedTrend.slice(-12).map((entry) => entry.month)
    expect(monthKeys()).toEqual(recentMonths)
    expect(screen.getByTestId('monthly-trend-range')).toHaveTextContent(
      `覆盖时间：${recentMonths[0]} 至 ${recentMonths[recentMonths.length - 1]}`,
    )
    const spendingStat = screen.getByText('借记总额').closest('.stat')!
    expect(spendingStat).toHaveTextContent(`¥${(expectedSummary.billingDebitMinor / 100).toFixed(2)}`)

    fireEvent.change(screen.getByRole('combobox', { name: '借贷趋势显示范围' }), { target: { value: 'year' } })
    const yearSelect = screen.getByRole('combobox', { name: '借贷趋势年份' })
    const years = [...new Set(expectedTrend.map((entry) => entry.month.slice(0, 4)))].reverse()
    expect(within(yearSelect).getAllByRole('option').map((option) => (option as HTMLOptionElement).value)).toEqual(years)
    const oldestYear = years[years.length - 1]!
    fireEvent.change(yearSelect, { target: { value: oldestYear } })
    const oldestYearMonths = expectedTrend.filter((entry) => entry.month.startsWith(`${oldestYear}-`)).map((entry) => entry.month)
    expect(monthKeys()).toEqual(oldestYearMonths)
    expect(screen.getByTestId('monthly-trend-range')).toHaveTextContent(
      `覆盖时间：${oldestYearMonths[0]} 至 ${oldestYearMonths[oldestYearMonths.length - 1]}`,
    )
    expect(spendingStat).toHaveTextContent(`¥${(expectedSummary.billingDebitMinor / 100).toFixed(2)}`)
    expect(expectedCards).toHaveLength(1)
  })

  it('keeps zero-spend and refund-only months from monthlyTrend and exposes both values without hover', () => {
    const { first } = makeBase()
    const transactions = [
      makeTransaction(first, 0, { transactionDate: '2025-01-15', settlementAmountMinor: 0, transactionAmountMinor: 0 }),
      makeTransaction(first, 1, { transactionDate: '2025-02-15', type: 'refund', direction: 'credit', settlementAmountMinor: -2_500, transactionAmountMinor: -2_500 }),
    ]
    setLedger(transactions)

    render(<DashboardPage />)

    expect(monthKeys()).toEqual(['2025-01', '2025-02'])
    expect(screen.getByRole('group', { name: '2025-01，借记金额 0.00 元，贷记金额 0.00 元' })).toBeInTheDocument()
    expect(screen.getByRole('group', { name: '2025-02，借记金额 0.00 元，贷记金额 25.00 元' })).toBeInTheDocument()
    expect(screen.getByText('贷记 25.00')).toBeInTheDocument()
    expect(screen.getByText('贷记 0.00')).toBeInTheDocument()
  })

  it('uses full year-month IDs for repeated month names across years with no duplicate-key warning', () => {
    const { first } = makeBase()
    const transactions = ['2024-01', '2025-01', '2026-01'].map((month, index) =>
      makeTransaction(first, index, { transactionDate: `${month}-15` }),
    )
    setLedger(transactions)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    render(<DashboardPage />)

    expect(monthKeys()).toEqual(['2024-01', '2025-01', '2026-01'])
    expect(new Set(monthKeys()).size).toBe(3)
    expect(consoleError.mock.calls.flat().join(' ')).not.toMatch(/same key|unique "key"/i)
    consoleError.mockRestore()
  })

  it('updates year choices after global filters and does not let chart selection change summary totals', () => {
    const { first, statement } = makeBase()
    const approved = [
      makeTransaction(first, 0, { bank: 'boc', cardLast4: '1111', transactionDate: '2024-01-15', settlementAmountMinor: 10_000 }),
      makeTransaction(first, 1, { bank: 'ccb', cardLast4: '2222', transactionDate: '2025-02-15', settlementAmountMinor: 20_000 }),
    ]
    const pending = makeTransaction(first, 2, {
      statementId: 'dashboard-pending-statement', bank: 'ccb', cardLast4: '2222', transactionDate: '2026-04-15', settlementAmountMinor: 40_000,
    })
    setLedger([...approved, pending], [
      { ...statement, id: 'dashboard-synthetic-statement', status: 'imported' },
      { ...statement, id: 'dashboard-pending-statement', status: 'needs_review' },
    ])

    render(<DashboardPage />)
    const spendingStat = screen.getByText('借记总额').closest('.stat')!
    expect(spendingStat).toHaveTextContent('¥300.00')
    fireEvent.change(screen.getByRole('combobox', { name: '借贷趋势显示范围' }), { target: { value: 'year' } })
    fireEvent.change(screen.getByRole('combobox', { name: '借贷趋势年份' }), { target: { value: '2024' } })
    expect(monthKeys()).toEqual(['2024-01'])
    expect(spendingStat).toHaveTextContent('¥300.00')

    fireEvent.change(screen.getByRole('combobox', { name: '总览银行筛选' }), { target: { value: 'ccb' } })
    expect(monthKeys()).toEqual(['2025-02'])
    expect(screen.getByRole('combobox', { name: '借贷趋势年份' })).toHaveValue('2025')
    expect(within(screen.getByRole('combobox', { name: '借贷趋势年份' })).getAllByRole('option')).toHaveLength(1)
    expect(spendingStat).toHaveTextContent('¥200.00')

    fireEvent.change(screen.getByRole('combobox', { name: '总览卡片筛选' }), { target: { value: '2222' } })
    fireEvent.change(screen.getByRole('combobox', { name: '总览月份筛选' }), { target: { value: '2025-02' } })
    expect(monthKeys()).toEqual(['2025-02'])
    expect(spendingStat).toHaveTextContent('¥200.00')

    fireEvent.change(screen.getByRole('combobox', { name: '总览月份筛选' }), { target: { value: '' } })
    fireEvent.click(screen.getByRole('checkbox', { name: '包含待复核账单' }))
    expect(screen.getByRole('combobox', { name: '借贷趋势年份' })).toHaveValue('2026')
    expect(monthKeys()).toContain('2026-04')
    expect(spendingStat).toHaveTextContent('¥600.00')
  })
})

describe('Dashboard card distribution presentation', () => {
  it.each([1, 10, 30, 100])('shows the first ten of %i groups and provides access to all groups', (count) => {
    const { first } = makeBase()
    const transactions = Array.from({ length: count }, (_, index) => makeTransaction(first, index, {
      bank: banks[index % banks.length]!,
      cardLast4: String(index).padStart(4, '0'),
      settlementAmountMinor: 123_456_789_012 - index * 100,
      transactionAmountMinor: 123_456_789_012 - index * 100,
    }))
    setLedger(transactions)
    const expected = groupBy(transactions, (row) => `${bankName(row.bank)} ·${row.cardLast4}`)
    const visibleCount = Math.min(10, count)

    render(<DashboardPage />)

    expect(screen.getByTestId('card-distribution-count')).toHaveTextContent(`卡片项：${count}`)
    const distribution = screen.getByRole('heading', { name: '卡片借记分布' }).closest('.card') as HTMLElement
    const bars = () => Array.from(distribution.querySelectorAll<HTMLElement>('.hbar'))
    expect(bars()).toHaveLength(visibleCount)
    expect(bars().map((bar) => bar.dataset.label)).toEqual(expected.slice(0, 10).map((entry) => entry.label))
    expect(bars()[0]).toHaveAttribute('data-value', String(expected[0]!.value))
    expect(distribution).toHaveTextContent('¥1,234,567,890.12')

    if (count > 10) {
      const toggle = within(distribution).getByRole('button', { name: `查看全部 (${count})` })
      expect(toggle).toHaveAttribute('aria-expanded', 'false')
      fireEvent.click(toggle)
      expect(within(distribution).getByRole('button', { name: '收起' })).toHaveAttribute('aria-expanded', 'true')
      expect(bars()).toHaveLength(count)
      expect(distribution.querySelector('#dashboard-card-distribution')).toHaveAttribute('role', 'region')
      expect(bars().map((bar) => bar.dataset.label)).toEqual(expected.map((entry) => entry.label))
      fireEvent.click(within(distribution).getByRole('button', { name: '收起' }))
      expect(bars()).toHaveLength(10)
    } else {
      expect(within(distribution).queryByRole('button')).not.toBeInTheDocument()
    }
  })

  it('keeps cards from different banks separate even when their last four digits match', () => {
    const { first } = makeBase()
    setLedger([
      makeTransaction(first, 0, { bank: 'boc', cardLast4: '4242', settlementAmountMinor: 10_000 }),
      makeTransaction(first, 1, { bank: 'ccb', cardLast4: '4242', settlementAmountMinor: 20_000 }),
    ])

    render(<DashboardPage />)

    const distribution = screen.getByRole('heading', { name: '卡片借记分布' }).closest('.card')!
    const labels = Array.from(distribution.querySelectorAll<HTMLElement>('.hbar-label')).map((label) => label.textContent)
    expect(labels).toEqual(['建设银行 ·4242', '中国银行 ·4242'])
    expect(screen.getByTestId('card-distribution-count')).toHaveTextContent('卡片项：2')
  })

  it('keeps the existing global filters and spending calculations based on trusted CNY rows', () => {
    const { first, statement } = makeBase()
    const rows = [
      makeTransaction(first, 0, { settlementAmountMinor: 10_000, transactionDate: '2024-01-15' }),
      makeTransaction(first, 1, { id: 'dashboard-synthetic-noncny', settlementCurrency: 'JPY', settlementAmountMinor: 99_000, transactionDate: '2024-02-15' }),
    ]
    setLedger(rows, [{ ...statement, id: 'dashboard-synthetic-statement', status: 'imported' }])
    const trustedCny = rows.filter((row) => row.settlementCurrency === 'CNY')
    const originalSummary = summarize(trustedCny)
    const originalTrend = monthlyTrend(trustedCny)
    const originalCards = groupBy(trustedCny, (row) => `${bankName(row.bank)} ·${row.cardLast4}`)

    render(<DashboardPage />)

    expect(monthKeys()).toEqual(originalTrend.map((entry) => entry.month))
    expect(screen.getByTestId('card-distribution-count')).toHaveTextContent(`卡片项：${originalCards.length}`)
    expect(screen.getByText('借记总额').closest('.stat')).toHaveTextContent(`¥${(originalSummary.billingDebitMinor / 100).toFixed(2)}`)
    fireEvent.change(screen.getByRole('combobox', { name: '总览月份筛选' }), { target: { value: '2024-01' } })
    expect(monthKeys()).toEqual(['2024-01'])
    expect(screen.getByText('借记总额').closest('.stat')).toHaveTextContent('¥100.00')

    // Changing the chart's own view is presentational only; global totals remain filtered as before.
    fireEvent.change(screen.getByRole('combobox', { name: '借贷趋势显示范围' }), { target: { value: 'year' } })
    expect(screen.getByText('借记总额').closest('.stat')).toHaveTextContent('¥100.00')
  })
})
