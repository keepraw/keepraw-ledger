import { useEffect, useState } from 'react'

/** Clamp immediately after rows shrink; retain the valid page for later changes. */
export function useReviewPagination(total: number, resetKey: unknown) {
  const [page, setPage] = useState(0)
  const [pageSize, setSize] = useState(100)
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  const currentPage = Math.min(page, pageCount - 1)
  useEffect(() => setPage(current => Math.min(current, pageCount - 1)), [pageCount])
  useEffect(() => setPage(0), [resetKey])
  return { page: currentPage, pageSize, pageCount, total,
    setPage, setPageSize: (size: number) => { setSize(size); setPage(0) },
    start: currentPage * pageSize, end: Math.min((currentPage + 1) * pageSize, total) }
}

export function ReviewPagination({ label, pagination }: {
  label: string; pagination: ReturnType<typeof useReviewPagination>
}) {
  const { page, pageSize, pageCount, total, start, end, setPage, setPageSize } = pagination
  return (
    <nav className="card-pad row" aria-label={`${label}分页`} style={{ flexWrap: 'wrap' }}>
      <span>共 {total.toLocaleString('en-US')} 笔 · {total ? start + 1 : 0}–{end} / {total.toLocaleString('en-US')}</span>
      <label>每页 <select className="select" aria-label={`${label}每页笔数`} value={pageSize} onChange={event => setPageSize(Number(event.target.value))}>
        {[50, 100, 200].map(size => <option value={size} key={size}>{size}</option>)}
      </select> 笔</label>
      <button className="btn btn-sm" type="button" disabled={page === 0} onClick={() => setPage(0)}>首页</button>
      <button className="btn btn-sm" type="button" disabled={page === 0} onClick={() => setPage(page - 1)}>上一页</button>
      <span>第 {page + 1} / {pageCount} 页</span>
      <button className="btn btn-sm" type="button" disabled={page + 1 >= pageCount} onClick={() => setPage(page + 1)}>下一页</button>
      <button className="btn btn-sm" type="button" disabled={page + 1 >= pageCount} onClick={() => setPage(pageCount - 1)}>末页</button>
    </nav>
  )
}
