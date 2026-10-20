import JSZip from 'jszip'
import { sha256Hex } from '../parsers/extract'
import {
  exportDataBackup,
  getAttachment,
  isArchiveFileExternal,
  importBackup,
  saveOriginalFile,
  validateBackup,
  validateManifest,
  type ArchiveManifest,
  type BackupPayload,
} from '../db/repository'
import { db } from '../db/db'
import { MAX_ARCHIVE_BYTES, MAX_EXPANDED_BYTES, MAX_ENTRY_BYTES, MAX_JSON_BYTES, MAX_ZIP_ENTRIES, readArchiveBytes, readBlobBytes, readZipEntry, validateZipDirectory } from './zipSafety'
import { createJsonBlob, parseJsonBytes } from './json'
import { assertLedgerRevision, readLedgerRevision } from '../db/ledgerRevision'

export const FULL_BACKUP_VERSION = 1 as const
export const DATABASE_JSON = 'database.json'
export const MANIFEST_JSON = 'manifest.json'
export const ORIGINAL_FILES_DIR = 'original-files'

/** `sha256-originalname`, with path separators stripped so ZIP entries stay flat. */
export function archiveFileName(sha256: string, filename: string): string {
  const safe = filename.replace(/[\\/]/g, '_').replace(/[^a-zA-Z0-9.\-_一-鿿]/g, '_').slice(-80) || 'file'
  return `${sha256}-${safe}`
}

export function parseArchiveFileName(entry: string): string | null {
  const match = entry.match(/^([0-9a-f]{64})-/i)
  return match?.[1]?.toLowerCase() ?? null
}

export interface FullBackupPreview {
  manifest: ArchiveManifest
  database: BackupPayload
  backupVersion: 1 | 2
  reviewNotesCount: number
  archivedCount: number
  missingCount: number
  warning: string | null
}

export function describeArchiveGap(missingCount: number, externalCount = 0): string | null {
  const parts = []
  if (missingCount > 0) parts.push(`${missingCount} 个历史账单没有原始文件，仅导出交易数据`)
  if (externalCount > 0) parts.push(`${externalCount} 个原始文件由用户选择外部保存，未放入 ZIP；恢复原件需另外保管下载的文件`)
  return parts.length ? parts.join('；') : null
}

/** Human-readable note coverage for preview/restore messages. */
export function describeNotesCoverage(database: BackupPayload): string | null {
  if (database.version === 2) {
    const count = database.reviewNotes.length
    return count > 0 ? `含 ${count} 条独立复核备注` : 'V2 备份暂无独立复核备注'
  }
  return 'V1 备份不含独立复核备注（仅保留本地已有备注）'
}

/** Build the full-archive ZIP: database.json + manifest.json + available originals. */
export async function buildFullBackupZip(): Promise<{ blob: Blob; manifest: ArchiveManifest; warning: string | null }> {
  const revision = await readLedgerRevision()
  const database = await exportDataBackup()
  const databaseJson = createJsonBlob(database)
  // Derive the manifest from the same immutable import snapshot as database.json.
  const manifest: ArchiveManifest = { version: 1, createdAt: new Date().toISOString(), files: [] }
  const zip = new JSZip()
  zip.file(DATABASE_JSON, await readBlobBytes(databaseJson, MAX_JSON_BYTES, '备份 JSON 文件过大'))
  const folder = zip.folder(ORIGINAL_FILES_DIR)
  if (!folder) throw new Error('无法创建备份压缩包')

  let archivedCount = 0
  let externalCount = 0
  let expanded = databaseJson.size
  const archived = new Map<string, ArrayBuffer | null>()
  const paths = new Set<string>()
  for (const record of database.imports) {
    if (await isArchiveFileExternal(record.fileHash)) {
      manifest.files.push({ importId: record.id, filename: record.fileName, sha256: record.fileHash,
        parserId: record.parserId, importedAt: record.importedAt, storage: 'external' })
      externalCount++
      continue
    }
    let data = archived.get(record.fileHash)
    if (!archived.has(record.fileHash)) {
      const attachment = await getAttachment(record.fileHash)
      data = attachment?.data ?? null
      if (data) {
        if (data.byteLength > MAX_ENTRY_BYTES) throw new Error(`原始文件 ${record.fileName} 超过 64 MiB ZIP 单文件上限，无法生成可恢复备份；请在原始文件管理中下载并选择外部保存后重试`)
        if (isSha256Hex(record.fileHash)) await verifyBytesHash(data, record.fileHash)
        else if (!(record.isDemo && record.fileHash.startsWith('demo-'))) throw new Error('原始文件缺少有效 SHA-256')
      }
      archived.set(record.fileHash, data)
    }
    manifest.files.push({ importId: record.id, filename: record.fileName, sha256: record.fileHash,
      parserId: record.parserId, importedAt: record.importedAt, storage: data ? 'indexeddb' : 'missing' })
    if (!data) continue
    const name = archiveFileName(record.fileHash, record.fileName)
    if (!paths.has(name)) {
      expanded += data.byteLength
      if (expanded > MAX_EXPANDED_BYTES) throw new Error('ZIP 解压内容过大')
      folder.file(name, new Uint8Array(data))
      paths.add(name)
    }
    archivedCount += 1
  }
  manifest.files.sort((a, b) => a.importedAt.localeCompare(b.importedAt))
  const manifestJson = createJsonBlob(manifest)
  if (expanded + manifestJson.size > MAX_EXPANDED_BYTES || Object.keys(zip.files).length + 1 > MAX_ZIP_ENTRIES) {
    throw new Error('ZIP 解压内容过大或文件过多')
  }
  zip.file(MANIFEST_JSON, await readBlobBytes(manifestJson, MAX_JSON_BYTES, '备份 JSON 文件过大'))

  const missingCount = manifest.files.length - archivedCount - externalCount
  const blob = await boundedZipBlob(zip)
  // Preferences and financial edits share the commit revision. If either
  // changes during export, do not download a snapshot with mixed choices.
  await assertLedgerRevision(revision)
  return { blob, manifest, warning: describeArchiveGap(missingCount, externalCount) }
}

