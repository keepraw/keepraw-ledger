import { expect, test, type Page } from '@playwright/test'
import { syntheticStatement } from '../tests/fixtures/identity'
import { SYNTHETIC_CCB_HTML } from '../tests/fixtures/ccbEml'

async function ready(page: Page) {
  await page.goto('/#/settings')
  await page.getByTestId('demo-toggle').uncheck()
}
async function seedOld(page: Page) {
  await page.evaluate(async parsed => {
    const repoUrl = '/src/db/repository.ts', dbUrl = '/src/db/db.ts', ingestUrl = '/src/core/ingest.ts', extractUrl = '/src/parsers/extract.ts'
    const repo = await import(repoUrl), { db } = await import(dbUrl), { ingestParsedStatement } = await import(ingestUrl), { sha256Hex } = await import(extractUrl)
    const data = new ArrayBuffer(65 * 1024 * 1024), fileHash = await sha256Hex(data)
    const result = ingestParsedStatement(parsed, { fileName: 'synthetic-old-65MiB.pdf', fileHash, fileSize: data.byteLength, sourceType: 'pdf' }, await repo.readSnapshot())
    await repo.persistImportResults([result])
    await repo.setReviewNote(result.transactions[0].id, 'synthetic preserved note')
    // An actual old database row, deliberately bypassing new-upload guards.
    await db.attachments.put({ fileHash, data, size: data.byteLength, fileName: 'synthetic-old-65MiB.pdf', mimeType: 'application/pdf', importId: result.record.id, parserId: result.record.parserId, importedAt: result.record.importedAt })
  }, syntheticStatement(['消费 合成商户']))
  await page.reload()
}
async function data(page: Page) {
  return page.evaluate(async () => {
    const repoUrl = '/src/db/repository.ts'
    const backup = await (await import(repoUrl)).exportDataBackup()
    return { transactions: backup.transactions, statements: backup.statements, imports: backup.imports, notes: backup.reviewNotes }
  })
}

test('new oversized uploads are rejected before reading and never enter original attachments', async ({ page }) => {
  await ready(page)
  await page.evaluate(() => {
    const original = File.prototype.arrayBuffer
    File.prototype.arrayBuffer = function () { throw new Error(`unexpected full read: ${this.name}; ${original.name}`) }
  })
  await page.goto('/#/import')
  await page.getByTestId('file-input').setInputFiles({ name: 'synthetic-oversized.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(25 * 1024 * 1024 + 1) })
  await expect(page.getByTestId('import-row').first()).toContainText(/25.*MiB/)
  expect(await page.evaluate(async () => {
    const url = '/src/db/db.ts'; return (await import(url)).db.attachments.count()
  })).toBe(0)
})

test('old oversized evidence: actionable export error, cancellation, external choice, ZIP restore and unchanged JSON', async ({ page, context }) => {
  await ready(page); await seedOld(page)
  const before = await data(page)
  await page.getByTestId('backup-full').click()
  await expect(page.getByTestId('backup-error')).toContainText(/synthetic-old-65MiB.pdf.*64.*MiB/)
  await expect(page.getByTestId('backup-error')).toContainText('外部保存')
  const management = page.getByTestId('archive-file').filter({ hasText: 'synthetic-old-65MiB.pdf' })
  const jsonDownload = page.waitForEvent('download')
  await page.getByTestId('backup').click()
  expect((await jsonDownload).suggestedFilename()).toMatch(/\.json$/)
  page.once('dialog', dialog => void dialog.dismiss())
  await management.getByRole('button', { name: '设为外部保存' }).click()
  await expect(management).toContainText('包含在 ZIP')
  expect(await data(page)).toEqual(before)
  const originalDownload = page.waitForEvent('download')
  await management.getByRole('button', { name: '下载原始文件' }).click()
  const original = await originalDownload
  expect(original.suggestedFilename()).toBe('synthetic-old-65MiB.pdf')
  const { stat } = await import('node:fs/promises')
  expect((await stat((await original.path())!)).size).toBe(65 * 1024 * 1024)
  page.once('dialog', dialog => void dialog.accept())
  await management.getByRole('button', { name: '设为外部保存' }).click()
  await expect(management).toContainText('外部保存，不放入 ZIP')
  const zipDownload = page.waitForEvent('download')
  await page.getByTestId('backup-full').click()
  const zip = await zipDownload
  await expect(page.getByText(/完整归档已导出.*外部保存/)).toBeVisible()
  expect(await data(page)).toEqual(before)
  expect(await page.evaluate(async () => {
    const url = '/src/db/db.ts'; return (await import(url)).db.attachments.count()
  })).toBe(1)
  const fresh = await context.browser()!.newContext()
  try {
    const restored = await fresh.newPage()
    await restored.goto('/#/settings')
    await restored.setInputFiles('input[type="file"][accept*=".json"]', (await zip.path())!)
    await expect(restored.getByText(/已恢复 1 笔交易.*外部保存/)).toBeVisible()
    expect(await data(restored)).toEqual(before)
    const manifest = await restored.evaluate(async () => {
      const url = '/src/backup/archive.ts'
      return (await (await import(url)).buildFullBackupZip()).manifest
    })
    // On a new device the externally kept file is honestly missing locally.
    expect(manifest.files[0].storage).toBe('missing')
  } finally { await fresh.close() }
})

test('an external-file choice in another tab preserves a paused import and rejects stale choices', async ({ page, context }) => {
  await ready(page); await seedOld(page)
  const other = await context.newPage()
  await other.goto('/#/import')
  await other.evaluate(() => {
    const original = File.prototype.arrayBuffer
    File.prototype.arrayBuffer = async function () {
      const result = await original.call(this)
      const runtime = window as typeof window & { paused?: boolean; release?: () => void }
      runtime.paused = true
      await new Promise<void>(resolve => { runtime.release = resolve })
      return result
    }
  })
  const captured = await page.evaluate(async () => {
    const url = '/src/db/repository.ts'; return (await import(url)).listArchiveFiles()
  })
  await other.getByTestId('file-input').setInputFiles({ name: 'synthetic-concurrent.html', mimeType: 'text/html', buffer: Buffer.from(SYNTHETIC_CCB_HTML) })
  await other.waitForFunction(() => (window as typeof window & { paused?: boolean }).paused)
  page.once('dialog', dialog => void dialog.accept())
  await page.getByTestId('archive-file').getByRole('button', { name: '设为外部保存' }).click()
  await expect(page.getByTestId('archive-file')).toContainText('外部保存，不放入 ZIP')
  const stale = await page.evaluate(async captured => {
    const url = '/src/db/repository.ts'
    try { await (await import(url)).setArchiveFileExternal(captured.files[0].fileHash, false, captured.revision); return 'unexpected success' }
    catch (error) { return (error as Error).message }
  }, captured)
  expect(stale).toContain('其他标签页')
  await other.evaluate(() => (window as typeof window & { release?: () => void }).release?.())
  await expect(other.getByTestId('import-row').first()).toContainText('解析成功')
  const after = await data(other)
  expect(after.transactions).toHaveLength(15)
  expect(after.imports).toHaveLength(2)
  expect(after.notes).toHaveLength(1)
  await page.reload()
  await expect(page.getByTestId('archive-file').filter({ hasText: 'synthetic-old-65MiB.pdf' })).toContainText('外部保存，不放入 ZIP')
  await other.close()
})
