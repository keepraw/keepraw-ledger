import { useMemo, useState } from 'react'
import { bankName } from '../../core/types'
import type { listArchiveFiles } from '../../db/repository'
import { MAX_ENTRY_BYTES, MAX_EXPANDED_BYTES } from '../../backup/zipSafety'
import { ReviewPagination, useReviewPagination } from './ReviewPagination'

type ArchiveFile = Awaited<ReturnType<typeof listArchiveFiles>>['files'][number]
const sizeLabel = (size: number) => `${(size / 1024 / 1024).toFixed(2)} MiB`

export function RawFileManagement({ files, downloadOriginal, changeExternal }: {
  files: ArchiveFile[]
  downloadOriginal: (fileHash: string) => Promise<void>
  changeExternal: (fileHash: string, external: boolean) => Promise<void>
}) {
  const [expanded, setExpanded] = useState(false)
  const [search, setSearch] = useState('')
  const included = files.filter(file => !file.external && !file.missing)
  const includedSize = included.reduce((sum, file) => sum + file.size, 0)
  const localSize = files.reduce((sum, file) => sum + (file.missing ? 0 : file.size), 0)
  const oversized = files.filter(file => !file.missing && file.size > MAX_ENTRY_BYTES)
  const totalExceeded = includedSize > MAX_EXPANDED_BYTES
  const warningFiles = useMemo(() => files.filter(file => !file.missing &&
    (file.size > MAX_ENTRY_BYTES || (totalExceeded && !file.external)))
    .sort((a, b) => b.size - a.size), [files, totalExceeded])
  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return files.filter(file => file.fileName.toLowerCase().includes(needle))
  }, [files, search])
  const pagination = useReviewPagination(filtered.length, search)

  return (
    <section className="stack" aria-label="原始文件管理">
      <h3>原始文件管理</h3>
      <p data-testid="raw-file-summary">
        共 {files.length} 个文件 · 本机原件总大小 {sizeLabel(localSize)} · 包含在 ZIP {included.length} 个（{sizeLabel(includedSize)}）
        {' '}· 外部保存 {files.filter(file => file.external).length} 个 · 缺失 {files.filter(file => file.missing && !file.external).length} 个
      </p>
      <p className="subtle">ZIP 单文件上限 {sizeLabel(MAX_ENTRY_BYTES)}、总量上限 {sizeLabel(MAX_EXPANDED_BYTES)}（含交易数据与清单）。超限时可先下载原件，再选择外部保存。外部保存不会删除本机原件或影响 JSON 备份；ZIP 清单会标记 external，恢复原件需要另外保存的文件。</p>
      {warningFiles.length > 0 ? (
        <div className="notice notice-warn" role="status" data-testid="raw-file-limits">
          <div>
            {oversized.length > 0 ? <p>{oversized.length} 个本机原件超过 ZIP 单文件上限；已设为外部保存的文件不占 ZIP 容量。</p> : null}
            {totalExceeded ? <p>待放入 ZIP 的原件合计 {sizeLabel(includedSize)}，超过 {sizeLabel(MAX_EXPANDED_BYTES)} 总量上限。请将部分文件设为外部保存。</p> : null}
            <ul>
              {warningFiles.slice(0, 5).map(file => (
                <li key={file.fileHash}>
                  <button className="btn btn-sm" type="button" onClick={() => { setSearch(file.fileName); setExpanded(true) }}>
                    {file.fileName}
                  </button> · {sizeLabel(file.size)} · {file.external ? '外部保存，不放入 ZIP' : '包含在 ZIP'}
                </li>
              ))}
            </ul>
            {warningFiles.length > 5 ? <p>仅显示最大的 5 个文件，另有 {warningFiles.length - 5} 个相关文件，请展开列表查看。</p> : null}
          </div>
        </div>
      ) : null}
      <button className="btn btn-sm" type="button" aria-expanded={expanded} aria-controls="raw-file-list" onClick={() => setExpanded(value => !value)}>
        {expanded ? '收起原始文件' : '查看原始文件'}（{files.length}）
      </button>
      {expanded ? (
        <div className="stack" id="raw-file-list">
          <input className="input" aria-label="搜索原始文件名" placeholder="搜索文件名" value={search} onChange={event => setSearch(event.target.value)} />
          <div className="table-wrap">
            <table className="data" aria-label="原始文件列表">
              <thead><tr><th>文件名</th><th>银行</th><th className="num">大小</th><th>状态</th><th>操作</th></tr></thead>
              <tbody>
                {filtered.slice(pagination.start, pagination.end).map(file => (
                  <tr key={file.fileHash} data-testid="archive-file">
                    <td className="truncate" title={file.fileName}>{file.fileName}</td>
                    <td className="nowrap">{file.bank === 'unknown' ? '—' : bankName(file.bank)}</td>
                    <td className="num nowrap">{sizeLabel(file.size)}{file.missing ? '（导入时）' : ''}</td>
                    <td>{file.external ? '外部保存，不放入 ZIP' : file.missing ? '缺失' : '包含在 ZIP'}{file.external && file.missing ? '（本机无原件）' : ''}</td>
                    <td><div className="row">
                      <button className="btn btn-sm" type="button" disabled={file.missing} onClick={() => void downloadOriginal(file.fileHash)}>下载原始文件</button>
                      <button className="btn btn-sm" type="button" disabled={file.missing} onClick={() => void changeExternal(file.fileHash, !file.external)}>{file.external ? '恢复包含在 ZIP' : '设为外部保存'}</button>
                    </div></td>
                  </tr>
                ))}
                {filtered.length === 0 ? <tr><td colSpan={5}>没有匹配的原始文件。</td></tr> : null}
              </tbody>
            </table>
          </div>
          <ReviewPagination label="原始文件" pagination={pagination} />
        </div>
      ) : null}
    </section>
  )
}
