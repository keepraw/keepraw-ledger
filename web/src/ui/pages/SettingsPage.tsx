import { useEffect, useMemo, useRef, useState } from 'react'
import { useApp } from '../../app/AppStore'
import { getAttachment, listArchiveFiles, setArchiveFileExternal, storageEstimate, type ArchiveStatus } from '../../db/repository'
import { triggerDownload } from '../../export/tabular'
import { getDemoSnapshot } from '../../demo/demoStore'
import { parserCatalog } from '../../parsers/registry'
import { Badge, DemoBadge } from '../components/ui'

export function SettingsPage() {
  const { state, setSettings, backup, backupData, backupFull, exportLedgerXlsx, restore, archiveStatus, clearData, loadDemoData } = useApp()
  const [message, setMessage] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null)
  const [usage, setUsage] = useState<{ usage: number; quota: number } | null>(null)
  const [status, setStatus] = useState<ArchiveStatus | null>(null)
  const [archiveFiles, setArchiveFiles] = useState<Awaited<ReturnType<typeof listArchiveFiles>> | null>(null)
  const [backupError, setBackupError] = useState<string | null>(null)
  const restoreRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    void storageEstimate().then(setUsage)
  }, [state.statements.length, state.transactions.length])

  useEffect(() => {
    void archiveStatus().then(setStatus).catch(() => setStatus(null))
  }, [archiveStatus, state.demoMode, state.statements.length, state.transactions.length, state.imports.length])

  useEffect(() => {
    void listArchiveFiles().then(setArchiveFiles).catch(() => setArchiveFiles(null))
  }, [state.imports])

  const changeExternal = async (fileHash: string, external: boolean) => {
    if (!archiveFiles) return
    if (external && !window.confirm('请先下载并妥善保存原始文件。设为外部保存后，ZIP 将明确标记 external 且不包含此原件，恢复原件需要单独保存的文件。本机原件、交易和备注均保留。继续吗？')) return
    try {
      await setArchiveFileExternal(fileHash, external, archiveFiles.revision)
      setArchiveFiles(await listArchiveFiles())
      setMessage({ tone: 'ok', text: external ? '已设为外部保存；本机原件未删除。' : '已恢复包含在 ZIP 中。' })
    } catch (error) {
      setMessage({ tone: 'danger', text: error instanceof Error ? error.message : '保存失败，请刷新后重试。' })
      setArchiveFiles(await listArchiveFiles())
    }
  }

  const downloadOriginal = async (fileHash: string) => {
    try {
      const row = await getAttachment(fileHash)
      if (!row) throw new Error('原始文件已不存在，请刷新后重试。')
      triggerDownload(new Blob([row.data], { type: row.mimeType }), row.fileName)
    } catch (error) { setMessage({ tone: 'danger', text: error instanceof Error ? error.message : '下载失败，请重试。' }) }
  }

  const realCounts = {
    statements: state.statements.filter((s) => !s.isDemo).length,
    transactions: state.transactions.filter((t) => !t.isDemo).length,
  }
  // Demo rows live in memory only (see getDemoSnapshot); the counts below
  // describe that snapshot, never the production database.
  const demoSnapshot = useMemo(() => getDemoSnapshot(), [])
  const demoCounts = {
    statements: demoSnapshot.statements.length,
    transactions: demoSnapshot.transactions.length,
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>数据与设置</h1>
          <p>所有数据保存在本机浏览器的 IndexedDB 中，没有任何后端服务。</p>
        </div>
      </div>

      <div className="notice notice-info">
        <Badge tone="info">隐私</Badge>
        <div>
          <strong>账单不会离开这台设备</strong>
          <p>
            本项目没有后端、没有云端 AI 解析、没有统计埋点。导入的 PDF / EML / XLSX 只在浏览器进程内解析。
            请注意：清理浏览器数据、使用无痕窗口或更换设备都会导致 IndexedDB 中的数据丢失，建议定期导出备份。
          </p>
        </div>
      </div>

      <div className="grid grid-2">
        <div className="card">
          <div className="card-head">
            <div>
              <h2>外观</h2>
              <p>浅色 / 深色 / 跟随系统</p>
            </div>
          </div>
          <div className="card-pad stack">
            <div className="segmented" role="group" aria-label="主题">
              {(['light', 'dark', 'system'] as const).map((theme) => (
                <button
                  key={theme}
                  type="button"
                  data-testid={`theme-${theme}`}
                  aria-pressed={state.settings.theme === theme}
                  onClick={() => void setSettings({ theme })}
                >
                  {theme === 'light' ? '浅色' : theme === 'dark' ? '深色' : '跟随系统'}
                </button>
              ))}
            </div>
            <p className="subtle">语言当前为简体中文，文案结构预留了后续扩展其它语言的空间。</p>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <div>
              <h2>演示模式</h2>
              <p>使用完全虚构的数据体验全部页面</p>
            </div>
            {state.demoMode ? <DemoBadge /> : null}
          </div>
          <div className="card-pad stack">
            <label className="row" style={{ cursor: 'pointer' }}>
              <input
                type="checkbox"
                data-testid="demo-toggle"
                checked={state.demoMode}
                onChange={(event) => void setSettings({ demoMode: event.target.checked })}
              />
              <span>开启演示模式（隐藏真实数据，禁止导入）</span>
            </label>
            <p className="subtle">
              演示数据共 {demoCounts.statements} 份账单、{demoCounts.transactions} 笔交易，全部为虚构内容，卡尾号为 0000 / 9999。
              真实数据 {realCounts.statements} 份账单、{realCounts.transactions} 笔交易，演示模式开启时不会显示。
            </p>
            <p className="subtle">演示交易修改与备注仅在本次页面会话中保留，切换模式不会清除；重新生成、刷新或重新打开应用后，演示交易恢复初始状态，演示备注清空。真实账本与备份不受影响。</p>
            <button className="btn" type="button" onClick={() => void loadDemoData()}>
              重新生成演示数据
            </button>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <div>
              <h2>数据备份</h2>
              <p>备份 JSON：用于恢复应用</p>
            </div>
          </div>
          <div className="card-pad stack">
            <p className="subtle">
              备份 JSON（V2）用于恢复应用，不适合直接阅读。数据备份文件（credit-card-data.json）包含账单汇总、交易明细、复核状态、独立复核备注、导入记录与应用设置，不含 PDF / EML / XLSX 原始文件，适合日常备份。历史 V1 备份不含独立复核备注，从 V1 恢复时本地已有备注会原样保留，但全新设备无法从 V1 找回未被导出的备注。恢复按主键合并，同标识的已有记录、用户编辑与相同内容的备注会保留；金融字段或备注内容冲突时拒绝整个恢复。重复恢复不会产生重复数据。备份文件为本机未加密文件，请妥善保管。如需在外部查看分析，请使用下方的表格归档（XLSX）导出。
            </p>
            <div className="row">
              <button
                className="btn btn-primary"
                type="button"
                data-testid="backup"
                onClick={() => {
                  void backupData().catch((error: unknown) =>
                    setMessage({ tone: 'danger', text: error instanceof Error ? error.message : '导出失败' }),
                  )
                }}
              >
                备份 JSON
              </button>
              <button
                className="btn"
                type="button"
                data-testid="backup-legacy"
                onClick={() => {
                  void backup().catch((error: unknown) =>
                    setMessage({ tone: 'danger', text: error instanceof Error ? error.message : '导出失败' }),
                  )
                }}
              >
                导出备份 (JSON)
              </button>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <div>
              <h2>表格归档</h2>
              <p>导出 XLSX：用于外部查看分析</p>
            </div>
          </div>
          <div className="card-pad stack">
            <p className="subtle">
              导出 XLSX 用于在 Excel / LibreOffice 中查看和分析，不可用于恢复应用。备份 JSON 用于恢复应用；导出 XLSX
              用于脱离本应用查看自有财务历史。工作簿包含 交易明细（日常查看，可直接阅读）与 Technical Metadata（迁移审计）两个工作表，前者保留银行、卡尾号、日期、说明、类型、方向与原始币种金额，不做换算与重算，可独立打开；后者保留交易标识、账单标识、业务指纹、重复序号、来源文件与导入时间。
            </p>
            <div className="row">
              <button
                className="btn btn-primary"
                type="button"
                data-testid="export-ledger-xlsx"
                onClick={() => {
                  void exportLedgerXlsx()
                    .then(() => setMessage({ tone: 'ok', text: '表格归档（XLSX）已导出，可在 Excel / LibreOffice 中打开。' }))
                    .catch((error: unknown) =>
                      setMessage({ tone: 'danger', text: error instanceof Error ? error.message : '导出失败' }),
                    )
                }}
              >
                导出 XLSX
              </button>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <div>
              <h2>完整归档</h2>
              <p>ZIP：database.json + manifest.json + 原始文件</p>
            </div>
          </div>
          <div className="card-pad stack">
            <p className="subtle">
              完整归档（ZIP 内 database.json 为 V2）包含账单、交易、复核备注与设置，以及当前浏览器实际可访问的原始文件。历史导入若缺少附件，manifest 会如实标记为 missing，不会伪造文件。历史 V1 压缩包仍可恢复，但其中的 database.json 不含独立复核备注。备份文件为本机未加密文件，并非加密云备份。
            </p>
            {status ? (
              <p className="subtle" data-testid="archive-status">
                原始账单状态：交易记录 {status.transactionCount} 条，原始文件已归档 {status.archivedCount} 个，缺失{' '}
                {status.missingCount} 个。
              </p>
            ) : null}
            {status && status.missingCount > 0 ? (
              <div className="notice notice-warn" data-testid="archive-warning">
                <Badge tone="warn">提醒</Badge>
                <div>{status.missingCount} 个历史账单没有原始文件，仅导出交易数据。建议保留好原始 PDF / EML 备查。</div>
              </div>
            ) : null}
            <div className="row">
              <button
                className="btn btn-primary"
                type="button"
                data-testid="backup-full"
                onClick={() => {
                  setBackupError(null)
                  void backupFull().then(({ warning }) =>
                    setMessage({
                      tone: 'ok',
                      text: warning ? `完整归档已导出。${warning}。` : '完整归档已导出，含全部可访问原始文件。',
                    }),
                  ).catch((error: unknown) => setBackupError(`完整备份失败：${error instanceof Error ? error.message : '未知导出错误'}。请先导出备份 JSON；若文件过大或总量超限，在原始文件管理中下载原件并选择外部保存后重试；若校验失败，请核对原件。`))
                }}
              >
                导出完整备份
              </button>
              <button className="btn" type="button" data-testid="restore" onClick={() => restoreRef.current?.click()}>
                从备份恢复
              </button>
              <input
                ref={restoreRef}
                type="file"
                accept="application/json,.json,.zip,application/zip"
                hidden
                onChange={async (event) => {
                  const file = event.target.files?.[0]
                  event.target.value = ''
                  if (!file) return
                  const result = await restore(file)
                  setMessage({ tone: result.ok ? 'ok' : 'danger', text: result.message })
                }}
              />
            </div>
            {backupError ? <div className="notice notice-danger" role="alert" data-testid="backup-error">{backupError}</div> : null}
            {archiveFiles && archiveFiles.files.length > 0 ? (
              <div className="stack">
                <h3>原始文件管理</h3>
                <p className="subtle">ZIP 单文件上限 64 MiB、总量上限 256 MiB。超限时可先下载原件，再由你选择外部保存。外部保存不会删除本机原件或影响 JSON 备份；ZIP 清单会标记 external，恢复原件需要另外保存的文件。</p>
                {archiveFiles.files.map(file => (
                  <div className="stack" key={file.fileHash} data-testid="archive-file">
                    <div>{file.fileName}（{(file.size / 1024 / 1024).toFixed(2)} MiB）</div>
                    <div>{file.external ? '外部保存，不放入 ZIP' : '包含在 ZIP'}</div>
                    <div className="row">
                      <button className="btn btn-sm" type="button" onClick={() => void downloadOriginal(file.fileHash)}>下载原始文件</button>
                      <button className="btn btn-sm" type="button" onClick={() => void changeExternal(file.fileHash, !file.external)}>{file.external ? '恢复包含在 ZIP' : '设为外部保存'}</button>
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
            {usage ? (
              <p className="subtle">
                本地存储占用约 {(usage.usage / 1024 / 1024).toFixed(2)} MB / 配额 {(usage.quota / 1024 / 1024).toFixed(0)} MB
              </p>
            ) : null}
            <p className="subtle">浏览器存储容量有限且可能被清理；重要原始文件请另外在个人文件夹中归档保存。</p>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <div>
              <h2>清空数据</h2>
              <p>此操作不可撤销，请先导出备份</p>
            </div>
          </div>
          <div className="card-pad stack">
            <button
              className="btn btn-danger"
              type="button"
              data-testid="clear-real"
              onClick={() => {
                if (!window.confirm('确定要清空全部真实账单、交易、导入记录、原始文件与复核备注吗？此操作不可撤销。')) return
                void clearData(false).then(() => setMessage({ tone: 'ok', text: '真实数据已清空。' }))
              }}
            >
              清空真实数据
            </button>
            <button
              className="btn btn-danger"
              type="button"
              onClick={() => {
                if (!window.confirm('确定要清空全部数据（含演示数据）吗？此操作不可撤销。')) return
                void clearData(true).then(() => setMessage({ tone: 'ok', text: '全部数据已清空。' }))
              }}
            >
              清空全部数据
            </button>
            {message ? (
              <div className={`notice ${message.tone === 'ok' ? 'notice-info' : 'notice-danger'}`}>
                <Badge tone={message.tone === 'ok' ? 'ok' : 'danger'}>{message.tone === 'ok' ? '完成' : '失败'}</Badge>
                <div>{message.text}</div>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <div>
            <h2>支持的账单格式</h2>
            <p>第一阶段范围（来自 parser registry，共 {parserCatalog().length} 个解析器）</p>
          </div>
        </div>
        <div className="table-wrap">
          <table className="data" data-testid="supported-parsers">
            <thead>
              <tr>
                <th>银行</th>
                <th>文件类型</th>
                <th>解析器</th>
                <th>方向依据</th>
              </tr>
            </thead>
            <tbody>
              {parserCatalog().map((entry) => (
                <tr key={entry.id} data-testid={`parser-row-${entry.id}`}>
                  <td>{entry.bankName}</td>
                  <td>
                    {entry.fileTypeLabel} <span className="mono">({entry.sourceTypes.join(', ')})</span>
                  </td>
                  <td className="mono">{entry.id}</td>
                  <td>{entry.directionBasis}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="card-pad">
          <p className="subtle">
            其他银行暂时不会被猜测识别：无法匹配时会明确标记为「无法识别」，而不是尝试用通用正则硬解析。
          </p>
        </div>
      </div>
    </>
  )
}
