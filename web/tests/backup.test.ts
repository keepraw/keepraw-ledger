import JSZip from 'jszip'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  archiveFileName,
  buildFullBackupZip,
  describeArchiveGap,
  previewFullBackupZip,
  restoreFullBackupZip,
  DATABASE_JSON,
  MANIFEST_JSON,
  ORIGINAL_FILES_DIR,
} from '../src/backup/archive'
import { db } from '../src/db/db'
import {
  buildManifest,
  exportDataBackup,
  getArchiveStatus,
  importBackup,
  saveOriginalFile,
  validateBackup,
  validateManifest,
} from '../src/db/repository'
import { sha256Hex } from '../src/parsers/extract'
import { buildDemoDataset } from '../src/demo/demoData'

async function clearDb(): Promise<void> {
  await db.transaction(
    'rw',
    [db.statements, db.transactions, db.imports, db.settings, db.attachments, db.reviewNotes],
    async () => {
      await db.statements.clear()
      await db.transactions.clear()
      await db.imports.clear()
      await db.settings.clear()
      await db.attachments.clear()
      await db.reviewNotes.clear()
    },
  )
}

async function seedDemoWithOneAttachment(): Promise<{ fileHash: string; bytes: Uint8Array }> {
  const results = buildDemoDataset()
  await db.transaction('rw', db.statements, db.transactions, db.imports, async () => {
    for (const result of results) {
      await db.imports.put(result.record)
      if (result.statement) await db.statements.put(result.statement)
      await db.transactions.bulkPut(result.transactions)
    }
  })
  const first = results[0]!
  const bytes = new TextEncoder().encode(`evidence:${first.record.fileHash}`)
  await saveOriginalFile({
    fileHash: first.record.fileHash,
    fileName: first.record.fileName,
    data: new Uint8Array(bytes).buffer as ArrayBuffer,
    importId: first.record.id,
    parserId: first.record.parserId,
  })
  return { fileHash: first.record.fileHash, bytes }
}

/** One import whose fileHash is a genuine SHA-256, so hash enforcement can be tested strictly. */
async function seedRealHashImport(): Promise<{ fileHash: string; bytes: Uint8Array }> {
  const bytes = new TextEncoder().encode(`real-evidence-${Date.now()}-${Math.random()}`)
  const copy = new Uint8Array(bytes)
  const fileHash = await sha256Hex(copy.buffer)
  const now = new Date().toISOString()
  await db.imports.put({
    id: `${fileHash}:boc_pdf`,
    fileName: 'real-bill.pdf',
    fileSize: copy.byteLength,
    fileHash,
    sourceType: 'pdf',
    bank: 'boc',
    detectedBank: 'boc',
    cardLast4: '1234',
    cycleStart: '2026-01-01',
    cycleEnd: '2026-01-31',
    status: 'parsed',
    message: 'ok',
    statementId: null,
    transactionCount: 0,
    duplicateOf: null,
    parserId: 'boc_pdf',
    importedAt: now,
    isDemo: false,
  })
  await saveOriginalFile({
    fileHash,
    fileName: 'real-bill.pdf',
    data: new Uint8Array(copy).buffer as ArrayBuffer,
    importId: `${fileHash}:boc_pdf`,
    parserId: 'boc_pdf',
  })
  return { fileHash, bytes: copy }
}

beforeEach(async () => {
  await clearDb()
})

