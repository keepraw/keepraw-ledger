import { assignOccurrences, assignStoredOccurrences, detectDuplicates, transactionId } from '../core/dedupe'
import { statementKey, transactionFingerprint } from '../core/identity'
import { auditMigrationRows } from '../core/migrationAudit'
import { reconcileStatement } from '../core/reconcile'
import { deriveStatementState } from '../core/statementState'
import type { ImportRecord, Statement, Transaction } from '../core/types'
import { emptySummary } from '../parsers/types'
import { assertSourceFileSize, sha256Hex } from '../parsers/extract'
import { LEGACY_STANDARD_SHEET, detectLegacyShape, parseLegacyRows } from './legacyPythonExportV1'
import { LEGACY_KEEPRAW_SHEET, detectKeeprawShape, parseKeeprawRows } from './legacyKeeprawExportV1'
import { LEGACY_UNIFIED_BILL_SHEET, detectUnifiedBillShape, parseUnifiedBillRows } from './legacyUnifiedBillV1'
import {
  LEGACY_KEEPRAW_EXPORT_V1,
  LEGACY_PYTHON_EXPORT_V1,
  LEGACY_UNIFIED_BILL_V1,
  LEGACY_FORMAT_NAME,
  type LegacyAnomaly,
  type LegacyFileMeta,
  type LegacyFormatId,
  type LegacyPreview,
  type NormalizedLegacyRow,
} from './types'
import { readSheetData } from './workbook'

export const LEGACY_ADAPTER_VERSION = '1.0.0'
export const LEGACY_IMPORT_BATCH = 2000

export class LegacyFormatError extends Error {
  constructor(message = '无法识别该历史数据格式') {
    super(message)
    this.name = 'LegacyFormatError'
  }
}

export interface LegacyExisting {
  imports: ImportRecord[]
  statements: Statement[]
  transactions: Transaction[]
}

export type PreviewRow = LegacyPreview['rows'][number]

function fingerprintOf(row: NormalizedLegacyRow): string {
  return transactionFingerprint({
    bank: row.bank,
    cardLast4: row.cardLast4,
    transactionDate: row.transactionDate,
    postingDate: row.postingDate,
    settlementCurrency: row.settlementCurrency,
    settlementAmountMinor: row.settlementAmountMinor,
    type: row.type,
    description: row.description,
  })
}

/**
 * Read-only preview. Parses the workbook, detects the adapter, maps every
 * row and compares fingerprints against storage. Writes nothing.
 *
 * Supported adapters (explicit only, never generic):
 * - `legacy-python-export-v1` (`标准字段` sheet, snake_case columns)
 * - `legacy-keepraw-export-v1` (`交易明细` sheet, 银行/卡尾号/交易日/入账日/说明/交易币种/交易金额/结算币种/结算金额)
 * - `legacy-unified-bill-v1` (`统一账单` sheet, all nine historical columns)
 */
export async function previewLegacyWorkbook(
  buffer: ArrayBuffer,
  meta: LegacyFileMeta,
  existing: LegacyExisting,
): Promise<LegacyPreview> {
  const detected = await detectLegacyAdapter(buffer)
  if (!detected) throw new LegacyFormatError()
  const { formatId, parsed } = detected

  const fingerprints = parsed.rows.map(fingerprintOf)
  const occurrences = assignOccurrences(fingerprints)
  const stored = existing.transactions.filter((tx) => !tx.isDemo)
  const rows = assignStoredOccurrences(parsed.rows.map((row, index): PreviewRow => {
    const fingerprint = fingerprints[index]!
    const occurrence = occurrences[index]!.occurrence
    return { ...row, id: transactionId(fingerprint, occurrence), fingerprint, occurrence }
  }), stored)

  const { duplicateIds } = detectDuplicates(
    rows,
    stored,
  )

  const dates = rows
    .map((row) => row.transactionDate)
    .filter((date): date is string => date !== null)
    .sort()
  const banks = [...new Set(rows.map((row) => row.bank))].sort()
  const duplicateFile = existing.imports.some((record) => record.fileHash === meta.fileHash && !record.isDemo &&
    record.status !== 'failed' && record.status !== 'unsupported')
  const anomaliesByKind: Record<LegacyAnomaly['kind'], number> = {
    missing_field: 0,
    date_unparseable: 0,
    amount_unparseable: 0,
  }
  for (const anomaly of parsed.anomalies) anomaliesByKind[anomaly.kind] += 1

  return {
    meta,
    stats: {
      formatId,
      formatName: LEGACY_FORMAT_NAME[formatId],
      totalRows: parsed.totalRows,
      validRows: rows.length,
      anomalyRows: parsed.anomalies.length,
      anomaliesByKind,
      dateRange: dates.length > 0 ? { min: dates[0]!, max: dates[dates.length - 1]! } : null,
      banks,
      alreadyStored: duplicateFile ? rows.length : rows.filter((row) => duplicateIds.has(row.id)).length,
      duplicateFile,
    },
    rows,
    anomalies: parsed.anomalies,
    reviewIssues: parsed.reviewIssues ?? [],
    migrationAudit: auditMigrationRows(rows, stored),
  }
}

