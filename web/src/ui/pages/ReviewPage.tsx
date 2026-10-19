import { useMemo, useState } from 'react'
import { useApp } from '../../app/AppStore'
import { formatMinor } from '../../core/money'
import { buildDuplicateReviewDetails } from '../../core/migrationAudit'
import { REVIEW_FLAG_LABELS, bankName, type Transaction } from '../../core/types'
import { MAX_NOTE_CHARS } from '../../backup/validation'
import {
  Badge,
  DemoBadge,
  EmptyState,
  FlagList,
  ReconciliationChecks,
  ReviewStatusBadge,
  StatementStatusBadge,
  TypeBadge,
} from '../components/ui'

export function ReviewPage() {
  const { visibleStatements, visibleTransactions, updateTransaction, saveNote, state, recomputeStatement } = useApp()
  const [tab, setTab] = useState<'statements' | 'transactions'>('statements')
  const [showAllStatements, setShowAllStatements] = useState(false)
  const [selectedStatement, setSelectedStatement] = useState<string | null>(null)
  const [draftNote, setDraftNote] = useState('')
  const [recomputing, setRecomputing] = useState(false)
  const [recomputeError, setRecomputeError] = useState<string | null>(null)
  const duplicateDetails = useMemo(() => buildDuplicateReviewDetails(visibleTransactions,
    visibleTransactions.filter((tx) => tx.flags.includes('suspected_duplicate'))), [visibleTransactions])
  const transactionsById = useMemo(() => new Map(visibleTransactions.map((tx) => [tx.id, tx])), [visibleTransactions])

  const flaggedStatements = useMemo(
    // Imported history has no balance to reconcile, so it never enters the review queue.
    () => visibleStatements.filter((statement) => statement.status !== 'reconciled' && statement.status !== 'imported'),
    [visibleStatements],
  )
  const flaggedTransactions = useMemo(
    () =>
      visibleTransactions.filter(
        (tx) => tx.reviewStatus === 'pending' || (tx.flags.length > 0 && tx.reviewStatus !== 'rejected'),
      ),
    [visibleTransactions],
  )

  const reviewStatements = showAllStatements ? visibleStatements : flaggedStatements
  const active = reviewStatements.find((s) => s.id === selectedStatement) ?? reviewStatements[0] ?? null
  const statementTransactions = useMemo(
    () => (active ? visibleTransactions.filter((tx) => tx.statementId === active.id) : []),
    [active, visibleTransactions],
  )

  const confirmTransaction = async (tx: Transaction, decision: 'confirmed' | 'rejected'): Promise<void> => {
    await updateTransaction({
      id: tx.id,
      reviewStatus: decision,
      flags: decision === 'confirmed' ? [] : tx.flags,
    })
  }

  const recompute = async (statementId: string): Promise<void> => {
    setRecomputing(true)
    setRecomputeError(null)
    try {
      await recomputeStatement(statementId)
    } catch (error) {
      setRecomputeError(error instanceof Error ? error.message : '保存对账结果失败，请重试。')
    } finally {
      setRecomputing(false)
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>人工复核</h1>
          <p>对账差额、疑似重复和未完成分类的交易都会集中在这里，复核状态会持久保存在本机。</p>
        </div>
        <div className="segmented">
          <button type="button" aria-pressed={tab === 'statements'} onClick={() => setTab('statements')}>
            账单对账 {flaggedStatements.length}
          </button>
          <button type="button" aria-pressed={tab === 'transactions'} onClick={() => setTab('transactions')}>
            交易复核 {flaggedTransactions.length}
          </button>
        </div>
      </div>

      {recomputeError ? <div className="notice notice-warn" role="alert">{recomputeError}</div> : null}

      {tab === 'statements' ? (
        <label className="row">
          <input type="checkbox" checked={showAllStatements} onChange={event => setShowAllStatements(event.target.checked)} />
          显示全部账单（可重新核对历史状态）
        </label>
      ) : null}

      {tab === 'statements' ? (
        reviewStatements.length === 0 ? (
          <div className="card">
            <EmptyState title="所有账单都已通过对账" hint="导入新账单后，若账单汇总与交易明细不一致，会在这里列出差额。" />
          </div>
        ) : (
          <>
            <div className="card">
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>账单</th>
                      <th>状态</th>
                      <th className="num">本期应还</th>
                      <th className="num">交易数</th>
                      <th>来源</th>
                    </tr>
                  </thead>
                  <tbody>
                    {reviewStatements.map((statement) => (
                      <tr
                        key={statement.id}
                        onClick={() => setSelectedStatement(statement.id)}
                        style={{ cursor: 'pointer', background: active?.id === statement.id ? 'var(--surface-muted)' : undefined }}
                      >
                        <td>
                          {bankName(statement.bank)} 尾号{statement.cardLast4}
                          <div className="subtle">
                            {statement.cycleStart && statement.cycleEnd ? `${statement.cycleStart} ~ ${statement.cycleEnd}` : '账单周期未知'}
                          </div>
                        </td>
                        <td>
                          <StatementStatusBadge statement={statement} />
                          {statement.isDemo ? <DemoBadge /> : null}
                        </td>
                        <td className="num">
                          {statement.summary.currentBalanceMinor === null ? '—' : formatMinor(statement.summary.currentBalanceMinor)}
                        </td>
                        <td className="num">{statement.transactionCount}</td>
                        <td className="subtle truncate">{statement.sourceFileName}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {active ? (
              <div className="card">
                <div className="card-head">
                  <div>
                    <h2>
                      {bankName(active.bank)} 尾号{active.cardLast4} 对账明细
                    </h2>
                    <p>
                      交易修改后自动保存对账结果；也可重新核对并保存历史账单状态。
                    </p>
                  </div>
                  <button className="btn btn-sm" type="button" disabled={recomputing || state.demoMode} onClick={() => void recompute(active.id)}>
                    {recomputing ? '正在保存对账结果…' : '重新核对并保存'}
                  </button>
                </div>
                <div className="card-pad stack">
                  <ReconciliationChecks statement={active} />

                  <h3>账单汇总原始值</h3>
                  <div className="table-wrap">
                    <table className="data">
                      <thead>
                        <tr>
                          <th>字段</th>
                          <th className="num">金额</th>
                        </tr>
                      </thead>
                      <tbody>
                        <SummaryRow label="上期余额" minor={active.summary.previousBalanceMinor} />
                        <SummaryRow label="本期新增支出" minor={active.summary.newDebitMinor} />
                        <SummaryRow label="本期还款及其他贷记" minor={active.summary.newCreditMinor} />
                        <SummaryRow label="费用" minor={active.summary.chargeMinor} />
                        <SummaryRow label="利息" minor={active.summary.interestMinor} />
                        <SummaryRow label="本期应还" minor={active.summary.currentBalanceMinor} strong />
                        <SummaryRow label="最小还款额" minor={active.summary.minimumPaymentMinor} />
                      </tbody>
                    </table>
                  </div>

                  <h3>该账单的交易（{statementTransactions.length} 笔）</h3>
                  <div className="table-wrap">
                    <table className="data">
                      <thead>
                        <tr>
                          <th>交易日</th>
                          <th>描述</th>
                          <th className="num">金额</th>
                          <th>类型</th>
                          <th>复核</th>
                        </tr>
                      </thead>
                      <tbody>
                        {statementTransactions.map((tx) => (
                          <tr key={tx.id}>
                            <td className="nowrap">{tx.transactionDate}</td>
                            <td className="truncate" title={tx.rawDescription}>
                              {tx.description}
                            </td>
                            <td className={`num ${tx.settlementAmountMinor < 0 ? 'amount-neg' : ''}`}>
                              {formatMinor(tx.settlementAmountMinor, tx.settlementCurrency)}
                            </td>
                            <td>
                              <TypeBadge type={tx.type} />
                            </td>
                            <td>
                              <ReviewStatusBadge status={tx.reviewStatus} />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            ) : null}
          </>
        )
      ) : flaggedTransactions.length === 0 ? (
        <div className="card">
          <EmptyState title="没有需要复核的交易" hint="疑似重复、低置信度或未分类的交易会出现在这里。" />
        </div>
      ) : (
        <div className="card">
          <div className="table-wrap">
            <table className="data" data-testid="review-table">
              <thead>
                <tr>
                  <th>交易日</th>
                  <th>描述</th>
                  <th className="num">金额</th>
                  <th>类型</th>
                  <th>原因</th>
                  <th>复核状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {flaggedTransactions.map((tx) => (
                  <tr key={tx.id}>
                    <td className="nowrap">{tx.transactionDate}</td>
                    <td className="truncate" title={tx.rawDescription}>
                      {tx.description}
                    </td>
                    <td className={`num ${tx.settlementAmountMinor < 0 ? 'amount-neg' : ''}`}>
                      {formatMinor(tx.settlementAmountMinor, tx.settlementCurrency)}
                    </td>
                    <td>
                      <TypeBadge type={tx.type} />
                    </td>
                    <td>
                      <FlagList flags={tx.flags} />
                      {tx.flags.includes('suspected_duplicate') ? (
                        <DuplicateComparison
                          transaction={tx}
                          candidates={(duplicateDetails.get(tx.id)?.candidateIds ?? []).flatMap((id) => {
                            const peer = transactionsById.get(id)
                            return peer ? [peer] : []
                          })}
                          candidateCount={duplicateDetails.get(tx.id)?.candidateCount ?? 0}
                          differingFields={duplicateDetails.get(tx.id)?.differingFields ?? []}
                        />
                      ) : null}
                    </td>
                    <td>
                      <ReviewStatusBadge status={tx.reviewStatus} />
                    </td>
                    <td>
                      <div className="row row-tight">
                        <button className="btn btn-sm" type="button" onClick={() => void confirmTransaction(tx, 'confirmed')}>
                          确认
                        </button>
                        <button className="btn btn-sm btn-danger" type="button" onClick={() => void confirmTransaction(tx, 'rejected')}>
                          排除
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {state.demoMode ? (
        <div className="notice notice-warn">
          <DemoBadge />
          <div>
            <strong>复核操作只作用于演示数据</strong>
            <p>演示模式下真实账单已被隐藏，复核结果同样保存在本机 IndexedDB 中。</p>
          </div>
        </div>
      ) : null}

      {flaggedTransactions.length > 0 ? (
        <div className="card">
          <div className="card-head">
            <div>
              <h2>复核备注</h2>
              <p>可以针对第一笔待复核交易记录备注，备注会持久保存在本机</p>
            </div>
          </div>
          <div className="card-pad row">
            <input
              className="input"
              style={{ flex: 1 }}
              placeholder="例如：与银行 App 对账一致，确认为退款"
              value={draftNote}
              // Cap new input at the validated backup bound; previously stored
              // longer notes remain fully backable up to the same bound.
              maxLength={MAX_NOTE_CHARS}
              onChange={(event) => setDraftNote(event.target.value)}
            />
            <button
              className="btn"
              type="button"
              onClick={() => {
                const target = flaggedTransactions[0]
                if (!target) return
                void saveNote(target.id, draftNote)
                setDraftNote('')
              }}
            >
              保存备注
            </button>
          </div>
          {Object.keys(state.notes).length > 0 ? (
            <div className="card-pad stack">
              {Object.entries(state.notes).map(([id, note]) => {
                const tx = visibleTransactions.find((row) => row.id === id)
                return (
                  <div key={id} className="check">
                    <Badge tone="muted">备注</Badge>
                    <div>
                      <div>{note}</div>
                      <div className="check-detail">{tx ? `${tx.transactionDate} ${tx.description}` : '该交易已不存在'}</div>
                    </div>
                  </div>
                )
              })}
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  )
}

function SummaryRow({ label, minor, strong }: { label: string; minor: number | null; strong?: boolean }) {
  return (
    <tr>
      <td style={strong ? { fontWeight: 600 } : undefined}>{label}</td>
      <td className="num" style={strong ? { fontWeight: 600 } : undefined}>
        {minor === null ? '—' : formatMinor(minor)}
      </td>
    </tr>
  )
}

export const REVIEW_FLAG_ORDER = Object.keys(REVIEW_FLAG_LABELS) as Array<keyof typeof REVIEW_FLAG_LABELS>

const DIFFERENCE_LABELS: Record<string, string> = {
  postingDate: '入账日', description: '描述', type: '类型', direction: '方向',
  transactionCurrency: '原币币种', transactionAmountMinor: '原币金额',
}

function DuplicateComparison({ transaction, candidates, candidateCount, differingFields }: {
  transaction: Transaction; candidates: Transaction[]; candidateCount: number; differingFields: string[]
}) {
  return (
    <details data-testid="duplicate-comparison">
      <summary>查看疑似重复对照（{candidateCount} 笔候选）</summary>
      <p>保留全部记录；确认前统计可能重复累计。以下最多显示 3 笔候选，不代表同一真实交易。</p>
      <p>示例差异：{differingFields.map((field) => DIFFERENCE_LABELS[field] ?? field).join('、') || '所列业务字段相同，仍需核实来源和交易次数'}</p>
      {candidates.length === 0 ? <p>当前账本无法定位候选，请对照原始文件核实。</p> : null}
      <div className="table-wrap">
        <table className="data">
          <thead><tr><th>记录</th><th>银行 / 卡尾号</th><th>交易日 / 入账日</th><th>描述</th><th>原币金额</th><th>结算金额</th><th>类型 / 方向</th><th>来源</th><th>复核状态</th></tr></thead>
          <tbody>{[transaction, ...candidates].map((row, index) => (
            <tr key={row.id}>
              <td>{index === 0 ? '当前交易' : '候选交易'}</td>
              <td>{bankName(row.bank)} / {row.cardLast4}</td>
              <td>{row.transactionDate} / {row.postingDate}</td><td>{row.description}</td>
              <td>{row.transactionCurrency} {formatMinor(row.transactionAmountMinor, row.transactionCurrency)}</td>
              <td>{row.settlementCurrency} {formatMinor(row.settlementAmountMinor, row.settlementCurrency)}</td>
              <td><TypeBadge type={row.type} /> / {row.direction === 'credit' ? '贷记' : '借记'}</td>
              <td>{row.sourceFileName}{row.sourceRow === null ? '' : `（来源行 ${row.sourceRow}）`}</td>
              <td><ReviewStatusBadge status={row.reviewStatus} /></td>
            </tr>
          ))}</tbody>
        </table>
      </div>
    </details>
  )
}