/** Avoid a second archive-sized contiguous output buffer; bound generated bytes too. */
function boundedZipBlob(zip: JSZip): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const chunks: BlobPart[] = []
    let size = 0, stopped = false
    const stream = zip.generateInternalStream({ type: 'uint8array', compression: 'STORE', streamFiles: true })
    stream.on('data', (chunk) => {
      if (stopped) return
      size += chunk.byteLength
      if (size > MAX_ARCHIVE_BYTES) {
        stopped = true; chunks.length = 0; stream.pause(); reject(new Error('备份压缩包过大')); return
      }
      chunks.push(new Uint8Array(chunk))
    }).on('error', reject).on('end', () => {
      if (!stopped) resolve(new Blob(chunks, { type: 'application/zip' }))
    }).resume()
  })
}

function isSha256Hex(value: string): boolean {
  return /^[0-9a-f]{64}$/i.test(value)
}

async function verifyBytesHash(data: ArrayBuffer, expectedHex: string): Promise<void> {
  const actual = await sha256Hex(data)
  if (actual.toLowerCase() !== expectedHex.toLowerCase()) {
    throw new Error(`原始文件校验失败（${expectedHex.slice(0, 12)}…）：SHA-256 不一致，拒绝恢复`)
  }
}

interface VerifiedOriginal {
  sha256: string
  filename: string
  data: ArrayBuffer
  importId: string
  parserId: string
}

