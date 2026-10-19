import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { db } from '../src/db/db'
import { persistLegacyImport, readSnapshot } from '../src/db/repository'
import { classifyTransactionType, inferTransactionType } from '../src/core/classify'
import { DEFAULT_FILTERS, applyFilters, filterByStatementTrust, summarize } from '../src/core/analytics'
import { planLegacyImport, previewLegacyWorkbook } from '../src/importers/legacyImport'
import { MIGRATION_FORMATS } from './fixtures/historicalMigration'
import { historyRow, workbookBytes } from './fixtures/legacyWorkbook'
import { DashboardPage } from '../src/ui/pages/DashboardPage'
import type { Statement, Transaction } from '../src/core/types'

const app = vi.hoisted(() => ({ visibleTransactions: [] as Transaction[], visibleStatements: [] as Statement[], state: { demoMode: false } }))
vi.mock('../src/app/AppStore', () => ({ useApp: () => app }))
beforeEach(async () => { cleanup(); await db.delete(); await db.open() })
async function store(format: typeof MIGRATION_FORMATS[number], description: string, amount = 100) {
  const buffer = workbookBytes(format.sheet, format.columns, [historyRow({ description, 说明: description, 交易详情: description,
    transaction_amount: amount, settlement_amount: amount, 交易金额: amount, 结算金额: amount, 入账金额: amount }, format.format)])
  const existing = await readSnapshot()
  const preview = await previewLegacyWorkbook(buffer, { fileName: 'synthetic.xlsx', fileHash: 'synthetic', fileSize: buffer.byteLength }, existing)
  await persistLegacyImport(planLegacyImport(preview, existing))
  const snapshot = await readSnapshot()
  app.visibleTransactions = snapshot.transactions; app.visibleStatements = snapshot.statements
  return snapshot
}

describe('AUD-011 merchant text cannot redefine financial type', () => {
  it.each(['示例优惠超市', '示例还款商店', '示例退款商店', '示例返现商店', '示例服务费商店'])('uses direction for an unstructured merchant %s', description => {
    expect(inferTransactionType('', description, 'debit')).toBe('purchase')
  })
  it.each(['退款', '返现', '还款'])('does not accept incompatible debit token %s', token => {
    expect(inferTransactionType(token, '合成商户', 'debit')).toBe('purchase')
  })
  it('does not treat a substring inside an unrecognized structured token as an authority', () => {
    expect(inferTransactionType('商户退款服务', '合成商户', 'debit')).toBe('purchase')
  })
  for (const format of MIGRATION_FORMATS) {
    it.each(['示例优惠超市', '示例还款商店', '示例退款商店', '示例返现商店', '示例服务费商店'])(`${format.sheet}: Adapter → IndexedDB → Dashboard keeps %s as 100.00 spending`, async description => {
      const snapshot = await store(format, description)
      expect(snapshot.transactions[0]).toMatchObject({ type: 'purchase', direction: 'debit', settlementAmountMinor: 10000 })
      const trusted = filterByStatementTrust(snapshot.transactions, snapshot.statements, false).transactions
      expect(summarize(applyFilters(trusted, DEFAULT_FILTERS)).realSpendingMinor).toBe(10000)
      render(<DashboardPage />)
      expect(screen.getByText('实际消费额').closest('.stat')).toHaveTextContent('¥100.00')
    })
    it(`${format.sheet}: marks an untyped credit for review and excludes it from default trusted analytics`, async () => {
      const snapshot = await store(format, '合成未知贷记商户', -100)
      expect(snapshot.transactions[0]!.flags).toContain('transaction_type_unclear')
      expect(snapshot.transactions[0]!.reviewStatus).toBe('pending')
      expect(filterByStatementTrust(snapshot.transactions, snapshot.statements, false).transactions).toHaveLength(0)
      // Ordinary date/search filters keep the full transaction list available.
      expect(applyFilters(snapshot.transactions, DEFAULT_FILTERS)).toHaveLength(1)
      render(<DashboardPage />)
      expect(screen.getByTestId('type-summary-warning')).toHaveTextContent('交易类型待确认')
    })
  }
  it.each([['退款 合成商户', 'refund'], ['返现 合成活动', 'cashback'], ['还款 合成转账', 'payment']] as const)('keeps a format-defined prefix %s', async (description, type) => {
    expect((await store(MIGRATION_FORMATS[0], description, -100)).transactions[0]).toMatchObject({ type, direction: 'credit', reviewStatus: 'ok' })
  })
  it('validates signed amounts independently of the authoritative token', () => {
    expect(classifyTransactionType('退款', 'credit', 100)).toMatchObject({ requiresReview: true })
    expect(classifyTransactionType('退款', 'credit', -100)).toEqual({ type: 'refund', requiresReview: false })
    expect(classifyTransactionType('消费', 'credit', -100)).toEqual({ type: 'payment', requiresReview: true })
    expect(classifyTransactionType('分期原始', 'debit', 100)).toEqual({ type: 'installment_original', requiresReview: false })
    expect(classifyTransactionType('分期扣款', 'debit', 100)).toEqual({ type: 'installment_payment', requiresReview: false })
  })
})