/**
 * Try each known legacy adapter in order. Returns the first match, or null
 * when the workbook matches nothing. Never guesses: a missing sheet or a
 * missing column rejects the file.
 */
async function detectLegacyAdapter(
  buffer: ArrayBuffer,
): Promise<{ formatId: LegacyFormatId; parsed: { rows: NormalizedLegacyRow[]; anomalies: LegacyAnomaly[]; totalRows: number; reviewIssues?: LegacyPreview['reviewIssues'] } } | null> {
  const pythonSheet = await readSheetData(buffer, LEGACY_STANDARD_SHEET)
  if (pythonSheet.rows.length > 0) {
    const shape = detectLegacyShape(pythonSheet.rows[0] as unknown[])
    if (shape) {
      return {
        formatId: LEGACY_PYTHON_EXPORT_V1,
        parsed: parseLegacyRows(pythonSheet.rows.slice(1) as unknown[][], shape),
      }
    }
  }

  const keeprawSheet = await readSheetData(buffer, LEGACY_KEEPRAW_SHEET)
  if (keeprawSheet.rows.length > 0) {
    const shape = detectKeeprawShape(keeprawSheet.rows[0] as unknown[])
    if (shape) {
      return {
        formatId: LEGACY_KEEPRAW_EXPORT_V1,
        parsed: parseKeeprawRows(keeprawSheet.rows.slice(1) as unknown[][], shape),
      }
    }
  }

  const unifiedSheet = await readSheetData(buffer, LEGACY_UNIFIED_BILL_SHEET)
  if (unifiedSheet.rows.length > 0) {
    const shape = detectUnifiedBillShape(unifiedSheet.rows[0] as unknown[])
    if (shape) return { formatId: LEGACY_UNIFIED_BILL_V1, parsed: parseUnifiedBillRows(unifiedSheet.rows.slice(1), shape) }
  }
  return null
}

export interface LegacyConfirmPlan {
  record: ImportRecord
  statements: Statement[]
  /** Only rows not already stored. */
  inserted: Transaction[]
  skipped: number
  anomalies: LegacyAnomaly[]
}

/**
 * Build the write plan for rows the user already previewed. Re-checks
 * identity against a fresh snapshot so a concurrent import cannot duplicate.
 * Pure: performs no database access itself.
 */