/** One validation path for preview and restore; no persistent operations. */
async function prepareFullBackup(file: Blob): Promise<FullBackupPreview & { originals: VerifiedOriginal[] }> {
  const archiveBytes = await readArchiveBytes(file)
  validateZipDirectory(archiveBytes)
  const zip = await JSZip.loadAsync(archiveBytes)
  const databaseFile = zip.file(DATABASE_JSON)
  const manifestFile = zip.file(MANIFEST_JSON)
  if (!databaseFile || !manifestFile) throw new Error('压缩包缺少 database.json 或 manifest.json')
  const budget = { remaining: MAX_EXPANDED_BYTES }
  const database = parseJsonBytes(await readZipEntry(databaseFile, MAX_JSON_BYTES, budget))
  const manifest = parseJsonBytes(await readZipEntry(manifestFile, MAX_JSON_BYTES, budget))
  if (!validateBackup(database)) throw new Error('database.json 包含无效记录')
  if (!validateManifest(manifest)) throw new Error('manifest.json 版本不受支持或格式错误')
  const imports = new Map(database.imports.map((row) => [row.id, row]))
  if (manifest.files.length !== imports.size) throw new Error('原始文件清单与导入记录不一致')

  const prefix = `${ORIGINAL_FILES_DIR}/`
  const byHash = new Map<string, string[]>()
  for (const [path, entry] of Object.entries(zip.files)) {
    if (entry.unsafeOriginalName && entry.unsafeOriginalName !== path) throw new Error('ZIP 包含不安全路径')
    if (entry.dir) continue
    if (path === DATABASE_JSON || path === MANIFEST_JSON) continue
    if (!path.startsWith(prefix) || path.slice(prefix.length).includes('/')) throw new Error('ZIP 包含清单外文件')
    const hash = parseArchiveFileName(path.slice(prefix.length))
    if (hash) {
      const paths = byHash.get(hash) ?? []
      paths.push(path)
      byHash.set(hash, paths)
    }
  }
  const consumed = new Set<string>([DATABASE_JSON, MANIFEST_JSON])
  const cached = new Map<string, ArrayBuffer>()
  const originals: VerifiedOriginal[] = []
  for (const entry of manifest.files) {
    const record = imports.get(entry.importId)
    if (!record || record.fileHash !== entry.sha256 || record.fileName !== entry.filename ||
      record.parserId !== entry.parserId || record.importedAt !== entry.importedAt) throw new Error('原始文件清单与导入记录不一致')
    if (entry.storage !== 'indexeddb') continue
    const realHash = isSha256Hex(entry.sha256)
    // Version-1 demo archives used synthetic hashes. Preserve that explicit,
    // fictional compatibility case; real evidence must always be verifiable.
    if (!realHash && !(record.isDemo && entry.sha256.startsWith('demo-'))) throw new Error('原始文件缺少有效 SHA-256')
    let path = `${prefix}${archiveFileName(entry.sha256, entry.filename)}`
    let zipEntry = zip.file(path)
    if (!zipEntry) {
      const candidates = byHash.get(entry.sha256.toLowerCase()) ?? []
      if (candidates.length === 1) { path = candidates[0]!; zipEntry = zip.file(path) }
    }
    if (!zipEntry) throw new Error(`压缩包缺少原始文件：${entry.filename}`)
    consumed.add(path)
    let data = cached.get(path)
    if (!data) {
      data = await readZipEntry(zipEntry, MAX_ENTRY_BYTES, budget)
      if (realHash) await verifyBytesHash(data, entry.sha256)
      cached.set(path, data)
    }
    originals.push({ sha256: entry.sha256, filename: entry.filename, data, importId: entry.importId, parserId: entry.parserId })
  }
  if (Object.entries(zip.files).some(([path, entry]) => !entry.dir && !consumed.has(path))) throw new Error('ZIP 包含清单外原始文件')
  const archivedCount = originals.length
  const missingCount = manifest.files.length - archivedCount
  const externalCount = manifest.files.filter(entry => entry.storage === 'external').length
  const backupVersion = database.version
  const reviewNotesCount = database.version === 2 ? database.reviewNotes.length : 0
  return { manifest, database, backupVersion, reviewNotesCount, originals, archivedCount, missingCount, warning: describeArchiveGap(missingCount - externalCount, externalCount) }
}

/** Records, settings, notes and evidence commit together or roll back together. */
export async function restoreFullBackupZip(file: Blob): Promise<{ transactions: number; statements: number; files: number; notes: number; backupVersion: 1 | 2; warning: string | null }> {
  const { database, backupVersion, reviewNotesCount, originals, warning } = await prepareFullBackup(file)
  let files = 0
  await db.transaction('rw', [db.statements, db.transactions, db.imports, db.settings, db.reviewNotes, db.attachments], async () => {
    await importBackup(database)
    for (const item of originals) {
      const existing = await db.attachments.get(item.sha256)
      if (existing) {
        const current = new Uint8Array(existing.data)
        const incoming = new Uint8Array(item.data)
        if (current.length !== incoming.length || current.some((byte, index) => byte !== incoming[index])) throw new Error('已有原始文件内容冲突，拒绝恢复')
        continue
      }
      await saveOriginalFile({ fileHash: item.sha256, fileName: item.filename, data: item.data, importId: item.importId, parserId: item.parserId })
      files += 1
    }
  })
  return { transactions: database.transactions.length, statements: database.statements.length, files, notes: reviewNotesCount, backupVersion, warning }
}

/** Preview verifies the same records, manifest and evidence as an actual restore. */
export async function previewFullBackupZip(file: Blob): Promise<FullBackupPreview> {
  const { originals: _originals, ...preview } = await prepareFullBackup(file)
  return preview
}
