import { inferCategory } from './classify'
import { assignOccurrences, assignStoredOccurrences, detectDuplicates, transactionId } from './dedupe'
import { transactionFingerprint, statementKey } from './identity'
import { reconcileStatement } from './reconcile'
import type {
  BankId,
  ImportRecord,
  ImportStatus,
  ReviewFlag,
  ReviewStatus,
  Statement,
  Transaction,
} from './types'
import type { ParsedStatement, SourceType } from '../parsers/types'

export interface ExistingSnapshot {
  imports: ImportRecord[]
  statements: Statement[]
  transactions: Transaction[]
}

export interface IngestMeta {
  fileName: string
  fileHash: string
  fileSize: number
  sourceType: SourceType
  isDemo?: boolean
}

export interface IngestResult {
  record: ImportRecord
  statement: Statement | null
  transactions: Transaction[]
  inserted: Transaction[]
  skippedDuplicates: Transaction[]
}

/**
 * Turn a parsed statement into storable rows.
 *
 * Reconciliation runs *before* anything is marked trustworthy: a statement that does
 * not balance keeps its transactions but is flagged, so nothing silently enters the
 * statistics as verified data.
 */
export function ingestParsedStatement(
  parsed: ParsedStatement,
  meta: IngestMeta,
  existing: ExistingSnapshot,
): IngestResult {
  const isDemo = meta.isDemo ?? false
  const cardLast4 = parsed.cardLast4 || '????'
  const key = statementKey(parsed.bank, cardLast4, parsed.cycleStart, parsed.cycleEnd)

  const duplicateImport = existing.imports.find(
    (record) => record.fileHash === meta.fileHash && !record.isDemo === !isDemo &&
      record.status !== 'failed' && record.status !== 'unsupported',
  )

  const fingerprints = parsed.transactions.map((tx) =>
    transactionFingerprint({
      bank: parsed.bank,
      cardLast4: tx.cardLast4 || cardLast4,
      transactionDate: tx.transactionDate,
      postingDate: tx.postingDate,
      settlementCurrency: tx.settlementCurrency,
      settlementAmountMinor: tx.settlementAmountMinor,
      type: tx.type,
      description: tx.description,
    }),
  )
  const occurrences = assignOccurrences(fingerprints)

  const stored = existing.transactions.filter((tx) => !tx.isDemo === !isDemo)
  const candidates = assignStoredOccurrences(parsed.transactions.map((tx, index): Transaction => {
    const rowCardLast4 = tx.cardLast4 || cardLast4
    const fingerprint = fingerprints[index]!
    const occurrence = occurrences[index]!.occurrence
    const flags: ReviewFlag[] = []
    if (tx.typeUncertain) flags.push('transaction_type_unclear')
    if (tx.confidence < 0.8) flags.push('low_confidence')
    if (!tx.transactionDate || !tx.postingDate) flags.push('date_missing')
    if (!rowCardLast4 || rowCardLast4 === '????') flags.push('card_missing')
    if (!tx.description || tx.description === '未识别交易') flags.push('description_unparsed')
    if (tx.transactionAmountMinor === 0) flags.push('amount_missing')

    return {
      id: transactionId(fingerprint, occurrence),
      statementId: key,
      bank: parsed.bank,
      cardLast4: rowCardLast4,
      transactionDate: tx.transactionDate,
      postingDate: tx.postingDate,
      description: tx.description,
      rawDescription: tx.rawDescription,
      transactionCurrency: tx.transactionCurrency,
      transactionAmountMinor: tx.transactionAmountMinor,
      settlementCurrency: tx.settlementCurrency,
      settlementAmountMinor: tx.settlementAmountMinor,
      type: tx.type,
      direction: tx.direction,
      category: inferCategory(tx.description, tx.type) as Transaction['category'],
      confidence: tx.confidence,
      flags,
      reviewStatus: flags.length > 0 ? 'pending' : 'ok',
      sourceFileName: meta.fileName,
      sourceFileHash: meta.fileHash,
      sourcePage: tx.sourcePage,
      sourceRow: tx.sourceRow,
      rawText: tx.rawText,
      fingerprint,
      occurrence,
      isDemo,
    }
  }), stored)

  if (duplicateImport) {
    const statement = existing.statements.find((row) => row.id === duplicateImport.statementId && !row.isDemo === !isDemo) ?? null
    return {
      record: { ...duplicateImport, fileName: meta.fileName, status: 'duplicate', duplicateOf: duplicateImport.id,
        transactionCount: 0, importedAt: new Date().toISOString(),
        message: `与已导入文件 ${duplicateImport.fileName} 内容完全相同（SHA-256 一致），已跳过` },
      statement,
      transactions: statement ? stored.filter((row) => row.statementId === statement.id) : [],
      inserted: [],
      skippedDuplicates: candidates,
    }
  }

  const priorForStatement = stored.filter((tx) => tx.statementId === key)
  const { duplicateIds, suspectedDuplicates } = detectDuplicates(
    candidates,
    stored,
  )

  const skippedDuplicates = candidates.filter((tx) => duplicateIds.has(tx.id))
  const inserted = candidates
    .filter((tx) => !duplicateIds.has(tx.id))
    .map((tx) => {
      const suspects = suspectedDuplicates.get(tx.id)
      if (!suspects || suspects.length === 0) return tx
      return { ...tx, flags: [...tx.flags, 'suspected_duplicate' as ReviewFlag], reviewStatus: 'pending' as ReviewStatus }
    })

  const statementTransactions = [...priorForStatement.filter((tx) => !tx.isDemo === !isDemo), ...inserted]
  const reconciliation = reconcileStatement({ summary: parsed.summary, transactions: statementTransactions })

  const status: Statement['status'] =
    reconciliation.status === 'passed' ? 'reconciled' : reconciliation.status === 'mismatch' ? 'needs_review' : 'needs_review'

  const flaggedStatement = status !== 'reconciled'
  const insertedIds = new Set(inserted.map((tx) => tx.id))
  const finalTransactions = statementTransactions.map((tx) => {
    if (!insertedIds.has(tx.id)) return tx
    if (!flaggedStatement) return tx
    if (tx.flags.includes('statement_mismatch')) return tx
    return { ...tx, flags: [...tx.flags, 'statement_mismatch' as ReviewFlag] }
  })

  const statement: Statement = {
    id: key,
    statementKey: key,
    bank: parsed.bank,
    cardLast4,
    cycleStart: parsed.cycleStart,
    cycleEnd: parsed.cycleEnd,
    dueDate: parsed.dueDate,
    summary: parsed.summary,
    reconciliation,
    status,
    parserId: parsed.parserId,
    parserVersion: parsed.parserVersion,
    transactionCount: finalTransactions.length,
    sourceFileName: meta.fileName,
    sourceFileHash: meta.fileHash,
    importedAt: new Date().toISOString(),
    isDemo,
  }

  const importStatus: ImportStatus = status === 'reconciled'
      ? 'parsed'
      : status === 'needs_review'
        ? 'needs_review'
        : 'failed'

  const message = describeOutcome(parsed, status, inserted.length, skippedDuplicates.length)

  const record: ImportRecord = {
    id: `${meta.fileHash}:${statement.parserId}`,
    fileName: meta.fileName,
    fileSize: meta.fileSize,
    fileHash: meta.fileHash,
    sourceType: meta.sourceType === 'unknown' ? 'unknown' : meta.sourceType,
    bank: parsed.bank,
    detectedBank: parsed.bank,
    cardLast4,
    cycleStart: parsed.cycleStart,
    cycleEnd: parsed.cycleEnd,
    status: importStatus,
    message,
    statementId: key,
    transactionCount: inserted.length,
    duplicateOf: null,
    parserId: parsed.parserId,
    importedAt: new Date().toISOString(),
    isDemo,
  }

  return { record, statement, transactions: finalTransactions, inserted, skippedDuplicates }
}

