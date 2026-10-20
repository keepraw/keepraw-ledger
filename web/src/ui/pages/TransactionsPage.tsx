import { useMemo, useState } from 'react'
import { useApp } from '../../app/AppStore'
import { applyFilters, DEFAULT_FILTERS, type Filters } from '../../core/analytics'
import { formatMinor } from '../../core/money'
import { CATEGORIES, TRANSACTION_TYPE_LABELS, bankName, type BankId, type Category, type Transaction } from '../../core/types'
import { downloadCsv, downloadXlsx } from '../../export/tabular'
import { Badge, DemoBadge, EmptyState, ReviewStatusBadge, TypeBadge } from '../components/ui'

type SortKey = 'transactionDate' | 'postingDate' | 'description' | 'settlementAmountMinor' | 'type'
type SortDir = 'asc' | 'desc'

const PAGE_SIZE = 50
const collator = new Intl.Collator()
const compareDates = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0

/** Sort repeated text groups once, then apply the historical date tie within each. */
function sortRepeatedText(transactions: Transaction[], key: 'description' | 'type', direction: number): Transaction[] | undefined {
  if (transactions.length < 256) return undefined
  const values = new Set(transactions.map(tx => tx[key]))
  // Mostly unique text cannot amortize a second sort. Keep its direct comparator.
  if (values.size > transactions.length / 4) return undefined
  const ordered = [...values].sort((left, right) => {
    if (left === null || right === null) return left === right ? 0 : left === null ? 1 : -1
    return collator.compare(left, right) * direction
  })
  for (let index = 1; index < ordered.length; index++) {
    const left = ordered[index - 1]!, right = ordered[index]!
    // Different strings may collate equally (e.g. composed/decomposed accents).
    // Their historical comparator has no date tie: retain its stable interleaving.
    if (left !== null && right !== null && collator.compare(left, right) === 0) return undefined
  }
  const groups = new Map(ordered.map(value => [value, [] as Transaction[]]))
  for (const tx of transactions) groups.get(tx[key])!.push(tx)
  return ordered.flatMap(value => groups.get(value)!.sort((a, b) => compareDates(a.transactionDate ?? '', b.transactionDate ?? '')))
}

/** Same null placement, date tie-break and stable order as the historical list. */
export function sortTransactions(transactions: Transaction[], sortKey: SortKey, sortDir: SortDir): Transaction[] {
  const direction = sortDir === 'asc' ? 1 : -1
  const dateKey = sortKey === 'transactionDate' || sortKey === 'postingDate'
  if (sortKey === 'description' || sortKey === 'type') {
    const repeated = sortRepeatedText(transactions, sortKey, direction)
    if (repeated) return repeated
  }
  return [...transactions].sort((a, b) => {
    const left = a[sortKey], right = b[sortKey]
    if (left === null || right === null) {
      if (left === right) return compareDates(a.transactionDate ?? '', b.transactionDate ?? '')
      return left === null ? 1 : -1
    }
    // Currency groups stay in code order; only amounts within a group change direction.
    if (sortKey === 'settlementAmountMinor') {
      const currencyOrder = compareDates(a.settlementCurrency, b.settlementCurrency)
      if (currencyOrder) return currencyOrder
      const amountOrder = a.settlementAmountMinor < b.settlementAmountMinor ? -1 : a.settlementAmountMinor > b.settlementAmountMinor ? 1 : 0
      return amountOrder ? amountOrder * direction : compareDates(a.transactionDate ?? '', b.transactionDate ?? '')
    }
    if (left === right) return compareDates(a.transactionDate ?? '', b.transactionDate ?? '')
    return (dateKey ? compareDates(String(left), String(right)) : collator.compare(String(left), String(right))) * direction
  })
}

