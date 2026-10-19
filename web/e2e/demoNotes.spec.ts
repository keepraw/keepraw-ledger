import { expect, test, type Page } from '@playwright/test'
import { syntheticStatement } from '../tests/fixtures/identity'

async function stored(page: Page) {
  return page.evaluate(async () => {
    const repoUrl = '/src/db/repository.ts', dbUrl = '/src/db/db.ts'
    const repository = await import(repoUrl), { db } = await import(dbUrl)
    return { snapshot: await repository.readSnapshot(), notes: await db.reviewNotes.toArray(),
      attachments: await db.attachments.toArray(), backup: await repository.exportDataBackup() }
  })
}

test('demo notes never expose or modify real and orphan notes, IndexedDB or V2 backups', async ({ page }) => {
  await page.goto('/#/settings')
  await page.getByTestId('demo-toggle').uncheck()
  await page.evaluate(async parsed => {
    const repoUrl = '/src/db/repository.ts', ingestUrl = '/src/core/ingest.ts'
    const repository = await import(repoUrl), { ingestParsedStatement } = await import(ingestUrl)
    const result = ingestParsedStatement(parsed, { fileName: 'synthetic.txt', fileHash: 'synthetic', fileSize: 1, sourceType: 'text' }, await repository.readSnapshot())
    await repository.persistImportResults([result])
    await repository.setReviewNote(result.transactions[0].id, 'REAL_SYNTHETIC_PRIVATE_NOTE')
    await repository.setReviewNote('synthetic-orphan', 'ORPHAN_SYNTHETIC_PRIVATE_NOTE')
  }, syntheticStatement(['消费 合成商户']))
  await page.reload()
  await page.goto('/#/review')
  await expect(page.getByText('REAL_SYNTHETIC_PRIVATE_NOTE', { exact: true })).toBeVisible()
  await expect(page.getByText('ORPHAN_SYNTHETIC_PRIVATE_NOTE', { exact: true })).toBeVisible()
  const before = await stored(page)
  await page.goto('/#/settings')
  await page.getByTestId('demo-toggle').check()
  await page.goto('/#/review')
  await expect(page.getByText('REAL_SYNTHETIC_PRIVATE_NOTE', { exact: true })).toHaveCount(0)
  await expect(page.getByText('ORPHAN_SYNTHETIC_PRIVATE_NOTE', { exact: true })).toHaveCount(0)
  await page.getByPlaceholder('例如：与银行 App 对账一致，确认为退款').fill('DEMO_SYNTHETIC_NOTE')
  await page.getByRole('button', { name: '保存备注' }).click()
  await expect(page.getByText('DEMO_SYNTHETIC_NOTE', { exact: true })).toBeVisible()
  const during = await stored(page)
  expect(during.snapshot).toEqual(before.snapshot)
  expect(during.notes).toEqual(before.notes)
  expect(during.attachments).toEqual(before.attachments)
  expect(during.backup.reviewNotes).toEqual(before.backup.reviewNotes)
  expect(JSON.stringify(during.backup)).not.toContain('DEMO_SYNTHETIC_NOTE')
  const zip = await page.evaluate(async () => {
    const archiveUrl = '/src/backup/archive.ts', zipUrl = '/node_modules/jszip/dist/jszip.min.js'
    const { buildFullBackupZip } = await import(archiveUrl)
    const JSZip = (await import(zipUrl)).default
    const archive = await JSZip.loadAsync(await (await buildFullBackupZip()).blob.arrayBuffer())
    return archive.file('database.json').async('string')
  })
  expect(zip).toContain('REAL_SYNTHETIC_PRIVATE_NOTE')
  expect(zip).toContain('ORPHAN_SYNTHETIC_PRIVATE_NOTE')
  expect(zip).not.toContain('DEMO_SYNTHETIC_NOTE')
  await page.goto('/#/settings')
  await page.getByTestId('demo-toggle').uncheck()
  await page.goto('/#/review')
  await expect(page.getByText('REAL_SYNTHETIC_PRIVATE_NOTE', { exact: true })).toBeVisible()
  await expect(page.getByText('ORPHAN_SYNTHETIC_PRIVATE_NOTE', { exact: true })).toBeVisible()
  await expect(page.getByText('DEMO_SYNTHETIC_NOTE', { exact: true })).toHaveCount(0)
  const after = await stored(page)
  expect(after.snapshot).toEqual(before.snapshot)
  expect(after.notes).toEqual(before.notes)
  await page.reload()
  expect((await stored(page)).notes).toEqual(before.notes)
})
