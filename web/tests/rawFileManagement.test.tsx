import { fireEvent, render, screen, within } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { RawFileManagement } from '../src/ui/components/RawFileManagement'
import type { listArchiveFiles } from '../src/db/repository'

type ArchiveFile = Awaited<ReturnType<typeof listArchiveFiles>>['files'][number]
const MiB = 1024 * 1024
const file = (index: number, extra: Partial<ArchiveFile> = {}): ArchiveFile => ({
  fileHash: `synthetic-${index}`, fileName: `synthetic-${index}.pdf`, bank: 'boc',
  size: MiB, external: false, missing: false, ...extra,
})
const actions = () => ({ downloadOriginal: vi.fn().mockResolvedValue(undefined), changeExternal: vi.fn().mockResolvedValue(undefined) })

it('shows a compact collapsed summary with mutually exclusive ZIP/external/missing counts and local byte total', () => {
  render(<RawFileManagement files={[file(1), file(2, { external: true, size: 2 * MiB }),
    file(3, { missing: true }), file(4, { external: true, missing: true })]} {...actions()} />)
  expect(screen.getByTestId('raw-file-summary')).toHaveTextContent('共 4 个文件 · 本机原件总大小 3.00 MiB · 包含在 ZIP 1 个（1.00 MiB） · 外部保存 2 个 · 缺失 1 个')
  expect(screen.getByRole('button', { name: '查看原始文件（4）' })).toHaveAttribute('aria-expanded', 'false')
  expect(screen.queryByRole('table')).not.toBeInTheDocument()
  expect(screen.queryByText('synthetic-1.pdf')).not.toBeInTheDocument()
  expect(screen.getByText(/ZIP 单文件上限 64.00 MiB、总量上限 256.00 MiB/)).toBeInTheDocument()
})

it('expands to a compact table and preserves download/toggle callbacks while disabling unavailable originals', () => {
  const callbacks = actions()
  render(<RawFileManagement files={[file(1), file(2, { external: true }), file(3, { missing: true, bank: 'unknown' })]} {...callbacks} />)
  fireEvent.click(screen.getByRole('button', { name: '查看原始文件（3）' }))
  const rows = within(screen.getByRole('table', { name: '原始文件列表' })).getAllByRole('row')
  expect(rows).toHaveLength(4)
  expect(rows[1]).toHaveTextContent('中国银行')
  fireEvent.click(within(rows[1]!).getByRole('button', { name: '下载原始文件' }))
  expect(callbacks.downloadOriginal).toHaveBeenCalledWith('synthetic-1')
  fireEvent.click(within(rows[1]!).getByRole('button', { name: '设为外部保存' }))
  expect(callbacks.changeExternal).toHaveBeenCalledWith('synthetic-1', true)
  fireEvent.click(within(rows[2]!).getByRole('button', { name: '恢复包含在 ZIP' }))
  expect(callbacks.changeExternal).toHaveBeenCalledWith('synthetic-2', false)
  expect(rows[3]).toHaveTextContent('缺失')
  expect(within(rows[3]!).getByRole('button', { name: '下载原始文件' })).toBeDisabled()
  expect(within(rows[3]!).getByRole('button', { name: '设为外部保存' })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: '收起原始文件（3）' }))
  expect(screen.queryByRole('table')).not.toBeInTheDocument()
})

it('bounds the list with existing pagination and searches filenames case-insensitively, resetting the page', () => {
  render(<RawFileManagement files={Array.from({ length: 105 }, (_, index) => file(index))} {...actions()} />)
  fireEvent.click(screen.getByRole('button', { name: '查看原始文件（105）' }))
  expect(screen.getAllByTestId('archive-file')).toHaveLength(100)
  const pagination = screen.getByRole('navigation', { name: '原始文件分页' })
  fireEvent.click(within(pagination).getByRole('button', { name: '下一页' }))
  expect(screen.getAllByTestId('archive-file')).toHaveLength(5)
  expect(pagination).toHaveTextContent('第 2 / 2 页')
  fireEvent.change(screen.getByRole('textbox', { name: '搜索原始文件名' }), { target: { value: 'SYNTHETIC-10' } })
  expect(screen.getAllByTestId('archive-file')).toHaveLength(6)
  expect(pagination).toHaveTextContent('第 1 / 1 页')
  fireEvent.change(screen.getByRole('textbox', { name: '搜索原始文件名' }), { target: { value: 'absent' } })
  expect(screen.getByText('没有匹配的原始文件。')).toBeInTheDocument()
})

it('surfaces oversized originals without expansion, including external files, with a direct link to their actions', () => {
  render(<RawFileManagement files={[file(1, { size: 65 * MiB }), file(2, { size: 300 * MiB, external: true })]} {...actions()} />)
  const warning = screen.getByTestId('raw-file-limits')
  expect(warning).toHaveTextContent('2 个本机原件超过 ZIP 单文件上限')
  expect(warning).not.toHaveTextContent('超过 256.00 MiB 总量上限')
  expect(within(warning).getByRole('button', { name: 'synthetic-1.pdf' })).toBeVisible()
  expect(screen.queryByRole('table')).not.toBeInTheDocument()
  fireEvent.click(within(warning).getByRole('button', { name: 'synthetic-1.pdf' }))
  expect(screen.getAllByTestId('archive-file')).toHaveLength(1)
  expect(screen.getByRole('textbox', { name: '搜索原始文件名' })).toHaveValue('synthetic-1.pdf')
})

it('warns when ZIP original bytes exceed the total limit and caps the summary to five largest contributors', () => {
  render(<RawFileManagement files={Array.from({ length: 6 }, (_, index) => file(index, { size: (50 + index) * MiB }))} {...actions()} />)
  const warning = screen.getByTestId('raw-file-limits')
  expect(warning).toHaveTextContent('超过 256.00 MiB 总量上限')
  expect(warning).toHaveTextContent('另有 1 个相关文件')
  expect(within(warning).getAllByRole('button')).toHaveLength(5)
  expect(within(warning).getAllByRole('button')[0]).toHaveTextContent('synthetic-5.pdf')
  expect(screen.queryByRole('table')).not.toBeInTheDocument()
})

it('handles empty archives and exact limit boundaries without false warnings', () => {
  const view = render(<RawFileManagement files={[]} {...actions()} />)
  expect(screen.getByTestId('raw-file-summary')).toHaveTextContent('共 0 个文件')
  fireEvent.click(screen.getByRole('button', { name: '查看原始文件（0）' }))
  expect(screen.getByText('没有匹配的原始文件。')).toBeInTheDocument()
  view.rerender(<RawFileManagement files={Array.from({ length: 4 }, (_, index) => file(index, { size: 64 * MiB }))} {...actions()} />)
  expect(screen.queryByTestId('raw-file-limits')).not.toBeInTheDocument()
})
