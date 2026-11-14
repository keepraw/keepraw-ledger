import { readFile } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'
import { reviewBatchFixture } from '../tests/fixtures/reviewBatch'
import type { Transaction } from '../src/core/types'

async function stored(page: Page) {
  return page.evaluate(async () => {
    const url = '/src/db/db.ts', { db } = await import(url)
    const all: Record<string, unknown[]> = {}
    for (const table of db.tables) {
      const rows = await table.toArray()
      all[table.name] = table.name === 'attachments' ? rows.map((row: {data: ArrayBuffer}) => ({ ...row, data: [...new Uint8Array(row.data)] })) : rows
    }
    return all
  })
}

for (const format of ['json-v1', 'json-v2', 'zip'] as const) {
  test(`${format}: UI restores clean native flags in v5; keeps other provenance, decisions, confidence and notes`, async ({ page, browser }, testInfo) => {
    await page.goto('/#/settings')
    await page.getByTestId('demo-toggle').uncheck()
    await page.evaluate(async fixture => {
      const url = '/src/db/db.ts', repoUrl = '/src/db/repository.ts'
      const { db } = await import(url), repository = await import(repoUrl)
      const transactions = fixture.transactions.map((row, index) => ({ ...row,
        origin: index < 4 ? 'legacy_import' : undefined,
        sourceId: index < 4 || index === 4 ? 'legacy-keepraw-ledger-export-v1' : 'legacy-python-export-v1',
        confidence: index / 10, reviewStatus: index < 4 ? ['ok', 'pending', 'confirmed', 'rejected'][index] : row.reviewStatus,
        flags: index === 1 || index === 3 ? ['suspected_duplicate', 'low_confidence', 'date_missing'] : ['low_confidence'] }))
      await db.statements.bulkPut(fixture.statements); await db.transactions.bulkPut(transactions)
      const bytes = new TextEncoder().encode('SYNTHETIC_BACKUP_CLEANUP_EVIDENCE')
      const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('')
      const record = { ...fixture.imports[0], fileHash: hash }
      await db.imports.put(record); await db.reviewNotes.bulkPut(fixture.notes)
      await repository.saveOriginalFile({ fileHash: hash, fileName: 'synthetic.txt', data: bytes.buffer, importId: record.id, parserId: record.parserId })
    }, reviewBatchFixture(6))
    await page.reload()
    const before = await stored(page)
    const download = page.waitForEvent('download')
    await page.getByTestId(format === 'zip' ? 'backup-full' : 'backup').click()
    const file = await download
    let buffer = await readFile((await file.path())!)
    if (format === 'json-v1') {
      const payload = JSON.parse(buffer.toString('utf8'))
      payload.version = 1; delete payload.reviewNotes
      buffer = Buffer.from(JSON.stringify(payload))
    }
    const fresh = await browser.newContext({ baseURL: new URL(String(testInfo.project.use.baseURL)).origin })
    try {
      const target = await fresh.newPage()
      await target.goto('/#/settings'); await target.getByTestId('demo-toggle').uncheck()
      if (format === 'json-v1') await target.evaluate(async notes => {
        const url = '/src/db/db.ts'; await (await import(url)).db.reviewNotes.bulkPut(notes)
      }, before.reviewNotes)
      const upload = { name: format === 'zip' ? 'synthetic-old.zip' : 'synthetic-old.json',
        mimeType: format === 'zip' ? 'application/zip' : 'application/json', buffer }
      if (format === 'zip') {
        const baseline = await stored(target)
        await target.evaluate(async () => {
          const url = '/src/db/db.ts', { db } = await import(url)
          const fail = () => { throw new Error('synthetic ZIP attachment failure') }
          db.attachments.hook('creating', fail)
          ;(window as typeof window & { removeRestoreFailure?: () => void }).removeRestoreFailure = () => db.attachments.hook('creating').unsubscribe(fail)
        })
        await target.locator('input[type="file"]').setInputFiles(upload)
        await expect(target.getByText(/恢复失败：.*synthetic ZIP attachment failure/)).toBeVisible()
        expect(await stored(target)).toEqual(baseline)
        await target.evaluate(() => (window as typeof window & { removeRestoreFailure?: () => void }).removeRestoreFailure?.())
      }
      await target.locator('input[type="file"]').setInputFiles(upload)
      await expect(target.getByText(/^已恢复 8 笔交易/)).toBeVisible()
      const restored = await stored(target)
      const expected = (before.transactions as Transaction[]).map(row => row.origin === 'legacy_import' && row.sourceId === 'legacy-keepraw-ledger-export-v1'
        ? { ...row, flags: row.flags.filter(flag => flag !== 'low_confidence') } : row)
      expect(restored.transactions).toEqual(expected)
      expect(restored.reviewNotes).toEqual(before.reviewNotes)
      expect(restored.statements).toEqual(before.statements)
      expect(restored.imports).toEqual(before.imports)
      if (format === 'zip') {
        const originals = restored.attachments as Array<{ data: number[] }>
        expect(originals).toHaveLength(1)
        expect(originals[0]!.data).toEqual((before.attachments as Array<{data: number[]}>)[0]!.data)
      } else expect(restored.attachments).toEqual([])
      await target.locator('input[type="file"]').setInputFiles(upload)
      await expect(target.getByText(/^已恢复 8 笔交易/)).toBeVisible()
      const repeated = await stored(target)
      for (const key of ['transactions', 'statements', 'imports', 'reviewNotes', 'attachments']) expect(repeated[key]).toEqual(restored[key])
      await target.goto('/#/review')
      const count = expected.filter(row => row.reviewStatus === 'pending' || row.flags.length > 0 && row.reviewStatus !== 'rejected').length
      await expect(target.getByRole('button', { name: `交易复核 ${count}`, exact: true })).toBeVisible()
      await target.reload()
      expect((await stored(target)).transactions).toEqual(expected)
    } finally { await fresh.close() }
  })
}
