import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { db } from '../src/db/db'
import { exportDataBackup, persistLegacyImport } from '../src/db/repository'
import { planLegacyImport, previewLegacyWorkbook } from '../src/importers/legacyImport'
import { sha256Hex } from '../src/parsers/extract'
import { EMPTY_SNAPSHOT } from './fixtures/identity'
import { nativeCells, nativeDisplayCells, nativeWorkbook } from './fixtures/nativeLedger'

it('runs the local acceptance command in isolated memory and rejects an incorrect partial-import baseline', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'keepraw-native-audit-'))
  await db.delete(); await db.open()
  try {
    const buffer = nativeWorkbook([nativeCells(1), nativeDisplayCells(), nativeCells(3)])
    const meta = { fileName: 'private-synthetic.xlsx', fileHash: await sha256Hex(buffer), fileSize: buffer.byteLength }
    const full = await previewLegacyWorkbook(buffer, meta, EMPTY_SNAPSHOT)
    const partial = { ...full, rows: full.rows.filter(row => row.description === 'Synthetic Store') }
    await persistLegacyImport(planLegacyImport(partial, EMPTY_SNAPSHOT))
    const backup = JSON.stringify(await exportDataBackup())
    const xlsxPath = join(directory, 'private-synthetic.xlsx')
    const backupPath = join(directory, 'private-synthetic.json')
    await writeFile(xlsxPath, Buffer.from(buffer), { mode: 0o600 })
    await writeFile(backupPath, backup, { mode: 0o600 })
    const args = [resolve('scripts/native-recovery-audit.mjs'), '--xlsx', xlsxPath, '--backup', backupPath,
      '--expect-total', '3', '--expect-stored', '2', '--expect-new', '1']
    const output = execFileSync(process.execPath, args, { encoding: 'utf8', timeout: 20_000 })
    expect(JSON.parse(output)).toMatchObject({ validation: 'passed',
      firstImport: { total: 3, valid: 3, excluded: 0, alreadyStored: 2, newlyInserted: 1, duplicateFile: true,
        blockingConflicts: 0, remainingMissing: 0, storedWorkbookIds: 3, existingRecordsUnchanged: true, notesUnchanged: true },
      secondImport: { newlyInserted: 0, totalStoredNativeTransactions: 3, status: 'duplicate' } })
    expect(output).not.toContain('联东U谷餐厅')
    expect(output).not.toContain('Synthetic Store')
    expect(output).not.toContain(meta.fileName)
    const failed = spawnSync(process.execPath, [...args.slice(0, -4), '--expect-stored', '1', '--expect-new', '2'],
      { encoding: 'utf8', timeout: 20_000 })
    expect(failed.status).toBe(1)
    expect(JSON.parse(failed.stdout)).toMatchObject({ validation: 'failed', firstImport: { alreadyStored: 2 } })
  } finally {
    await rm(directory, { recursive: true, force: true })
    await db.delete()
  }
}, 45_000)