export function TransactionsPage() {
  const { visibleTransactions, updateTransaction, state } = useApp()
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS)
  const [search, setSearch] = useState('')
  const [typeFilter, setTypeFilter] = useState<string>('')
  const [sortKey, setSortKey] = useState<SortKey>('transactionDate')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  const [page, setPage] = useState(0)

  const banks = useMemo(() => [...new Set(visibleTransactions.map(tx => tx.bank))], [visibleTransactions])
  const cards = useMemo(() => [...new Set(visibleTransactions.map(tx => tx.cardLast4))], [visibleTransactions])
  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return applyFilters(visibleTransactions, filters).filter((tx) => {
      if (typeFilter && tx.type !== typeFilter) return false
      if (!needle) return true
      return (
        tx.description.toLowerCase().includes(needle) ||
        tx.merchant.toLowerCase().includes(needle) ||
        tx.cardLast4.includes(needle) ||
        bankName(tx.bank).includes(needle)
      )
    })
  }, [visibleTransactions, filters, search, typeFilter])
  const rows = useMemo(() => sortTransactions(filtered, sortKey, sortDir), [filtered, sortKey, sortDir])

  const pageRows = rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE))

  const toggleSort = (key: SortKey): void => {
    if (key === sortKey) setSortDir((dir) => (dir === 'asc' ? 'desc' : 'asc'))
    else {
      setSortKey(key)
      setSortDir('asc')
    }
    setPage(0)
  }

  const arrow = (key: SortKey): string => (sortKey === key ? (sortDir === 'asc' ? ' ↑' : ' ↓') : '')

  return (
    <>
      <div className="page-head">
        <div>
          <h1>交易明细</h1>
          <p>
            共 {rows.length} 笔{state.demoMode ? '（演示数据）' : ''}，保留来源文件与原始片段以便追溯。
          </p>
        </div>
        <div className="row">
          <button className="btn" type="button" data-testid="export-csv" onClick={() => downloadCsv('交易明细.csv', rows)}>
            导出 CSV
          </button>
          <button className="btn" type="button" data-testid="export-xlsx" onClick={() => void downloadXlsx('交易明细.xlsx', rows)}>
            导出 Excel
          </button>
        </div>
      </div>

      <div className="card">
        <div className="card-pad row">
          <input
            className="input"
            style={{ flex: '1 1 220px' }}
            placeholder="搜索商户、描述、卡尾号"
            value={search}
            data-testid="transaction-search"
            onChange={(event) => {
              setSearch(event.target.value)
              setPage(0)
            }}
          />
          <select
            className="select"
            value={typeFilter}
            onChange={(event) => {
              setTypeFilter(event.target.value)
              setPage(0)
            }}
          >
            <option value="">全部类型</option>
            {Object.entries(TRANSACTION_TYPE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <select
            className="select"
            value={filters.banks[0] ?? ''}
            onChange={(event) => setFilters((prev) => ({ ...prev, banks: event.target.value ? [event.target.value as BankId] : [] }))}
          >
            <option value="">全部银行</option>
            {banks.map((bank) => (
              <option key={bank} value={bank}>
                {bankName(bank)}
              </option>
            ))}
          </select>
          <select
            className="select"
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
          <input
            className="input"
            type="date"
            value={filters.from ?? ''}
            onChange={(event) => setFilters((prev) => ({ ...prev, from: event.target.value || null }))}
          />
          <input
            className="input"
            type="date"
            value={filters.to ?? ''}
            onChange={(event) => setFilters((prev) => ({ ...prev, to: event.target.value || null }))}
          />
        </div>
      </div>

      <div className="card">
        {pageRows.length === 0 ? (
          <EmptyState title="没有符合条件的交易" hint="调整筛选条件或导入账单后再试。" />
        ) : (
          <div className="table-wrap">
            <table className="data" data-testid="transactions-table">
              <thead>
                <tr>
                  <th className="sortable" onClick={() => toggleSort('transactionDate')}>
                    交易日{arrow('transactionDate')}
                  </th>
                  <th className="sortable" onClick={() => toggleSort('postingDate')}>
                    入账日{arrow('postingDate')}
                  </th>
                  <th>银行 / 卡</th>
                  <th className="sortable" onClick={() => toggleSort('description')}>
                    交易描述{arrow('description')}
                  </th>
                  <th>币种</th>
                  <th className="sortable num" onClick={() => toggleSort('settlementAmountMinor')}>
                    金额{arrow('settlementAmountMinor')}
                  </th>
                  <th className="sortable" onClick={() => toggleSort('type')}>
                    类型{arrow('type')}
                  </th>
                  <th>分类</th>
                  <th>复核</th>
                </tr>
              </thead>
              <tbody>
                {pageRows.map((tx) => (
                  <tr key={tx.id}>
                    <td className="nowrap">{tx.transactionDate ?? '—'}</td>
                    <td className="nowrap muted">{tx.postingDate ?? '—'}</td>
                    <td className="nowrap">
                      {bankName(tx.bank)} <span className="muted">{tx.cardLast4}</span>
                      {tx.isDemo ? (
                        <>
                          {' '}
                          <DemoBadge />
                        </>
                      ) : null}
                    </td>
                    <td className="truncate" title={`${tx.description}｜原始：${tx.rawDescription}`}>
                      {tx.description}
                    </td>
                    <td className="nowrap muted">{tx.settlementCurrency}</td>
                    <td className={`num ${tx.settlementAmountMinor < 0 ? 'amount-neg' : ''}`}>
                      {formatMinor(tx.settlementAmountMinor, tx.settlementCurrency)}
                    </td>
                    <td className="nowrap">
                      <TypeBadge type={tx.type} />
                    </td>
                    <td>
                      <select
                        className="select"
                        value={tx.category}
                        aria-label={`${tx.description} 分类`}
                        onChange={(event) => void updateTransaction({ id: tx.id, category: event.target.value as Category })}
                      >
                        {CATEGORIES.map((category) => (
                          <option key={category} value={category}>
                            {category}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="nowrap">
                      <ReviewStatusBadge status={tx.reviewStatus} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="card-pad row">
          <span className="subtle">
            第 {page + 1} / {pageCount} 页 · 共 {rows.length} 笔
          </span>
          <span className="spacer" />
          <button className="btn btn-sm" type="button" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
            上一页
          </button>
          <button className="btn btn-sm" type="button" disabled={page + 1 >= pageCount} onClick={() => setPage((p) => p + 1)}>
            下一页
          </button>
        </div>
      </div>

      <p className="subtle">
        金额排序：按结算币种代码固定分组，组内按金额数值升降序，不进行汇率换算。金额符号约定：支出为正，存入 / 还款 / 退款为负。借贷方向来自银行账单的列或分区，不依赖商户名称关键字。
      </p>
    </>
  )
}

export function transactionSortKeyOf(tx: Transaction): string {
  return `${tx.bank}|${tx.cardLast4}|${tx.transactionDate}|${tx.description}`
}

export function statusBadgeFor(status: Transaction['reviewStatus']) {
  return status === 'pending' ? <Badge tone="warn">待复核</Badge> : <ReviewStatusBadge status={status} />
}