export function planLegacyImport(preview: LegacyPreview, existing: LegacyExisting): LegacyConfirmPlan {
  const duplicateImport = existing.imports.find((record) => record.fileHash === preview.meta.fileHash && !record.isDemo &&
    record.status !== 'failed' && record.status !== 'unsupported')
  const stored = existing.transactions.filter((tx) => !tx.isDemo)
  const rows = assignStoredOccurrences(preview.rows, stored)
  const { duplicateIds, suspectedDuplicates } = detectDuplicates(rows, stored)
  const fresh = duplicateImport ? [] : rows.filter((row) => !duplicateIds.has(row.id))
  const skipped = preview.rows.length - fresh.length
  const formatId: LegacyFormatId = preview.stats.formatId
  const formatName = LEGACY_FORMAT_NAME[formatId]

  const transactions: Transaction[] = fresh.map((row) => ({
    id: row.id,
    statementId: statementKey(row.bank, row.cardLast4, row.cycleStart, row.cycleEnd),
    bank: row.bank,
    cardLast4: row.cardLast4,
    transactionDate: row.transactionDate,
    postingDate: row.postingDate,
    description: row.description,
    rawDescription: row.rawDescription,
    merchant: row.merchant,
    transactionCurrency: row.transactionCurrency,
    transactionAmountMinor: row.transactionAmountMinor,
    settlementCurrency: row.settlementCurrency,
    settlementAmountMinor: row.settlementAmountMinor,
    type: row.type,
    direction: row.direction,
    category: row.category,
    confidence: row.confidence,
    flags: suspectedDuplicates.has(row.id) ? [...row.flags, 'suspected_duplicate'] : [...row.flags],
    reviewStatus: row.flags.length > 0 || suspectedDuplicates.has(row.id) ? 'pending' : 'ok',
    sourceFileName: preview.meta.fileName,
    sourceFileHash: preview.meta.fileHash,
    sourcePage: null,
    sourceRow: row.sourceRow,
    rawText: row.rawText,
    fingerprint: row.fingerprint,
    occurrence: row.occurrence,
    isDemo: false,
    origin: 'legacy_import',
    sourceId: formatId,
  }))

  // Group the file's valid rows into per-period statements. Statements are
  // rebuilt deterministically, so a repeat import reproduces identical rows
  // and the merge stays idempotent.
  const groups = new Map<string, PreviewRow[]>()
  for (const row of rows) {
    const key = statementKey(row.bank, row.cardLast4, row.cycleStart, row.cycleEnd)
    const bucket = groups.get(key) ?? []
    bucket.push(row)
    groups.set(key, bucket)
  }

  const now = new Date().toISOString()
  const byStatement = new Map<string, Transaction[]>()
  for (const tx of [...stored, ...transactions]) {
    const group = byStatement.get(tx.statementId) ?? []
    group.push(tx)
    byStatement.set(tx.statementId, group)
  }
  const priorStatements = new Map(existing.statements.filter((row) => !row.isDemo).map((row) => [row.id, row]))
  const statements: Statement[] = duplicateImport ? [] : [...groups.entries()].map(([key, bucket]) => {
    const first = bucket[0]!
    const transactionCount = (byStatement.get(key) ?? []).length
    const prior = priorStatements.get(key)
    if (prior) return deriveStatementState(prior, byStatement.get(key) ?? [])
    // Legacy data carries no balance summary, so reconciliation is honestly
    // `insufficient` — never passed, never faked.
    const reconciliation = reconcileStatement({ summary: emptySummary(), transactions: [] })
    return {
      id: key,
      statementKey: key,
      bank: first.bank,
      cardLast4: first.cardLast4,
      cycleStart: first.cycleStart,
      cycleEnd: first.cycleEnd,
      dueDate: null,
      summary: emptySummary(),
      reconciliation,
      status: 'imported',
      parserId: formatId,
      parserVersion: LEGACY_ADAPTER_VERSION,
      transactionCount,
      sourceFileName: preview.meta.fileName,
      sourceFileHash: preview.meta.fileHash,
      importedAt: now,
      isDemo: false,
    } satisfies Statement
  })

  const banks = [...new Set(preview.rows.map((row) => row.bank))]
  const cards = [...new Set(preview.rows.map((row) => row.cardLast4))]
  const dates = preview.rows
    .map((row) => row.transactionDate)
    .filter((date): date is string => date !== null)
    .sort()
  const status = duplicateImport ? 'duplicate' : 'imported'

  const record: ImportRecord = {
    id: `${preview.meta.fileHash}:${formatId}`,
    fileName: preview.meta.fileName,
    fileSize: preview.meta.fileSize,
    fileHash: preview.meta.fileHash,
    sourceType: 'xlsx',
    bank: banks.length === 1 ? banks[0]! : 'unknown',
    detectedBank: banks.length === 1 ? banks[0]! : 'unknown',
    cardLast4: cards.length === 1 && cards[0] !== '????' ? cards[0]! : '',
    cycleStart: dates.length > 0 ? dates[0]! : null,
    cycleEnd: dates.length > 0 ? dates[dates.length - 1]! : null,
    status,
    message:
      status === 'duplicate' && duplicateImport
        ? `与已导入文件 ${duplicateImport.fileName} 内容完全相同（SHA-256 一致），已跳过`
        : `历史数据迁移（${formatName}）：解析到 ${preview.stats.totalRows} 笔，` +
          `新增 ${transactions.length} 笔，跳过 ${skipped} 笔已存在` +
          (preview.anomalies.length > 0 ? `，${preview.anomalies.length} 行异常已排除` : ''),
    statementId: null,
    transactionCount: transactions.length,
    duplicateOf: duplicateImport?.id ?? null,
    parserId: formatId,
    importedAt: now,
    isDemo: false,
  }

  return { record, statements, inserted: transactions, skipped, anomalies: preview.anomalies }
}

/** Hash the raw upload so repeat files are recognised before any work happens. */
export async function hashLegacyFile(file: { size: number; arrayBuffer(): Promise<ArrayBuffer> }) {
  assertSourceFileSize(file.size)
  const buffer = await file.arrayBuffer()
  assertSourceFileSize(buffer.byteLength)
  return { buffer, fileHash: await sha256Hex(buffer) }
}
