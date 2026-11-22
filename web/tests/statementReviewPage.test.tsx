import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { AppShell } from '../src/ui/AppShell'
import { ingestSynthetic } from './fixtures/identity'
import type { Statement } from '../src/core/types'

const app = vi.hoisted(() => ({ visibleStatements: [] as Statement[], visibleTransactions: [],
  state: { ready: true, demoMode: false, notes: {}, settings: { theme: 'light' } },
  acknowledgeStatement: vi.fn(), recomputeStatement: vi.fn() }))
vi.mock('../src/app/AppStore', () => ({ useApp: () => app }))

beforeEach(() => {
  vi.clearAllMocks()
  window.location.hash = '#/review'
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
  app.visibleStatements = [ingestSynthetic(['消费 合成复核商户']).statement!]
  app.acknowledgeStatement.mockImplementation(async (_id, acknowledged) => {
    app.visibleStatements = app.visibleStatements.map(row => ({ ...row, reconciliationAcknowledged: acknowledged }))
  })
})

it('acknowledges and undoes from all statements, updating both queue and navigation badge', async () => {
  const view = render(<AppShell />)
  expect(screen.getByTestId('nav-review')).toHaveTextContent('人工复核1')
  fireEvent.click(screen.getByRole('button', { name: '确认无需对账' }))
  await waitFor(() => expect(app.acknowledgeStatement).toHaveBeenCalledWith(app.visibleStatements[0]!.id, true))
  view.rerender(<AppShell />)
  expect(screen.getByTestId('nav-review')).toHaveTextContent(/^人工复核$/)
  expect(screen.getByRole('button', { name: '账单对账 0' })).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '撤销无需对账确认' })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('checkbox', { name: '显示全部账单（可重新核对历史状态）' }))
  fireEvent.click(screen.getByRole('button', { name: '撤销无需对账确认' }))
  await waitFor(() => expect(app.acknowledgeStatement).toHaveBeenLastCalledWith(app.visibleStatements[0]!.id, false))
  view.rerender(<AppShell />)
  expect(screen.getByTestId('nav-review')).toHaveTextContent('人工复核1')
})

it('does not offer acknowledgement for a mismatch and shows failed-save errors', async () => {
  const statement = app.visibleStatements[0]!
  app.visibleStatements = [{ ...statement, reconciliation: { ...statement.reconciliation, status: 'mismatch' } }]
  const view = render(<AppShell />)
  expect(screen.queryByRole('button', { name: '确认无需对账' })).not.toBeInTheDocument()
  app.visibleStatements = [statement]
  view.rerender(<AppShell />)
  app.acknowledgeStatement.mockRejectedValueOnce(new Error('synthetic save failure'))
  fireEvent.click(screen.getByRole('button', { name: '确认无需对账' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('synthetic save failure')
  expect(screen.getByTestId('nav-review')).toHaveTextContent('人工复核1')
})
