import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DashboardPage } from '../src/ui/pages/DashboardPage'
import { ReviewPage } from '../src/ui/pages/ReviewPage'
import { DEFAULT_FILTERS, applyFilters, groupBy, groupByBank, monthlyTrend, summarize, untrustedAmount } from '../src/core/analytics'
import { reconcileStatement } from '../src/core/reconcile'
import { reconcileStatementTransactions } from '../src/core/reconciliation'
import { buildDuplicateReviewDetails } from '../src/core/migrationAudit'
import type { Statement, Transaction } from '../src/core/types'
import { ingestSynthetic } from './fixtures/identity'

const app = vi.hoisted(() => ({
  visibleTransactions: [] as Transaction[], visibleStatements: [] as Statement[],
  updateTransaction: vi.fn(), saveNote: vi.fn(), refresh: vi.fn(), state: { demoMode: false, notes: {} },
}))
vi.mock('../src/app/AppStore', () => ({ useApp: () => app }))

function baseLedger() {
  const result = ingestSynthetic(['消费 合成商户'])
  const first = { ...result.transactions[0]!, sourceFileName: 'synthetic-native.html' }
  const statement = { ...result.statement!, status: 'imported' as const }
  return { first, statement }
}

beforeEach(() => {
  app.visibleTransactions = []
  app.visibleStatements = []
  vi.clearAllMocks()
})

describe('currency-safe totals and review observability', () => {
  it('keeps 1 CNY plus 100 JPY out of a fabricated RMB total and all charts', () => {
    const { first, statement } = baseLedger()
    const cny = { ...first, settlementAmountMinor: 100 }
    const jpy = { ...first, id: `${first.id}#2`, transactionCurrency: 'JPY', transactionAmountMinor: 100, settlementCurrency: 'JPY', settlementAmountMinor: 100 }
    const rows = [cny, jpy]
    expect(summarize(rows)).toMatchObject({ billingDebitMinor: 100, transactionCount: 1, netMinor: 100 })
    expect(monthlyTrend(rows)).toEqual([{ month: '2024-01', debit: 100, credit: 0 }])
    expect(groupByBank(rows)).toEqual([{ label: first.bank, value: 100 }])
    expect(groupBy(rows, (row) => row.cardLast4)).toEqual([{ label: first.cardLast4, value: 100 }])
    expect(untrustedAmount(rows, [{ ...statement, status: 'needs_review' }])).toBe(100)
    app.visibleTransactions = rows
    app.visibleStatements = [statement]
    render(<DashboardPage />)
    expect(screen.getByTestId('currency-summary-warning')).toHaveTextContent('JPY 1 笔')
    expect(screen.getByTestId('currency-summary-warning')).toHaveTextContent('未进行汇率换算')
    const spending = screen.getByText('借记总额').closest('.stat')!
    expect(spending).toHaveTextContent('¥1.00')
    expect(spending).not.toHaveTextContent('¥2.00')
  })

  it('reconciles one statement currency and explicitly discloses the other leg', () => {
    const { first, statement } = baseLedger()
    const rows = [{ ...first, settlementAmountMinor: 100 }, { ...first, id: `${first.id}#2`, settlementCurrency: 'JPY', settlementAmountMinor: 100 }]
    const summary = { ...statement.summary, previousBalanceMinor: 0, currentBalanceMinor: 100, newDebitMinor: 100, newCreditMinor: 0 }
    const detailed = reconcileStatement({ summary, transactions: rows })
    expect(detailed.status).toBe('passed')
    expect(detailed.checks.find((check) => check.id === 'debit_detail')?.actualMinor).toBe(100)
    expect(detailed.checks.find((check) => check.id === 'other_currencies')?.detail).toContain('未进行汇率换算')
    expect(reconcileStatementTransactions({ ...statement, summary }, rows)).toMatchObject({ transactionTotalMinor: 100, currency: 'CNY' })
  })

  it('does not hide a duplicate by changing the conservative accounting rules', () => {
    const { first, statement } = baseLedger()
    const second: Transaction = { ...first, id: `${first.id}#2`, occurrence: 2, transactionCurrency: 'USD', transactionAmountMinor: 1800,
      origin: 'legacy_import', sourceId: 'legacy-unified-bill-v1', sourceFileName: 'synthetic-history.xlsx',
      flags: ['suspected_duplicate'], reviewStatus: 'pending' }
    const rows = [first, second]
    const before = structuredClone(rows)
    expect(summarize(applyFilters(rows, DEFAULT_FILTERS)).billingDebitMinor).toBe(25760)
    app.visibleTransactions = rows
    app.visibleStatements = [statement]
    render(<DashboardPage />)
    expect(screen.getByTestId('duplicate-summary-warning')).toHaveTextContent('总额可能重复累计')
    expect(screen.getByTestId('duplicate-summary-warning').querySelector('a')?.getAttribute('href')).toBe('#/review')
    expect(rows).toEqual(before)
  })

  it('shows original/settlement money, posting dates, sources and difference fields without a schema change', () => {
    const { first, statement } = baseLedger()
    const second: Transaction = { ...first, id: `${first.id}#2`, occurrence: 2, postingDate: '2024-01-07',
      transactionCurrency: 'USD', transactionAmountMinor: 1800, sourceFileName: 'synthetic-history.xlsx',
      flags: ['suspected_duplicate'], reviewStatus: 'pending' }
    app.visibleTransactions = [first, second]
    app.visibleStatements = [statement]
    render(<ReviewPage />)
    fireEvent.click(screen.getByRole('button', { name: /交易复核/ }))
    const comparison = screen.getByTestId('duplicate-comparison')
    fireEvent.click(within(comparison).getByText(/查看疑似重复对照/))
    expect(comparison).toHaveTextContent('1 笔候选')
    for (const text of ['入账日', '原币币种', '原币金额', 'USD 18.00', 'CNY 128.80', '2024-01-07', 'synthetic-native.html', 'synthetic-history.xlsx']) {
      expect(comparison).toHaveTextContent(text)
    }
    expect(app.updateTransaction).not.toHaveBeenCalled()
    expect(app.saveNote).not.toHaveBeenCalled()
  })

  it('bounds candidate examples and excludes the current row even in a large repeated bucket', () => {
    const { first } = baseLedger()
    const rows = Array.from({ length: 1000 }, (_unused, index) => ({ ...first, id: `${first.id}#${index + 1}`, postingDate: index < 998 ? first.postingDate : '2024-01-08' }))
    const before = structuredClone(rows)
    const result = buildDuplicateReviewDetails(rows, [rows[999]!])
    expect(result.size).toBe(1)
    expect(buildDuplicateReviewDetails(rows, []).size).toBe(0)
    const details = result.get(rows[999]!.id)!
    expect(details.candidateCount).toBe(999)
    expect(details.candidateIds.length).toBeLessThanOrEqual(3)
    expect(details.candidateIds).not.toContain(rows[999]!.id)
    expect(details.differingFields).toContain('postingDate')
    expect(rows).toEqual(before)
  })
})
