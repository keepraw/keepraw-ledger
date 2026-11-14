import { transactionDisplayDescription } from '../../core/descriptionNormalizer'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ReviewPagination, useReviewPagination } from '../components/ReviewPagination'
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
  const { visibleStatements, visibleTransactions, updateTransaction, reviewTransactions, saveNote, state, recomputeStatement } = useApp()
  const [tab, setTab] = useState<'statements' | 'transactions'>('statements')
  const [showAllStatements, setShowAllStatements] = useState(false)
  const [selectedStatement, setSelectedStatement] = useState<string | null>(null)
  const [draft, setDraft] = useState({ demoMode: state.demoMode, text: '' })
  const draftNote = draft.demoMode === state.demoMode ? draft.text : ''
  const [noteError, setNoteError] = useState<string | null>(null)
  useEffect(() => { setDraft({ demoMode: state.demoMode, text: '' }); setNoteError(null) }, [state.demoMode])
  const [recomputing, setRecomputing] = useState(false)
  const [recomputeError, setRecomputeError] = useState<string | null>(null)
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
  const statementPagination = useReviewPagination(reviewStatements.length, `${state.demoMode}:${showAllStatements}`)
  const pageStatements = reviewStatements.slice(statementPagination.start, statementPagination.end)
  const active = pageStatements.find(s => s.id === selectedStatement) ?? pageStatements[0] ?? null
  const statementTransactions = useMemo(
    () => active ? visibleTransactions.filter(tx => tx.statementId === active.id) : [], [active, visibleTransactions],
  )
  const detailPagination = useReviewPagination(statementTransactions.length, active?.id)
  const transactionPagination = useReviewPagination(flaggedTransactions.length, state.demoMode)
  const pageTransactions = useMemo(() => flaggedTransactions.slice(transactionPagination.start, transactionPagination.end),
    [flaggedTransactions, transactionPagination.start, transactionPagination.end])
  const duplicateDetails = useMemo(() => buildDuplicateReviewDetails(visibleTransactions,
    pageTransactions.filter(tx => tx.flags.includes('suspected_duplicate'))), [visibleTransactions, pageTransactions])
  const flaggedById = useMemo(() => new Map(flaggedTransactions.map(tx => [tx.id, tx])), [flaggedTransactions])
  const [selection, setSelection] = useState({ demoMode: state.demoMode, ids: new Set<string>() })
  const selectedIds = useMemo(() => selection.demoMode === state.demoMode
    ? [...selection.ids].filter(id => flaggedById.has(id)) : [], [selection, state.demoMode, flaggedById])
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds])
  const allPageSelected = pageTransactions.length > 0 && pageTransactions.every(tx => selectedSet.has(tx.id))
  const pageCheckbox = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (pageCheckbox.current) pageCheckbox.current.indeterminate = !allPageSelected && pageTransactions.some(tx => selectedSet.has(tx.id))
  }, [allPageSelected, pageTransactions, selectedSet, tab])
  const [confirmation, setConfirmation] = useState<{ ids: string[]; decision: 'confirmed' | 'rejected'; demoMode: boolean } | null>(null)
  const confirmationRef = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const element = confirmationRef.current
    if (!element || !confirmation || confirmation.demoMode !== state.demoMode) return
    if (typeof element.showModal === 'function') element.showModal()
    else element.setAttribute('open', '')
  }, [confirmation, state.demoMode])
  const [reviewError, setReviewError] = useState<string | null>(null)
  const [reviewBusy, setReviewBusy] = useState(false)
  const submitting = useRef(false)
  useEffect(() => {
    setSelection({ demoMode: state.demoMode, ids: new Set() }); setConfirmation(null); setReviewError(null)
  }, [state.demoMode])
  const choose = (ids: string[], checked: boolean) => setSelection(current => {
    const next = new Set(current.demoMode === state.demoMode ? [...current.ids].filter(id => flaggedById.has(id)) : [])
    for (const id of ids) { if (checked) next.add(id); else next.delete(id) }
    return { demoMode: state.demoMode, ids: next }
  })
  const applyBatch = async () => {
    if (!confirmation || submitting.current || confirmation.demoMode !== state.demoMode) return
    submitting.current = true; setReviewBusy(true); setReviewError(null)
    try {
      await reviewTransactions(confirmation.ids, confirmation.decision)
      setSelection({ demoMode: state.demoMode, ids: new Set() }); setConfirmation(null)
    } catch (error) {
      setReviewError(error instanceof Error ? error.message : '批量复核失败，本次操作未提交，请重试。')
    } finally { submitting.current = false; setReviewBusy(false) }
  }
  const confirmTransaction = async (tx: Transaction, decision: 'confirmed' | 'rejected'): Promise<void> => {
    if (submitting.current) return
    submitting.current = true; setReviewBusy(true); setReviewError(null)
    try { await updateTransaction({ id: tx.id, reviewStatus: decision, flags: decision === 'confirmed' ? [] : tx.flags }) }
    catch (error) { setReviewError(error instanceof Error ? error.message : '复核失败，请重试。') }
    finally { submitting.current = false; setReviewBusy(false) }
  }
  const noteEntries = useMemo(() => Object.entries(state.notes), [state.notes])
  const notePagination = useReviewPagination(noteEntries.length, state.demoMode)

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
          <p>{state.demoMode ? '演示交易的修改与备注仅在本次会话内保留，重新生成或刷新后重置。' : '对账差额、疑似重复和未完成分类的交易都会集中在这里，复核状态会持久保存在本机。'}</p>
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

      {reviewError && !confirmation ? <div className="notice notice-warn" role="alert">{reviewError}</div> : null}
      {confirmation && confirmation.demoMode === state.demoMode ? (
        <dialog ref={confirmationRef} className="card card-pad stack" style={{ maxWidth: 'min(36rem, calc(100vw - 2rem))', margin: 'auto' }} onCancel={event => { if (reviewBusy) event.preventDefault(); else setConfirmation(null) }} aria-modal="true" aria-label={confirmation.decision === 'confirmed' ? '批量确认交易' : '批量排除交易'}>
          <h2>确定批量{confirmation.decision === 'confirmed' ? '确认' : '排除'} {confirmation.ids.length.toLocaleString('en-US')} 笔交易吗？</h2>
          <p>{confirmation.decision === 'confirmed' ? '确认后会清空所选交易的复核标记。' : '排除后会保留原有标记，所选交易将退出复核队列。'}</p>
          {confirmation.decision === 'confirmed' && confirmation.ids.some(id => flaggedById.get(id)?.flags.includes('suspected_duplicate')) ? <p className="notice notice-warn">所选记录包含疑似重复交易：确认后会清除疑似重复标记，这些交易将不再因该标记进入复核队列。请先核对来源和交易次数。</p> : null}
          {confirmation.ids.some(id => !flaggedById.has(id)) ? <p role="alert">待复核记录已变化，请取消并重新选择。</p> : null}
          {reviewError ? <p className="notice notice-warn" role="alert">{reviewError}</p> : null}
          <div className="row">
            <button className="btn" type="button" disabled={reviewBusy} onClick={() => setConfirmation(null)}>取消</button>
            <button className="btn btn-primary" type="button" disabled={reviewBusy || confirmation.ids.some(id => !flaggedById.has(id))} onClick={() => void applyBatch()}>
              {reviewBusy ? '正在提交…' : confirmation.decision === 'confirmed' ? '确定批量确认' : '确定批量排除'}
            </button>
          </div>
        </dialog>
      ) : null}
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
                    {pageStatements.map((statement) => (
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

            <ReviewPagination label="账单对账" pagination={statementPagination} />
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
                        {statementTransactions.slice(detailPagination.start, detailPagination.end).map((tx) => (
                          <tr key={tx.id}>
                            <td className="nowrap">{tx.transactionDate}</td>
                            <td className="truncate" title={tx.rawDescription}>
                              {transactionDisplayDescription(tx)}
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
                  <ReviewPagination label="账单交易" pagination={detailPagination} />
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
          <div className="card-pad stack">
            <div className="row" style={{ flexWrap: 'wrap' }}>
              <button className="btn btn-sm" type="button" disabled={reviewBusy} onClick={() => choose(flaggedTransactions.map(tx => tx.id), true)}>全选全部待复核 {flaggedTransactions.length.toLocaleString('en-US')} 笔</button>
              <button className="btn btn-sm" type="button" disabled={reviewBusy || selectedIds.length === 0} onClick={() => setSelection({ demoMode: state.demoMode, ids: new Set() })}>清空选择</button>
              <span data-testid="review-selection-count">已选择 {selectedIds.length.toLocaleString('en-US')} 笔</span>
              <button className="btn btn-sm" type="button" disabled={reviewBusy || selectedIds.length === 0} onClick={() => { setReviewError(null); setConfirmation({ ids: [...selectedIds], decision: 'confirmed', demoMode: state.demoMode }) }}>批量确认</button>
              <button className="btn btn-sm btn-danger" type="button" disabled={reviewBusy || selectedIds.length === 0} onClick={() => { setReviewError(null); setConfirmation({ ids: [...selectedIds], decision: 'rejected', demoMode: state.demoMode }) }}>批量排除</button>
            </div>
          </div>
          <div className="table-wrap">
            <table className="data" data-testid="review-table">
              <thead>
                <tr>
                  <th><input ref={pageCheckbox} type="checkbox" aria-label="全选当前页" checked={allPageSelected} disabled={reviewBusy} onChange={event => choose(pageTransactions.map(tx => tx.id), event.target.checked)} /></th>
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
                {pageTransactions.map((tx) => (
                  <tr key={tx.id}>
                    <td><input type="checkbox" aria-label={`选择交易 ${tx.id}`} value={tx.id} checked={selectedSet.has(tx.id)} disabled={reviewBusy} onChange={event => choose([tx.id], event.target.checked)} /></td>
                    <td className="nowrap">{tx.transactionDate}</td>
                    <td className="truncate" title={tx.rawDescription}>
                      {transactionDisplayDescription(tx)}
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
                        <button className="btn btn-sm" type="button" disabled={reviewBusy} onClick={() => void confirmTransaction(tx, 'confirmed')}>
                          确认
                        </button>
                        <button className="btn btn-sm btn-danger" type="button" disabled={reviewBusy} onClick={() => void confirmTransaction(tx, 'rejected')}>
                          排除
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ReviewPagination label="交易复核" pagination={transactionPagination} />
        </div>
      )}

      {state.demoMode ? (
        <div className="notice notice-warn">
          <DemoBadge />
          <div>
            <strong>演示备注与真实备注隔离</strong>
            <p>演示交易修改与备注仅保存在当前页面会话的内存中；切换模式后保留，重新生成、刷新或重新打开应用后清除，不写入真实账本或备份。</p>
          </div>
        </div>
      ) : null}

      {flaggedTransactions.length > 0 ? (
        <div className="card">
          <div className="card-head">
            <div>
              <h2>复核备注</h2>
              <p>{state.demoMode ? '针对第一笔演示交易记录备注，仅在本次会话中保留。' : '可以针对第一笔待复核交易记录备注，备注会持久保存在本机'}</p>
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
              onChange={(event) => setDraft({ demoMode: state.demoMode, text: event.target.value })}
            />
            <button
              className="btn"
              type="button"
              onClick={() => {
                const target = flaggedTransactions[0]
                if (!target) return
                setNoteError(null)
                void saveNote(target.id, draftNote).then(() => setDraft({ demoMode: state.demoMode, text: '' })).catch(error => {
                  setNoteError(error instanceof Error ? error.message : '保存备注失败，请重试。')
                })
              }}
            >
              保存备注
            </button>
          </div>
          {noteError ? <div className="notice notice-warn" role="alert">{noteError}</div> : null}
          {Object.keys(state.notes).length > 0 ? (
            <div className="card-pad stack">
              {noteEntries.slice(notePagination.start, notePagination.end).map(([id, note]) => {
                const tx = transactionsById.get(id)
                return (
                  <div key={id} className="check">
                    <Badge tone="muted">备注</Badge>
                    <div>
                      <div>{note}</div>
                      <div className="check-detail">{tx ? `${tx.transactionDate} ${transactionDisplayDescription(tx)}` : '该交易已不存在'}</div>
                    </div>
                  </div>
                )
              })}
            </div>
          ) : null}
          {noteEntries.length > 0 ? <ReviewPagination label="复核备注" pagination={notePagination} /> : null}
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
              <td>{row.transactionDate} / {row.postingDate}</td><td>{transactionDisplayDescription(row)}</td>
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