describe('JSON data backup', () => {
  it('exports complete data without raw files', async () => {
    await seedDemoWithOneAttachment()
    const payload = await exportDataBackup()
    expect(payload.format).toBe('credit-card-data-backup')
    expect(payload.version).toBe(2)
    expect(payload.transactions.length).toBeGreaterThan(0)
    expect(payload.statements.length).toBeGreaterThan(0)
    expect(payload.imports.length).toBeGreaterThan(0)
    if (payload.version === 2) expect(Array.isArray(payload.reviewNotes)).toBe(true)
    // Lightweight: no Blob or evidence bytes leak into the JSON.
    expect(JSON.stringify(payload)).not.toContain('evidence:')
    expect(validateBackup(payload)).toBe(true)
  })

  it('stays compatible with the legacy backup format', () => {
    const payload = {
      format: 'credit-bill-manager-backup',
      version: 1,
      exportedAt: new Date().toISOString(),
      statements: [],
      transactions: [],
      imports: [],
      settings: null,
    }
    expect(validateBackup(payload)).toBe(true)
  })

  it('accepts an empty V2 payload with explicit reviewNotes', () => {
    const payload = {
      format: 'credit-card-data-backup',
      version: 2,
      exportedAt: new Date().toISOString(),
      statements: [],
      transactions: [],
      imports: [],
      reviewNotes: [],
      settings: null,
    }
    expect(validateBackup(payload)).toBe(true)
  })

  it('accepts summaries with or without optional adjustment and detail-basis fields', async () => {
    await seedDemoWithOneAttachment()
    const payload = await exportDataBackup()
    const oldPayload = structuredClone(payload)
    for (const statement of oldPayload.statements) {
      delete statement.summary.adjustmentMinor
      delete statement.summary.detailBasis
    }
    expect(validateBackup(oldPayload)).toBe(true)

    const currentPayload = structuredClone(payload)
    currentPayload.statements[0]!.summary.adjustmentMinor = 0
    currentPayload.statements[0]!.summary.detailBasis = 'net'
    expect(validateBackup(currentPayload)).toBe(true)
  })
})

describe('ZIP full-archive backup', () => {
  it('contains database.json, manifest.json and the available originals', async () => {
    const { bytes } = await seedDemoWithOneAttachment()
    const { blob, manifest, warning } = await buildFullBackupZip()
    const zip = await JSZip.loadAsync(blob)
    expect(zip.file(DATABASE_JSON)).not.toBeNull()
    expect(zip.file(MANIFEST_JSON)).not.toBeNull()
    const database = JSON.parse(await zip.file(DATABASE_JSON)!.async('string'))
    expect(validateBackup(database)).toBe(true)
    expect(database.transactions.length).toBeGreaterThan(0)

    const parsedManifest = JSON.parse(await zip.file(MANIFEST_JSON)!.async('string'))
    expect(validateManifest(parsedManifest)).toBe(true)
    expect(parsedManifest.version).toBe(1)
    // Exactly one import has evidence; the rest are honestly marked missing.
    const indexed = parsedManifest.files.filter((f: { storage: string }) => f.storage === 'indexeddb')
    const missing = parsedManifest.files.filter((f: { storage: string }) => f.storage === 'missing')
    expect(indexed).toHaveLength(1)
    expect(missing.length).toBeGreaterThan(0)
    expect(manifest.files).toHaveLength(parsedManifest.files.length)
    expect(warning).toContain('没有原始文件')

    const originals = Object.keys(zip.files).filter((p) => p.startsWith(`${ORIGINAL_FILES_DIR}/`) && !zip.files[p]!.dir)
    expect(originals).toHaveLength(1)
    const stored = await zip.files[originals[0]!]!.async('uint8array')
    expect(new TextDecoder().decode(stored)).toBe(new TextDecoder().decode(bytes))
  })

  it('round-trips bytes with a verifiable SHA-256', async () => {
    const { fileHash } = await seedRealHashImport()
    const { blob } = await buildFullBackupZip()
    const zip = await JSZip.loadAsync(blob)
    const originals = Object.keys(zip.files).filter((p) => p.startsWith(`${ORIGINAL_FILES_DIR}/`) && !zip.files[p]!.dir)
    expect(originals).toHaveLength(1)
    const stored = await zip.files[originals[0]!]!.async('uint8array')
    expect(await sha256Hex(new Uint8Array(stored).buffer)).toBe(fileHash)
  })
})

