import { useMemo, useState } from 'react'
import { useApp } from '../../app/AppStore'
import { DEFAULT_FILTERS, applyFilters, filterByStatementTrust, groupBy, groupByBank, monthlyTrend, summarize, untrustedAmount, type Filters } from '../../core/analytics'
import { bankName, type BankId } from '../../core/types'
import { formatMinor, normalizeCurrencyCode } from '../../core/money'
import { monthEnd } from '../../core/dates'
import { BarChart, Badge, DemoBadge, EmptyState, HorizontalBars, Stat } from '../components/ui'

const BANKS: BankId[] = ['boc', 'bocom', 'icbc', 'ccb', 'abc', 'citic']

type TrendView = 'recent' | 'year'

export function DashboardPage() {
  const { visibleTransactions, visibleStatements, state } = useApp()
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS)
  const [trendView, setTrendView] = useState<TrendView>('recent')
  const [selectedTrendYear, setSelectedTrendYear] = useState('')
  const [showAllCards, setShowAllCards] = useState(false)

  const trusted = useMemo(() => {
    const base = filterByStatementTrust(visibleTransactions, visibleStatements, filters.includeUnreconciled).transactions
    return applyFilters(base, filters)
  }, [filters, visibleStatements, visibleTransactions])

  const summary = useMemo(() => summarize(trusted), [trusted])
  const excludedCurrencies = useMemo(() => {
    const counts = new Map<string, number>()
    for (const tx of trusted) {
      const currency = normalizeCurrencyCode(tx.settlementCurrency)
      if (currency !== 'CNY') counts.set(currency, (counts.get(currency) ?? 0) + 1)
    }
    return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [trusted])
  const pendingDuplicates = trusted.filter((tx) => tx.flags.includes('suspected_duplicate') &&
    tx.reviewStatus !== 'confirmed' && normalizeCurrencyCode(tx.settlementCurrency) === 'CNY').length
  const trend = useMemo(() => monthlyTrend(trusted), [trusted])
  const byBank = useMemo(() => groupByBank(trusted), [trusted])
  const byCard = useMemo(() => groupBy(trusted, (tx) => `${bankName(tx.bank)} ·${tx.cardLast4}`), [trusted])
  const excluded = useMemo(
    () => untrustedAmount(applyFilters(visibleTransactions, filters), visibleStatements),
    [filters, visibleStatements, visibleTransactions],
  )

  const cards = useMemo(
    () => [...new Set(visibleTransactions.map((tx) => tx.cardLast4))].filter(Boolean).sort(),
    [visibleTransactions],
  )
  const months = useMemo(() => trend.map((entry) => entry.month), [trend])
  const trendYears = useMemo(() => [...new Set(trend.map((entry) => entry.month.slice(0, 4)))].sort().reverse(), [trend])
  const effectiveTrendYear = trendYears.includes(selectedTrendYear) ? selectedTrendYear : (trendYears[0] ?? '')
  const displayedTrend = useMemo(
    () => trendView === 'recent' ? trend.slice(-12) : trend.filter((entry) => entry.month.startsWith(`${effectiveTrendYear}-`)),
    [effectiveTrendYear, trend, trendView],
  )
  const trendRange = displayedTrend.length > 0
    ? `${displayedTrend[0]!.month} 至 ${displayedTrend[displayedTrend.length - 1]!.month}`
    : '暂无月份数据'
  const selectedMonth =
    filters.from && filters.to && filters.from.slice(0, 7) === filters.to.slice(0, 7) ? filters.from.slice(0, 7) : ''

  const hasData = visibleTransactions.length > 0
  const pendingStatements = visibleStatements.filter((s) => s.status !== 'reconciled' && s.status !== 'imported').length
  const pendingTypes = visibleTransactions.filter(tx => tx.flags.includes('transaction_type_unclear') &&
    tx.reviewStatus !== 'confirmed' && tx.reviewStatus !== 'rejected').length
  const displayedCards = showAllCards ? byCard : byCard.slice(0, 10)

  return (
    <>
      <div className="page-head">
        <div>
          <h1>消费总览</h1>
          <p>本页仅汇总人民币结算交易，未通过对账的账单默认不计入；原币金额不会换算为人民币。</p>
        </div>
        <div className="row">
          {months.length > 0 ? (
            <select
              className="select"
              aria-label="总览月份筛选"
              value={selectedMonth}
              onChange={(event) => {
                const value = event.target.value
                setFilters((prev) => ({
                  ...prev,
                  from: value ? `${value}-01` : null,
                  to: value ? monthEnd(Number(value.slice(0, 4)), Number(value.slice(5, 7))) : null,
                }))
              }}
            >
              <option value="">全部月份</option>
              {months.map((month) => (
                <option key={month} value={month}>
                  {month}
                </option>
              ))}
            </select>
          ) : null}
          <select
            className="select"
            aria-label="总览银行筛选"
            value={filters.banks[0] ?? ''}
            onChange={(event) => setFilters((prev) => ({ ...prev, banks: event.target.value ? [event.target.value as BankId] : [] }))}
          >
            <option value="">全部银行</option>
            {BANKS.map((bank) => (
              <option key={bank} value={bank}>
                {bankName(bank)}
              </option>
            ))}
          </select>
          <select
            className="select"
            aria-label="总览卡片筛选"
            value={filters.cards[0] ?? ''}
            onChange={(event) => setFilters((prev) => ({ ...prev, cards: event.target.value ? [event.target.value] : [] }))}
          >
            <option value="">全部卡片</option>
            {cards.map((card) => (
              <option key={card} value={card}>
                尾号 {card}
              </option>
            ))}
          </select>
          <label className="row row-tight subtle" style={{ cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={filters.includeUnreconciled}
              onChange={(event) => setFilters((prev) => ({ ...prev, includeUnreconciled: event.target.checked }))}
            />
            包含待复核账单
          </label>
        </div>
      </div>

      {state.demoMode ? (
        <div className="notice notice-warn">
          <Badge tone="demo">演示模式</Badge>
          <div>
            <strong>当前展示的全部为虚构示例数据</strong>
            <p>真实账单已被隐藏，演示数据不会被混入真实统计。关闭演示模式后可导入自己的 PDF / EML 账单。</p>
          </div>
        </div>
      ) : null}

      {excludedCurrencies.length > 0 ? (
        <div className="notice notice-warn" data-testid="currency-summary-warning">
          非人民币结算交易未计入本页金额、趋势和分布：{excludedCurrencies.map(([currency, count]) => `${currency} ${count} 笔`).join('、')}。
          未进行汇率换算，完整记录可在「交易明细」查看。
        </div>
      ) : null}
      {pendingTypes > 0 ? (
        <div className="notice notice-warn" data-testid="type-summary-warning">
          有 {pendingTypes} 笔交易类型待确认，默认未计入可信统计。
          <a href="#/review">前往人工复核</a>，请结合银行原始记录确认资金性质。
        </div>
      ) : null}
      {pendingDuplicates > 0 ? (
        <div className="notice notice-warn" data-testid="duplicate-summary-warning">
          有 {pendingDuplicates} 笔未解决的疑似重复交易仍计入统计，总额可能重复累计。
          <a href="#/review">前往人工复核查看候选对照</a>。不会自动合并或删除。
        </div>
      ) : null}

      {!hasData ? (
        <div className="card">
          <EmptyState
            title="还没有任何账单数据"
            hint="到「账单导入」页拖入 PDF 或 EML 账单，或在「数据与设置」中开启演示模式。"
          />
        </div>
      ) : (
        <>
          <div className="grid grid-stats">
            <Stat
              label="实际消费额"
              value={`¥${formatMinor(summary.realSpendingMinor)}`}
              hint="消费 + 取现 + 分期每期入账，不含分期原始消费"
              badge={state.demoMode ? <DemoBadge /> : undefined}
            />
            <Stat label="退款额" value={`¥${formatMinor(summary.refundMinor)}`} hint="退货、退款等贷记交易" tone="neg" />
            <Stat label="返现额" value={`¥${formatMinor(summary.cashbackMinor)}`} hint="刷卡金、积分返还等" tone="neg" />
            <Stat
              label="账单入账净额"
              value={`¥${formatMinor(summary.netMinor)}`}
              hint={`借记 ${formatMinor(summary.billingDebitMinor)} / 贷记 ${formatMinor(summary.billingCreditMinor)}`}
            />
            <Stat label="还款额" value={`¥${formatMinor(summary.paymentMinor)}`} hint="仅统计，未计入消费" tone="neg" />
            <Stat label="费用与利息" value={`¥${formatMinor(summary.feeMinor + summary.interestMinor)}`} hint="手续费 + 利息" />
          </div>

          {pendingStatements > 0 && !filters.includeUnreconciled ? (
            <div className="notice notice-warn">
              <Badge tone="warn">{pendingStatements}</Badge>
              <div>
                <strong>有 {pendingStatements} 份账单未通过对账，暂未计入以上统计</strong>
                <p>
                  这些账单涉及金额 ¥{formatMinor(excluded)}。请到「人工复核」页查看差额原因，确认后再勾选「包含待复核账单」纳入统计。
                </p>
              </div>
            </div>
          ) : null}

          <div className="grid grid-2 dashboard-grid">
            <div className="card">
              <div className="card-head">
                <div>
                  <h2>月度消费趋势</h2>
                  <p>按交易日归月，退款单独统计</p>
                </div>
                <div className="legend">
                  <span>
                    <span className="legend-swatch" style={{ background: 'var(--navy-800)' }} />
                    消费
                  </span>
                </div>
              </div>
              <div className="card-pad stack chart-panel">
                {displayedTrend.length > 0 ? (
                  <>
                    <div className="chart-toolbar">
                      <div>
                        <p className="chart-range" data-testid="monthly-trend-range" aria-live="polite">覆盖时间：{trendRange}</p>
                        <p className="subtle">默认显示最近 12 个有记录月份；可按年份浏览历史，图表区域可横向滚动。</p>
                      </div>
                      <div className="row chart-selectors">
                        <select
                          className="select"
                          aria-label="消费趋势显示范围"
                          value={trendView}
                          onChange={(event) => setTrendView(event.target.value as TrendView)}
                        >
                          <option value="recent">最近 12 个月</option>
                          <option value="year">按年份查看</option>
                        </select>
                        {trendView === 'year' ? (
                          <select
                            className="select"
                            aria-label="消费趋势年份"
                            value={effectiveTrendYear}
                            onChange={(event) => setSelectedTrendYear(event.target.value)}
                          >
                            {trendYears.map((year) => <option key={year} value={year}>{year} 年</option>)}
                          </select>
                        ) : null}
                      </div>
                    </div>
                    <BarChart
                      ariaLabel="月度消费趋势，可横向滚动查看各月金额"
                      data={displayedTrend.map((entry) => ({
                        id: entry.month,
                        label: entry.month,
                        value: entry.spending,
                        caption: `退款 ${formatMinor(entry.refund)}`,
                        accessibleLabel: `${entry.month}，消费金额 ${formatMinor(entry.spending)} 元，退款金额 ${formatMinor(entry.refund)} 元`,
                      }))}
                      formatValue={(value) => formatMinor(value)}
                    />
                  </>
                ) : (
                  <EmptyState title="暂无人民币消费或退款月份" />
                )}
              </div>
            </div>

            <div className="card">
              <div className="card-head">
                <div>
                  <h2>银行消费分布</h2>
                  <p>按实际消费额统计</p>
                </div>
              </div>
              <div className="card-pad">
                <HorizontalBars data={byBank.map((entry) => ({ label: bankName(entry.label as BankId), value: entry.value }))} formatValue={(v) => `¥${formatMinor(v)}`} />
              </div>
            </div>

            <div className="card">
              <div className="card-head">
                <div>
                  <h2>卡片消费分布</h2>
                  <p>按银行与卡尾号分组 · {byCard.length} 个统计项</p>
                </div>
                {byCard.length > 10 ? (
                  <button
                    type="button"
                    className="btn btn-sm"
                    aria-expanded={showAllCards}
                    aria-controls="dashboard-card-distribution"
                    onClick={() => setShowAllCards((expanded) => !expanded)}
                  >
                    {showAllCards ? '收起' : `查看全部 (${byCard.length})`}
                  </button>
                ) : null}
              </div>
              <div className="card-pad">
                <p className="subtle card-count" data-testid="card-distribution-count">参与本次消费统计的卡片项：{byCard.length}（按银行与尾号分组）</p>
                <div
                  id="dashboard-card-distribution"
                  className={showAllCards && byCard.length > 10 ? 'card-list-scroll' : undefined}
                  role={showAllCards && byCard.length > 10 ? 'region' : undefined}
                  aria-label={showAllCards && byCard.length > 10 ? '全部卡片消费分布，可纵向滚动查看' : undefined}
                  tabIndex={showAllCards && byCard.length > 10 ? 0 : undefined}
                >
                  <HorizontalBars data={displayedCards} formatValue={(v) => `¥${formatMinor(v)}`} />
                </div>
              </div>
            </div>

            <div className="card">
              <div className="card-head">
                <div>
                  <h2>对账状态</h2>
                  <p>只有通过对账的账单才进入统计</p>
                </div>
              </div>
              <div className="card-pad stack">
                <div className="row">
                  <Badge tone="ok">{visibleStatements.filter((s) => s.status === 'reconciled').length}</Badge>
                  <span className="muted">份账单对账通过</span>
                </div>
                <div className="row">
                  <Badge tone={pendingStatements > 0 ? 'warn' : 'muted'}>{pendingStatements}</Badge>
                  <span className="muted">份账单待复核</span>
                </div>
                <div className="row">
                  <Badge tone="info">{summary.transactionCount}</Badge>
                  <span className="muted">笔交易纳入统计</span>
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </>
  )
}
