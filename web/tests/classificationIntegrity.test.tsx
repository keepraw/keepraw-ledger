import { hasAmountDirectionConflict } from '../src/core/direction'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { db } from '../src/db/db'
import { persistLegacyImport, readSnapshot } from '../src/db/repository'
import { extractSourceTypeToken, legacyTypeForIdentity } from '../src/core/classify'
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
    expect(legacyTypeForIdentity(extractSourceTypeToken(description), 'debit')).toBe('purchase')
  })
  it.each(['退款', '返现', '还款'])('does not accept incompatible debit token %s', token => {
    expect(legacyTypeForIdentity(token, 'debit')).toBe('purchase')
  })
  it('does not treat a substring inside an unrecognized structured token as an authority', () => {
    expect(legacyTypeForIdentity('商户退款服务', 'debit')).toBe('purchase')
  })
  for (const format of MIGRATION_FORMATS) {
    it.each(['示例优惠超市', '示例还款商店', '示例退款商店', '示例返现商店', '示例服务费商店'])(`${format.sheet}: Adapter → IndexedDB → Dashboard keeps %s as 100.00 spending`, async description => {
      const snapshot = await store(format, description)
      expect(snapshot.transactions[0]).toMatchObject({ type: 'purchase', direction: 'debit', settlementAmountMinor: 10000 })
      const trusted = filterByStatementTrust(snapshot.transactions, snapshot.statements, false).transactions
      expect(summarize(applyFilters(trusted, DEFAULT_FILTERS)).billingDebitMinor).toBe(10000)
      render(<DashboardPage />)
      expect(screen.getByText('借记总额').closest('.stat')).toHaveTextContent('¥100.00')
    })
    it(`${format.sheet}: books an untyped credit normally without claiming its business nature`, async () => {
      const snapshot = await store(format, '合成未知贷记商户', -100)
      expect(snapshot.transactions[0]!.flags).toEqual([])
      expect(snapshot.transactions[0]!.category).toBe('未分类')
      expect(snapshot.transactions[0]!.reviewStatus).toBe('ok')
      expect(filterByStatementTrust(snapshot.transactions, snapshot.statements, false).transactions).toHaveLength(1)
      // Ordinary date/search filters keep the full transaction list available.
      expect(applyFilters(snapshot.transactions, DEFAULT_FILTERS)).toHaveLength(1)
      render(<DashboardPage />)
      expect(screen.queryByTestId('type-summary-warning')).not.toBeInTheDocument()
      expect(screen.getByText('贷记总额').closest('.stat')).toHaveTextContent('¥100.00')
    })
  }
  it.each([['退款 合成商户', 'refund'], ['返现 合成活动', 'cashback'], ['还款 合成转账', 'payment']] as const)('keeps a format-defined prefix %s', async (description, type) => {
    expect((await store(MIGRATION_FORMATS[0], description, -100)).transactions[0]).toMatchObject({ type, direction: 'credit', reviewStatus: 'ok' })
  })
  it('validates signed amounts independently of legacy identity metadata', () => {
    expect(hasAmountDirectionConflict({ direction: 'credit', transactionAmountMinor: 100, settlementAmountMinor: -100 })).toBe(true)
    expect(hasAmountDirectionConflict({ direction: 'credit', transactionAmountMinor: -100, settlementAmountMinor: -100 })).toBe(false)
    expect(legacyTypeForIdentity('消费', 'credit')).toBe('payment') // frozen ID encoding only
  })
})