describe('missing attachments', () => {
  it('marks every import without evidence as missing and warns', async () => {
    // Archive status reports the real database only: seed real (non-demo)
    // rows so the missing-evidence path is exercised without demo data.
    const results = buildDemoDataset()
    await db.transaction('rw', db.statements, db.transactions, db.imports, async () => {
      for (const result of results) {
        await db.imports.put({ ...result.record, isDemo: false })
        if (result.statement) await db.statements.put({ ...result.statement, isDemo: false })
        await db.transactions.bulkPut(result.transactions.map((tx) => ({ ...tx, isDemo: false })))
      }
    })
    const manifest = await buildManifest()
    expect(manifest.files.every((f) => f.storage === 'missing')).toBe(true)
    expect(manifest.files).toHaveLength(results.length)

    const status = await getArchiveStatus()
    expect(status.archivedCount).toBe(0)
    expect(status.missingCount).toBe(results.length)
    expect(status.transactionCount).toBeGreaterThan(0)
    expect(describeArchiveGap(status.missingCount)).toContain('没有原始文件')
    expect(describeArchiveGap(0)).toBeNull()
  })
})

describe('SHA-256', () => {
  it('hashes bytes with WebCrypto', async () => {
    const bytes = new TextEncoder().encode('abc')
    expect(await sha256Hex(bytes.buffer as ArrayBuffer)).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })

  it('sanitises archive entry names without losing the hash prefix', () => {
    const name = archiveFileName('a'.repeat(64), '../../evil\\bill.pdf')
    expect(name.startsWith(`${'a'.repeat(64)}-`)).toBe(true)
    expect(name).not.toContain('/')
    expect(name).not.toContain('\\')
  })
})

describe('restore', () => {
  it('restores JSON and stays idempotent on repeat', async () => {
    await seedDemoWithOneAttachment()
    const payload = await exportDataBackup()
    const before = {
      transactions: await db.transactions.count(),
      statements: await db.statements.count(),
      imports: await db.imports.count(),
    }
    await clearDb()
    expect(await db.transactions.count()).toBe(0)
    await importBackup(payload)
    expect(await db.transactions.count()).toBe(before.transactions)
    expect(await db.statements.count()).toBe(before.statements)
    expect(await db.imports.count()).toBe(before.imports)
    // Restoring twice merges by primary key: no duplicates.
    await importBackup(payload)
    expect(await db.transactions.count()).toBe(before.transactions)
    expect(await db.statements.count()).toBe(before.statements)
  })

  it('restores a ZIP with attachments and skips existing files on repeat', async () => {
    await seedDemoWithOneAttachment()
    const { blob } = await buildFullBackupZip()
    const preview = await previewFullBackupZip(blob)
    expect(preview.archivedCount).toBe(1)
    expect(preview.warning).toContain('没有原始文件')

    await clearDb()
    const first = await restoreFullBackupZip(blob)
    expect(first.transactions).toBeGreaterThan(0)
    expect(first.files).toBe(1)
    const counts = {
      transactions: await db.transactions.count(),
      attachments: await db.attachments.count(),
    }
    const second = await restoreFullBackupZip(blob)
    expect(second.files).toBe(0)
    expect(await db.transactions.count()).toBe(counts.transactions)
    expect(await db.attachments.count()).toBe(counts.attachments)
  })

  it('rejects a ZIP whose file hash does not match', async () => {
    await seedRealHashImport()
    const { blob } = await buildFullBackupZip()
    const zip = await JSZip.loadAsync(blob)
    const originals = Object.keys(zip.files).filter((p) => p.startsWith(`${ORIGINAL_FILES_DIR}/`) && !zip.files[p]!.dir)
    expect(originals).toHaveLength(1)
    zip.file(originals[0]!, 'tampered bytes')
    const tampered = await zip.generateAsync({ type: 'blob' })
    await clearDb()
    await expect(restoreFullBackupZip(tampered)).rejects.toThrow(/SHA-256/)
    // Nothing was partially restored.
    expect(await db.transactions.count()).toBe(0)
  })

  it('rejects a manifest with an unsupported version', async () => {
    await seedDemoWithOneAttachment()
    const { blob } = await buildFullBackupZip()
    const zip = await JSZip.loadAsync(blob)
    const manifest = JSON.parse(await zip.file(MANIFEST_JSON)!.async('string'))
    zip.file(MANIFEST_JSON, JSON.stringify({ ...manifest, version: 99 }))
    const bad = await zip.generateAsync({ type: 'blob' })
    await expect(restoreFullBackupZip(bad)).rejects.toThrow()
  })
})
