import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { TransactionsPage } from '../src/ui/pages/TransactionsPage'
import { ingestSynthetic } from './fixtures/identity'
import type { Transaction } from '../src/core/types'

const app = vi.hoisted(() => ({ visibleTransactions: [] as Transaction[], state: { demoMode: false },
  updateTransaction: vi.fn(), categorizeUncategorized: vi.fn() }))
vi.mock('../src/app/AppStore', () => ({ useApp: () => app }))

beforeEach(() => {
  vi.restoreAllMocks(); vi.clearAllMocks()
  app.state.demoMode = false
  app.visibleTransactions = ingestSynthetic(['支付宝-示例商户', '微信-示例商户', '财付通-微信支付-示例商户', '示例商户东店']).transactions
    .map((row, index) => ({ ...row, category: index === 2 ? '医疗健康' : '未分类' }))
  app.updateTransaction.mockResolvedValue(undefined)
  app.categorizeUncategorized.mockResolvedValue(1)
})

it('reruns categorization for all uncategorized transactions and displays the changed count including zero', async () => {
  render(<TransactionsPage />)
  fireEvent.click(screen.getByRole('button', { name: '重新自动分类' }))
  expect(await screen.findByRole('status')).toHaveTextContent('已自动分类 1 笔交易')
  expect(app.categorizeUncategorized).toHaveBeenCalledWith()
  app.categorizeUncategorized.mockResolvedValueOnce(0)
  fireEvent.click(screen.getByRole('button', { name: '重新自动分类' }))
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('已自动分类 0 笔交易'))
})

it.each([true, false])('offers only uncategorized exact-merchant peers after saving; confirmation %s', async confirmed => {
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(confirmed)
  render(<TransactionsPage />)
  fireEvent.change(screen.getByRole('combobox', { name: '支付宝-示例商户 分类' }), { target: { value: '购物' } })
  await waitFor(() => expect(confirm).toHaveBeenCalledWith(expect.stringContaining('其他 1 笔相同商户')))
  expect(app.updateTransaction).toHaveBeenCalledWith({ id: app.visibleTransactions[0]!.id, category: '购物' })
  if (confirmed) {
    await waitFor(() => expect(app.categorizeUncategorized).toHaveBeenCalledWith({ id: app.visibleTransactions[0]!.id, category: '购物' }))
    expect(await screen.findByRole('status')).toHaveTextContent('其他 1 笔相同商户')
  } else expect(app.categorizeUncategorized).not.toHaveBeenCalled()
})

it('does not offer propagation for bare channels or uncategorized selection', async () => {
  const confirm = vi.spyOn(window, 'confirm')
  app.visibleTransactions = ingestSynthetic(['支付宝-消费-', '微信-消费-']).transactions
  render(<TransactionsPage />)
  fireEvent.change(screen.getByRole('combobox', { name: '支付宝-消费- 分类' }), { target: { value: '购物' } })
  expect(await screen.findByRole('status')).toHaveTextContent('分类已保存')
  expect(confirm).not.toHaveBeenCalled()
})

it('shows save/batch errors and disables automatic classification in demo mode', async () => {
  app.categorizeUncategorized.mockRejectedValueOnce(new Error('synthetic bulk failure'))
  const view = render(<TransactionsPage />)
  fireEvent.click(screen.getByRole('button', { name: '重新自动分类' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('synthetic bulk failure')
  const confirm = vi.spyOn(window, 'confirm')
  app.updateTransaction.mockRejectedValueOnce(new Error('synthetic save failure'))
  fireEvent.change(screen.getByRole('combobox', { name: '支付宝-示例商户 分类' }), { target: { value: '购物' } })
  expect(await screen.findByRole('alert')).toHaveTextContent('synthetic save failure')
  expect(confirm).not.toHaveBeenCalled()
  app.state.demoMode = true
  view.rerender(<TransactionsPage />)
  expect(screen.getByRole('button', { name: '重新自动分类' })).toBeDisabled()
})
