import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { db } from '../src/db/db'
import { listArchiveFiles } from '../src/db/repository'
import { SettingsPage } from '../src/ui/pages/SettingsPage'
import { ingestSynthetic } from './fixtures/identity'
import { triggerDownload } from '../src/export/tabular'

const app = vi.hoisted(() => ({ state: { statements: [], transactions: [], imports: [], demoMode: false,
  settings: { theme: 'light', demoMode: false, locale: 'zh-CN' } },
  archiveStatus: vi.fn().mockResolvedValue({ transactionCount: 0, importCount: 0, archivedCount: 0, missingCount: 0 }),
}))
vi.mock('../src/app/AppStore', () => ({ useApp: () => app }))
vi.mock('../src/export/tabular', () => ({ triggerDownload: vi.fn() }))
vi.mock('../src/db/repository', async importOriginal => ({
  ...await importOriginal<typeof import('../src/db/repository')>(), storageEstimate: vi.fn().mockResolvedValue(null),
}))
beforeEach(async () => {
  vi.restoreAllMocks(); vi.clearAllMocks()
  await db.delete(); await db.open()
  const record = ingestSynthetic(['消费 合成原件']).record
  await db.imports.bulkPut([{ ...record, id: 'first', fileName: 'synthetic.pdf', fileHash: 'synthetic', fileSize: 3 },
    { ...record, id: 'duplicate', fileName: 'synthetic.pdf', fileHash: 'synthetic', fileSize: 3 },
    { ...record, id: 'missing', fileName: 'missing.pdf', fileHash: 'missing', fileSize: 12 },
    { ...record, id: 'external', fileName: 'external.pdf', fileHash: 'external', fileSize: 12 },
    { ...record, id: 'demo', fileName: 'demo.pdf', fileHash: 'demo', isDemo: true }])
  await db.settings.put({ key: 'archive:external:external', value: true })
  await db.attachments.put({ fileHash: 'synthetic', fileName: 'synthetic.pdf', mimeType: 'application/pdf', size: 3,
    data: new Uint8Array([1, 2, 3]).buffer, importId: 'first', parserId: 'synthetic', importedAt: record.importedAt })
})

it('lists unique evidence files including missing/external references, but excludes demo imports', async () => {
  const result = await listArchiveFiles()
  expect(result.files).toHaveLength(3)
  expect(result.files.find(file => file.fileHash === 'synthetic')).toMatchObject({ bank: 'boc', size: 3, missing: false, external: false })
  expect(result.files.find(file => file.fileHash === 'missing')).toMatchObject({ missing: true, external: false })
  expect(result.files.find(file => file.fileHash === 'external')).toMatchObject({ missing: true, external: true })
})

it('retains download, external-choice confirmation/cancellation, refresh, and restoring ZIP inclusion', async () => {
  render(<SettingsPage />)
  expect(await screen.findByTestId('raw-file-summary')).toHaveTextContent('包含在 ZIP 1 个')
  expect(screen.queryByRole('table', { name: '原始文件列表' })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '查看原始文件（3）' }))
  const row = screen.getAllByTestId('archive-file').find(row => row.textContent?.includes('synthetic.pdf'))!
  fireEvent.click(within(row).getByRole('button', { name: '下载原始文件' }))
  await waitFor(() => expect(triggerDownload).toHaveBeenCalledWith(expect.any(Blob), 'synthetic.pdf'))
  const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true)
  fireEvent.click(within(row).getByRole('button', { name: '设为外部保存' }))
  expect(confirm).toHaveBeenCalledTimes(1)
  expect((await listArchiveFiles()).files.find(file => file.fileHash === 'synthetic')!.external).toBe(false)
  fireEvent.click(within(row).getByRole('button', { name: '设为外部保存' }))
  await waitFor(() => expect(row).toHaveTextContent('外部保存，不放入 ZIP'))
  expect(screen.getByTestId('raw-file-summary')).toHaveTextContent('包含在 ZIP 0 个')
  fireEvent.click(within(row).getByRole('button', { name: '恢复包含在 ZIP' }))
  await waitFor(() => expect(within(row).getByRole('button', { name: '设为外部保存' })).toBeEnabled())
  expect(confirm).toHaveBeenCalledTimes(2)
})

it('shows the existing download error if an original disappears before clicking', async () => {
  render(<SettingsPage />)
  await screen.findByTestId('raw-file-summary')
  fireEvent.click(screen.getByRole('button', { name: '查看原始文件（3）' }))
  const row = screen.getAllByTestId('archive-file').find(row => row.textContent?.includes('synthetic.pdf'))!
  await db.attachments.delete('synthetic')
  fireEvent.click(within(row).getByRole('button', { name: '下载原始文件' }))
  expect(await screen.findByText('原始文件已不存在，请刷新后重试。')).toBeInTheDocument()
  expect(triggerDownload).not.toHaveBeenCalled()
})
