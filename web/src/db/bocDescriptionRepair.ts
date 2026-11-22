import { db } from './db'
import { assertLedgerRevision, bumpLedgerRevision, readLedgerRevision } from './ledgerRevision'
import { buildSourceDocument, sha256Hex } from '../parsers/extract'
import { bocParser } from '../parsers/boc'
import { transactionFingerprint } from '../core/identity'
import { inferCategory } from '../core/classify'
import type { Transaction } from '../core/types'
import type { ParsedTransaction } from '../parsers/types'

export interface BocDescriptionRepairResult {
  updated: number
  skipped: number
  missingFiles: number
  failedFiles: number
}

async function requireRealLedger() {
  const settings = (await db.settings.get('app'))?.value as { demoMode?: boolean } | undefined
  if (settings?.demoMode) throw new Error('请先关闭演示模式，再修复真实交易描述。')
}

function sameBusinessRow(stored: Transaction, parsed: ParsedTransaction, fallbackCard: string) {
  return stored.transactionDate !== null && stored.postingDate !== null &&
    stored.cardLast4 !== '????' && stored.cardLast4 !== '' &&
    stored.cardLast4 === (parsed.cardLast4 || fallbackCard) &&
    stored.transactionDate === parsed.transactionDate && stored.postingDate === parsed.postingDate &&
    stored.transactionCurrency === parsed.transactionCurrency && stored.transactionAmountMinor === parsed.transactionAmountMinor &&
    stored.settlementCurrency === parsed.settlementCurrency && stored.settlementAmountMinor === parsed.settlementAmountMinor &&
    stored.sourcePage === parsed.sourcePage && stored.type === parsed.type &&
    JSON.stringify(stored.bankColumnAmounts ?? null) === JSON.stringify(parsed.bankColumnAmounts ?? null)
}

export async function repairBocDescriptions(): Promise<BocDescriptionRepairResult> {
  const initial = await db.transaction('r', db.imports, db.statements, db.transactions, db.settings, async () => {
    await requireRealLedger()
    return { revision: await readLedgerRevision(), imports: await db.imports.toArray(),
      statements: await db.statements.toArray(), transactions: await db.transactions.toArray() }
  })
  const result: BocDescriptionRepairResult = { updated: 0, skipped: 0, missingFiles: 0, failedFiles: 0 }
  const updates = new Map<string, Transaction>()
  const seen = new Set<string>()
  for (const record of initial.imports) {
    if (record.isDemo || record.bank !== 'boc' || record.sourceType !== 'pdf' || !record.statementId ||
      record.status === 'failed' || record.status === 'unsupported') continue
    const key = JSON.stringify([record.fileHash, record.statementId])
    if (seen.has(key)) continue
    seen.add(key)
    const rows = initial.transactions.filter(row => !row.isDemo && row.bank === 'boc' &&
      row.origin !== 'legacy_import' && row.statementId === record.statementId && row.sourceFileHash === record.fileHash)
    if (!rows.length) continue
    const attachment = await db.attachments.get(record.fileHash)
    if (!attachment) { result.missingFiles++; result.skipped += rows.length; continue }
    let parsed
    try {
      if (await sha256Hex(attachment.data) !== record.fileHash) throw new Error('原始文件 SHA-256 不一致')
      const doc = await buildSourceDocument({ fileName: record.fileName, buffer: attachment.data.slice(0), fileHash: record.fileHash })
      if (bocParser.match(doc) < 0.8) throw new Error('原始文件不是中国银行 PDF 账单')
      parsed = bocParser.parse(doc)
      const statement = initial.statements.find(row => row.id === record.statementId && !row.isDemo)
      if (!statement || statement.bank !== parsed.bank || statement.cardLast4 !== parsed.cardLast4 ||
        statement.cycleStart !== parsed.cycleStart || statement.cycleEnd !== parsed.cycleEnd) throw new Error('账单身份不一致')
    } catch {
      result.failedFiles++; result.skipped += rows.length; continue
    }
    for (const row of rows) {
      const candidates = parsed.transactions.filter(candidate => sameBusinessRow(row, candidate, parsed.cardLast4))
      const candidate = candidates[0]
      if (!candidate || candidates.length !== 1 ||
        rows.filter(other => sameBusinessRow(other, candidate, parsed.cardLast4)).length !== 1) {
        result.skipped++; continue
      }
      // The old parser numbered top-down PDFs in reverse order within each page.
      const pageRows = parsed.transactions.filter(other => other.sourcePage === candidate.sourcePage)
      const reversedRow = pageRows.length - 1 - candidate.sourceRow
      if (row.sourceRow !== candidate.sourceRow && row.sourceRow !== reversedRow) { result.skipped++; continue }
      if (row.description === candidate.description && row.rawDescription === candidate.rawDescription) continue
      const next = { ...row, description: candidate.description, rawDescription: candidate.rawDescription }
      next.fingerprint = transactionFingerprint(next)
      if (row.category === '未分类') next.category = inferCategory(next.description)
      updates.set(row.id, next)
    }
  }
  await db.transaction('rw', db.transactions, db.settings, async () => {
    await requireRealLedger()
    await assertLedgerRevision(initial.revision)
    if (updates.size) {
      await db.transactions.bulkPut([...updates.values()])
      await bumpLedgerRevision()
    }
  })
  result.updated = updates.size
  return result
}