function describeOutcome(
  parsed: ParsedStatement,
  status: Statement['status'],
  insertedCount: number,
  duplicateCount: number,
): string {
  const parts: string[] = [`解析到 ${parsed.transactions.length} 笔交易`]
  if (duplicateCount > 0) parts.push(`跳过 ${duplicateCount} 笔已存在交易`)
  if (insertedCount > 0) parts.push(`新增 ${insertedCount} 笔`)
  if (status === 'needs_review') {
    const mismatch = parsed.warnings.includes('missing_current_balance')
      ? '账单缺少必要汇总信息'
      : '账单对账未通过'
    parts.push(`${mismatch}，已进入待复核`)
  } else if (status === 'reconciled') {
    parts.push('账单对账通过')
  }
  const currency = parsed.summary.components[0]?.currency ?? 'CNY'
  if (parsed.transactions.some(row => row.settlementCurrency !== currency)) {
    parts.push(`仅核对 ${currency} 汇总，其他币种交易已保留、未核对；不代表原始账单完整性已获银行证明`)
  }
  return parts.join('，')
}

export function failedImportRecord(meta: IngestMeta, message: string, bank: BankId = 'unknown'): ImportRecord {
  return {
    id: `${meta.fileHash}:failed`,
    fileName: meta.fileName,
    fileSize: meta.fileSize,
    fileHash: meta.fileHash,
    sourceType: meta.sourceType === 'unknown' ? 'unknown' : meta.sourceType,
    bank,
    detectedBank: bank,
    cardLast4: '',
    cycleStart: null,
    cycleEnd: null,
    status: 'failed',
    message,
    statementId: null,
    transactionCount: 0,
    duplicateOf: null,
    parserId: '',
    importedAt: new Date().toISOString(),
    isDemo: meta.isDemo ?? false,
  }
}

export function unsupportedRecord(meta: IngestMeta, message: string): ImportRecord {
  const record = failedImportRecord(meta, message)
  record.status = 'unsupported'
  return record
}

export function reviewStatusFor(flags: ReviewFlag[], userStatus?: ReviewStatus): ReviewStatus {
  if (userStatus === 'confirmed' || userStatus === 'rejected') return userStatus
  return flags.length > 0 ? 'pending' : 'ok'
}
