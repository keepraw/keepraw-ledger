import { useEffect } from 'react'
import { useApp } from '../app/AppStore'
import { pageTitle, useHashPage, type Page } from './router'
import { Badge, DemoBadge } from './components/ui'
import { DashboardPage } from './pages/DashboardPage'
import { DataQualityPage } from './pages/DataQualityPage'
import { ImportPage } from './pages/ImportPage'
import { ReconciliationPage } from './pages/ReconciliationPage'
import { ReviewPage } from './pages/ReviewPage'
import { SettingsPage } from './pages/SettingsPage'
import { TransactionsPage } from './pages/TransactionsPage'

const NAV: Array<{ page: Page; label: string }> = [
  { page: 'dashboard', label: '消费总览' },
  { page: 'quality', label: '数据质量' },
  { page: 'reconciliation', label: '账单核验' },
  { page: 'import', label: '账单导入' },
  { page: 'transactions', label: '交易明细' },
  { page: 'review', label: '人工复核' },
  { page: 'settings', label: '数据与设置' },
]

export function AppShell() {
  const [page, navigate] = useHashPage()
  const { state, visibleStatements } = useApp()

  useEffect(() => {
    document.title = `${pageTitle(page)} · Keepraw-Ledger`
  }, [page])

  useEffect(() => {
    const root = document.documentElement
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = (): void => {
      const theme = state.settings.theme
      root.dataset.theme = theme === 'system' ? (media.matches ? 'dark' : 'light') : theme
    }
    apply()
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [state.settings.theme])

  const pending = visibleStatements.filter((s) => s.status !== 'reconciled' && s.status !== 'imported').length

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-header-inner">
          <div className="brand">
            <span className="brand-mark" aria-hidden>
              账
            </span>
            <span className="brand-text">
              <strong>Keepraw-Ledger</strong>
              <span>本地优先 · 不上传 · 不联网</span>
            </span>
          </div>
          <nav className="app-nav" aria-label="主导航">
            {NAV.map((item) => (
              <a
                key={item.page}
                className="nav-link"
                href={`#/${item.page}`}
                aria-current={page === item.page ? 'page' : undefined}
                data-testid={`nav-${item.page}`}
                onClick={(event) => {
                  event.preventDefault()
                  navigate(item.page)
                }}
              >
                {item.label}
                {item.page === 'review' && pending > 0 ? <Badge tone="warn">{pending}</Badge> : null}
              </a>
            ))}
          </nav>
          <div className="header-actions">
            {state.demoMode ? <DemoBadge /> : <Badge tone="info">本地数据</Badge>}
          </div>
        </div>
      </header>

      <main className="app-main">
        {state.demoMode ? (
          <div className="notice notice-warn">
            <DemoBadge />
            <div>
              <strong>演示模式已开启，当前页面全部为虚构数据</strong>
              <p>
                为避免与真实账户混淆，演示模式下真实账单被完全隐藏，并且禁止导入。到「数据与设置」页可随时关闭。
              </p>
            </div>
          </div>
        ) : null}

        {!state.ready ? (
          <div className="card">
            <div className="empty">正在读取本地数据…</div>
          </div>
        ) : (
          <PageBody page={page} />
        )}
      </main>

      <footer className="app-footer">
        所有账单与交易数据仅保存在本机浏览器中。清理浏览器数据会导致数据丢失，请定期导出备份。
      </footer>
    </div>
  )
}

function PageBody({ page }: { page: Page }) {
  switch (page) {
    case 'dashboard':
      return <DashboardPage />
    case 'quality':
      return <DataQualityPage />
    case 'reconciliation':
      return <ReconciliationPage />
    case 'import':
      return <ImportPage />
    case 'transactions':
      return <TransactionsPage />
    case 'review':
      return <ReviewPage />
    case 'settings':
      return <SettingsPage />
    default:
      return null
  }
}
