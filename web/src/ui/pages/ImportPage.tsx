import { useCallback, useRef, useState } from 'react'
import { useApp } from '../../app/AppStore'
import { bankName, type ImportStatus } from '../../core/types'
import type { LegacyPreview } from '../../importers/types'
import { Badge, DemoBadge, EmptyState } from '../components/ui'

const STATUS_META: Record<ImportStatus, { label: string; tone: 'ok' | 'warn' | 'danger' | 'info' | 'muted' }> = {
  parsed: { label: '解析成功', tone: 'ok' },
  needs_review: { label: '待复核', tone: 'warn' },
  duplicate: { label: '重复文件', tone: 'muted' },
  failed: { label: '解析失败', tone: 'danger' },
  unsupported: { label: '无法识别', tone: 'danger' },
  imported: { label: '历史导入', tone: 'info' },
}

export function ImportPage() {
  const { importFiles, previewLegacyImport, confirmLegacyImport, state, visibleImports } = useApp()
  const [dragging, setDragging] = useState(false)
  const [results, setResults] = useState<ReturnType<typeof importFiles> extends Promise<infer T> ? T : never>([])
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [legacyPreview, setLegacyPreview] = useState<LegacyPreview | null>(null)
  const [legacyError, setLegacyError] = useState<string | null>(null)
  const [legacyBusy, setLegacyBusy] = useState(false)
  const legacyInputRef = useRef<HTMLInputElement>(null)

  const handleFiles = useCallback(
    async (files: File[]) => {
      setError(null)
      try {
        const records = await importFiles(files)
        setResults(records)
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : '导入失败')
        setResults([])
      }
    },
    [importFiles],
  )

  const blocked = state.demoMode

  const handleLegacyFile = useCallback(
    async (file: File) => {
      setLegacyError(null)
      setLegacyPreview(null)
      setLegacyBusy(true)
      try {
        setLegacyPreview(await previewLegacyImport(file))
      } catch (caught) {
        setLegacyError(caught instanceof Error ? caught.message : '历史数据预览失败')
      } finally {
        setLegacyBusy(false)
      }
    },
    [previewLegacyImport],
  )

  const handleLegacyConfirm = useCallback(async () => {
    if (!legacyPreview) return
    setLegacyError(null)
    setLegacyBusy(true)
    try {
      const record = await confirmLegacyImport(legacyPreview)
      setResults([record])
      setLegacyPreview(null)
    } catch (caught) {
      setLegacyError(caught instanceof Error ? caught.message : '历史数据导入失败')
    } finally {
      setLegacyBusy(false)
    }
  }, [confirmLegacyImport, legacyPreview])

  return (
    <>
      <div className="page-head">
        <div>
          <h1>账单导入</h1>
          <p>文件全程在浏览器内解析，不会被上传到任何服务器。</p>
        </div>
        <Badge tone="info">本地处理</Badge>
      </div>

      {blocked ? (
        <div className="notice notice-warn">
          <Badge tone="demo">演示模式</Badge>
          <div>
            <strong>演示模式下无法导入真实账单</strong>
            <p>请先在「数据与设置」中关闭演示模式，避免演示数据与真实账单混在一起。</p>
          </div>
        </div>
      ) : null}

      <div className="card">
        <div className="card-pad">
          <input
            ref={inputRef}
            type="file"
            accept=".pdf,.eml"
            multiple
            hidden
            data-testid="file-input"
            onChange={(event) => {
              const files = Array.from(event.target.files ?? [])
              event.target.value = ''
              if (files.length) void handleFiles(files)
            }}
          />
          <button
            type="button"
            className={`dropzone ${dragging ? 'is-active' : ''}`}
            disabled={blocked}
            data-testid="dropzone"
            onClick={() => inputRef.current?.click()}
            onDragOver={(event) => {
              event.preventDefault()
              setDragging(true)
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              event.preventDefault()
              setDragging(false)
              const files = Array.from(event.dataTransfer.files ?? [])
              if (files.length) void handleFiles(files)
            }}
          >
            <h2>{dragging ? '松开即可解析' : '拖拽 PDF / EML 账单到这里'}</h2>
            <p>也可以点击选择文件，支持一次导入多个文件。第一版支持中国银行文字型 PDF 与交通银行 HTML 邮件账单。</p>
          </button>

          {state.progress ? (
            <div className="stack" style={{ marginTop: 16 }}>
              <div className="row">
                <span className="muted">
                  {state.progress.fileName} · {state.progress.phase}（{state.progress.index + 1}/{state.progress.total}）
                </span>
              </div>
              <div className="progress-line">
                <span style={{ width: `${((state.progress.index + 1) / state.progress.total) * 100}%` }} />
              </div>
            </div>
          ) : null}

          {error ? (
            <div className="notice notice-danger" style={{ marginTop: 16 }}>
              <Badge tone="danger">导入失败</Badge>
              <div>{error}</div>
            </div>
          ) : null}
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <div>
            <h2>历史 Excel 导入</h2>
            <p>历史 XLSX 直接在浏览器中迁移，无需 Python 或 SQLite。仅支持已知历史格式。</p>
          </div>
          <Badge tone="info">Legacy Import</Badge>
        </div>
        <div className="card-pad stack">
          <p className="subtle">
            接受三种历史格式及原生 Keepraw-Ledger 交易导出：<span className="mono">unified_transactions.xlsx</span>（
            <span className="mono">标准字段</span>表，格式 legacy-python-export-v1），或用户维护的{' '}
            <span className="mono">2026信用卡账单.xlsx</span>（<span className="mono">交易明细</span>表，
            银行 / 卡尾号 / 交易日 / 入账日 / 说明 / 交易币种 / 交易金额 / 结算币种 / 结算金额，
            格式 legacy-keepraw-export-v1），以及“统一账单”表（银行名称 / 卡号 / 交易日期 / 入账日期 /
            交易详情 / 交易币种 / 交易金额 / 入账币种 / 入账金额）。不符合任一格式的文件会被拒绝，
            原生交易导出支持完整 20 列或含原始描述的 21 列（legacy-keepraw-ledger-export-v1）。不会尝试猜测列含义。预览阶段只读不写，确认后一次性写入。
          </p>
          <input
            ref={legacyInputRef}
            type="file"
            accept=".xlsx"
            hidden
            data-testid="legacy-file-input"
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (file) void handleLegacyFile(file)
            }}
          />
          <div className="row">
            <button
              className="btn"
              type="button"
              disabled={blocked || legacyBusy}
              data-testid="legacy-select"
              onClick={() => legacyInputRef.current?.click()}
            >
              {legacyBusy ? '处理中…' : '选择历史 Excel 文件'}
            </button>
            {legacyPreview ? (
              <button className="btn" type="button" data-testid="legacy-cancel" onClick={() => setLegacyPreview(null)}>
                取消
              </button>
            ) : null}
          </div>

          {legacyError ? (
            <div className="notice notice-danger" data-testid="legacy-error">
              <Badge tone="danger">无法导入</Badge>
              <div>{legacyError}</div>
            </div>
          ) : null}

          {legacyPreview ? (
            <div className="stack" data-testid="legacy-preview">
              <div className="row">
                <Badge tone="info">{legacyPreview.stats.formatName}</Badge>
                <span className="mono subtle">{legacyPreview.stats.formatId}</span>
              </div>
              <p data-testid="legacy-preview-summary">
                共 {legacyPreview.stats.totalRows} 行数据，可导入 {legacyPreview.stats.validRows} 笔，
                异常 {legacyPreview.stats.anomalyRows} 行
                {legacyPreview.stats.dateRange
                  ? `，日期范围 ${legacyPreview.stats.dateRange.min} ~ ${legacyPreview.stats.dateRange.max}`
                  : ''}
                ，涉及银行：
                {legacyPreview.stats.banks.map((bank) => (bank === 'unknown' ? '未知' : bankName(bank))).join('、') || '—'}。
              </p>
              {legacyPreview.stats.cards?.length ? <p>银行 / 卡尾号：{legacyPreview.stats.cards.join('、')}</p> : null}
              {legacyPreview.identityWarnings?.length ? (
                <div className="notice notice-warn" data-testid="legacy-identity-warnings">
                  <div>身份或重复警告（冲突时拒绝整次导入）：</div>
                  <ul>{legacyPreview.identityWarnings.map(issue => <li key={issue.rowNumber}>第 {issue.rowNumber} 行：{issue.detail}</li>)}</ul>
                </div>
              ) : null}
              {legacyPreview.stats.anomalyRows > 0 ? (
                <p className="subtle" data-testid="legacy-preview-anomalies">
                  异常明细：必填缺失 {legacyPreview.stats.anomaliesByKind.missing_field} 行，
                  日期无法解析 {legacyPreview.stats.anomaliesByKind.date_unparseable} 行，
                  金额无法解析 {legacyPreview.stats.anomaliesByKind.amount_unparseable} 行，
                  字段无效 {legacyPreview.stats.anomaliesByKind.invalid_field ?? 0} 行，
                  身份冲突 {legacyPreview.stats.anomaliesByKind.identity_conflict ?? 0} 行。
                  异常行不会被导入。
                </p>
              ) : null}
              {(legacyPreview.reviewIssues?.length ?? 0) > 0 ? (
                <div className="notice notice-warn">
                  <div>{legacyPreview.stats.formatId === 'legacy-keepraw-ledger-export-v1' ? '导入复核提示（原值保留）：' : '发现未来日期，原值保留，不自动改年份：'}</div>
                  <ul>{legacyPreview.reviewIssues!.map((issue) => <li key={issue.rowNumber}>第 {issue.rowNumber} 行：{issue.detail}</li>)}</ul>
                </div>
              ) : null}
              {legacyPreview.migrationAudit && (legacyPreview.migrationAudit.reviewCandidates > 0 ||
                legacyPreview.migrationAudit.exactCandidates > legacyPreview.stats.alreadyStored) ? (
                <div className="notice notice-warn" data-testid="legacy-migration-review">
                  存在与账本相近但不能安全确认重复的交易，导入后会保留并标记待复核。
                  分类、入账日、描述或原币金额差异需要对照来源核实，不会自动合并。
                </div>
              ) : null}
              {legacyPreview.anomalies.length > 0 ? (
                <details><summary>查看排除行及原因</summary><ul>{legacyPreview.anomalies.map((issue) =>
                  <li key={issue.rowNumber}>第 {issue.rowNumber} 行：{issue.detail}</li>)}</ul></details>
              ) : null}
              {legacyPreview.stats.duplicateFile && legacyPreview.stats.formatId === 'legacy-keepraw-ledger-export-v1' &&
                legacyPreview.stats.validRows > legacyPreview.stats.alreadyStored ? (
                <div className="notice notice-warn" data-testid="legacy-incremental-recovery">
                  <Badge tone="warn">增量恢复</Badge>
                  <div>该原生文件此前已导入。已存在 {legacyPreview.stats.alreadyStored} 笔，
                    本次可新增 {legacyPreview.stats.validRows - legacyPreview.stats.alreadyStored} 笔；现有交易及本地修改会保留，身份冲突时拒绝导入。</div>
                </div>
              ) : legacyPreview.stats.duplicateFile ? (
                <div className="notice notice-warn">
                  <Badge tone="warn">重复文件</Badge>
                  <div>该文件此前已导入，确认后不会产生重复交易。</div>
                </div>
              ) : legacyPreview.stats.alreadyStored > 0 ? (
                <div className="notice notice-warn">
                  <Badge tone="warn">部分已存在</Badge>
                  <div>其中 {legacyPreview.stats.alreadyStored} 笔交易已在账本中，确认后会自动跳过。</div>
                </div>
              ) : null}
              <div className="row">
                <button
                  className="btn btn-primary"
                  type="button"
                  disabled={legacyBusy || legacyPreview.identityWarnings?.some(issue => issue.blocking)}
                  data-testid="legacy-confirm"
                  onClick={() => void handleLegacyConfirm()}
                >
                  确认导入 {legacyPreview.stats.formatId === 'legacy-keepraw-ledger-export-v1'
                    ? legacyPreview.stats.validRows - legacyPreview.stats.alreadyStored : legacyPreview.stats.validRows} 笔
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {results.length > 0 ? (
        <div className="card">
          <div className="card-head">
            <div>
              <h2>本次导入结果</h2>
              <p>不识别的银行或文件会明确标记为失败，不会伪装成成功。</p>
            </div>
          </div>          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>文件</th>
                  <th>状态</th>
                  <th>银行</th>
                  <th>卡尾号</th>
                  <th>账单周期</th>
                  <th className="num">交易数</th>
                  <th>说明</th>
                </tr>
              </thead>
              <tbody>
                {results.map((record) => {
                  const meta = STATUS_META[record.status]
                  return (
                    <tr key={record.id} data-testid="import-row">
                      <td className="truncate" title={record.fileName}>
                        {record.fileName}
                      </td>
                      <td>
                        <Badge tone={meta.tone}>{meta.label}</Badge>
                      </td>
                      <td>{record.bank === 'unknown' ? '—' : bankName(record.bank)}</td>
                      <td>{record.cardLast4 || '—'}</td>
                      <td className="nowrap">{record.cycleStart && record.cycleEnd ? `${record.cycleStart} ~ ${record.cycleEnd}` : '—'}</td>
                      <td className="num">{record.transactionCount}</td>
                      <td className="muted">{record.message}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      <div className="card">
        <div className="card-head">
          <div>
            <h2>导入历史</h2>
            <p>文件 SHA-256 指纹用于识别重复导入</p>
          </div>
          {state.demoMode ? <DemoBadge /> : null}
        </div>
        {visibleImports.length === 0 ? (
          <EmptyState title="还没有导入记录" hint="导入的文件会显示在这里，包含指纹、银行与账单周期。" />
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>文件</th>
                  <th>状态</th>
                  <th>银行 / 卡</th>
                  <th>账单周期</th>
                  <th className="num">交易数</th>
                  <th>SHA-256</th>
                  <th>时间</th>
                </tr>
              </thead>
              <tbody>
                {visibleImports
                  .slice()
                  .sort((a, b) => b.importedAt.localeCompare(a.importedAt))
                  .map((record) => {
                    const meta = STATUS_META[record.status]
                    return (
                      <tr key={record.id}>
                        <td className="truncate" title={record.fileName}>
                          {record.fileName}
                          {record.isDemo ? <Badge tone="demo">演示</Badge> : null}
                        </td>
                        <td>
                          <Badge tone={meta.tone}>{meta.label}</Badge>
                        </td>
                        <td>
                          {record.bank === 'unknown' ? '—' : bankName(record.bank)} {record.cardLast4 || ''}
                        </td>
                        <td className="nowrap">{record.cycleStart && record.cycleEnd ? `${record.cycleStart} ~ ${record.cycleEnd}` : '—'}</td>
                        <td className="num">{record.transactionCount}</td>
                        <td className="mono subtle">{record.fileHash.slice(0, 16)}…</td>
                        <td className="nowrap subtle">{new Date(record.importedAt).toLocaleString('zh-CN')}</td>
                      </tr>
                    )
                  })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {visibleImports.some((r) => r.status === 'needs_review') ? (
        <div className="notice notice-warn">
          <Badge tone="warn">待处理</Badge>
          <div>
            <strong>有账单需要人工复核</strong>
            <p>这些账单已解析，但未通过对账校验，因此没有计入统计。请到「人工复核」页查看差额与原始片段。</p>
          </div>
        </div>
      ) : null}
    </>
  )
}
