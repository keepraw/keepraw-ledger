import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../src/db/db'
import { exportDataBackup, importBackup, patchTransaction, persistImportResults, persistLegacyImport, readSnapshot, setReviewNote, updateTransactions } from '../src/db/repository'
import { buildFullBackupZip, restoreFullBackupZip } from '../src/backup/archive'
import { ingestParsedStatement } from '../src/core/ingest'
import { filterByStatementTrust, summarize } from '../src/core/analytics'
import type { Statement, Transaction } from '../src/core/types'
import { LEGACY_UNIFIED_COLUMNS } from '../src/importers/legacyPythonExportV1'
import { planLegacyImport, previewLegacyWorkbook } from '../src/importers/legacyImport'
import { syntheticStatement } from './fixtures/identity'
import { historyRow, workbookBytes } from './fixtures/legacyWorkbook'

beforeEach(async () => { vi.restoreAllMocks(); await db.delete(); await db.open() })

async function seed(count = 1) {
  const parsed = syntheticStatement(Array.from({ length: count }, (_, i) => `消费 合成商户${i}`))
  parsed.summary = { ...parsed.summary, previousBalanceMinor: 0, currentBalanceMinor: 12880, newDebitMinor: 12880, newCreditMinor: 0 }
  const result = ingestParsedStatement(parsed, { fileName: 'synthetic.txt', fileHash: 'bank', fileSize: 1, sourceType: 'text' }, await readSnapshot())
  await persistImportResults([result])
  return result
}
async function trustedSpending() {
  const snapshot = await readSnapshot()
  return summarize(filterByStatementTrust(snapshot.transactions, snapshot.statements, false).transactions).realSpendingMinor
}
async function legacyPlan(description = '消费 追加商户') {
  const buffer = workbookBytes('标准字段', LEGACY_UNIFIED_COLUMNS, [historyRow({ description })])
  const existing = await readSnapshot()
  const preview = await previewLegacyWorkbook(buffer, { fileName: 'synthetic.xlsx', fileHash: 'history', fileSize: buffer.byteLength }, existing)
  return planLegacyImport(preview, existing)
}

describe('AUD-004 persisted statement state', () => {
  it('rejecting one of two 128.80 debits reconciles the remaining 128.80 and keeps user decisions', async () => {
    const result = await seed(2)
    const [kept, rejected] = result.transactions as [Transaction, Transaction]
    await patchTransaction({ id: kept.id, category: '旅行', reviewStatus: 'confirmed', flags: [] })
    await setReviewNote(kept.id, 'Synthetic confirmed note')
    expect(await trustedSpending()).toBe(0)
    await patchTransaction({ id: rejected.id, reviewStatus: 'rejected' })
    const statement = await db.statements.get(result.statement!.id)
    expect(statement).toMatchObject({ status: 'reconciled', transactionCount: 2, reconciliation: { status: 'passed' } })
    expect(statement!.reconciliation.checks.find(check => check.id === 'debit_detail')!.actualMinor).toBe(12880)
    expect(await trustedSpending()).toBe(12880)
    expect(await db.transactions.get(kept.id)).toMatchObject({ category: '旅行', reviewStatus: 'confirmed', flags: [] })
    expect((await db.reviewNotes.get(kept.id))!.note).toBe('Synthetic confirmed note')
    expect(await db.transactions.get(rejected.id)).toMatchObject({ reviewStatus: 'rejected', fingerprint: rejected.fingerprint, occurrence: rejected.occurrence })
  })

  it('legacy XLSX append invalidates a formerly reconciled bank statement in the plan and storage', async () => {
    const result = await seed()
    expect(await trustedSpending()).toBe(12880)
    const plan = await legacyPlan()
    expect(plan.inserted).toHaveLength(1)
    expect(plan.statements[0]).toMatchObject({ status: 'needs_review', transactionCount: 2, reconciliation: { status: 'mismatch' } })
    await persistLegacyImport(plan)
    expect(await db.statements.get(result.statement!.id)).toMatchObject({ status: 'needs_review', transactionCount: 2, reconciliation: { status: 'mismatch' } })
    expect(await db.transactions.count()).toBe(2)
    expect(await trustedSpending()).toBe(0)
  })

  it('rebuilds at commit from stored transactions rather than accepting a stale planned reconciliation', async () => {
    const result = await seed()
    const plan = await legacyPlan()
    plan.statements[0] = result.statement!
    await persistLegacyImport(plan)
    expect(await db.statements.get(result.statement!.id)).toMatchObject({ status: 'needs_review', transactionCount: 2, reconciliation: { status: 'mismatch' } })
  })

  it.each<Partial<Transaction>>([
    { settlementAmountMinor: 25760 }, { type: 'payment' }, { direction: 'credit' },
    { settlementCurrency: 'USD' }, { reviewStatus: 'rejected' },
  ])('invalidates financial edits %j and reconciles after reverting', async (patch) => {
    const result = await seed()
    const row = result.transactions[0]!
    await patchTransaction({ id: row.id, ...patch })
    expect((await db.statements.get(row.statementId))!.status).toBe('needs_review')
    await updateTransactions([row])
    expect((await db.statements.get(row.statementId))!.status).toBe('reconciled')
  })

  it('bulk updates rebuild both the old and new statement when membership changes', async () => {
    const result = await seed()
    const row = result.transactions[0]!
    const other: Statement = { ...result.statement!, id: 'other-statement', statementKey: 'other-statement', transactionCount: 0, status: 'needs_review' }
    await db.statements.put(other)
    await updateTransactions([{ ...row, statementId: other.id }])
    expect(await db.statements.get(row.statementId)).toMatchObject({ transactionCount: 0, status: 'needs_review' })
    expect(await db.statements.get(other.id)).toMatchObject({ transactionCount: 1, status: 'reconciled' })
  })

  it('rolls back the transaction edit if the derived statement write fails', async () => {
    const result = await seed(2)
    const before = await readSnapshot()
    vi.spyOn(db.statements, 'put').mockRejectedValueOnce(new Error('synthetic statement quota'))
    await expect(patchTransaction({ id: result.transactions[1]!.id, reviewStatus: 'rejected' })).rejects.toThrow('statement quota')
    expect(await readSnapshot()).toEqual(before)
  })

  it.each(['imported', 'failed', 'needs_review'] as const)('does not upgrade %s history without bank summary', async (status) => {
    const result = await seed()
    await db.statements.put({ ...result.statement!, status, summary: syntheticStatement([]).summary })
    await patchTransaction({ id: result.transactions[0]!.id, reviewStatus: 'confirmed' })
    expect(await db.statements.get(result.statement!.id)).toMatchObject({ status, reconciliation: { status: 'insufficient' } })
  })

  it('keeps a failed statement failed even if its monetary checks pass', async () => {
    const result = await seed()
    await db.statements.update(result.statement!.id, { status: 'failed' })
    await patchTransaction({ id: result.transactions[0]!.id, reviewStatus: 'confirmed' })
    expect((await db.statements.get(result.statement!.id))!.status).toBe('failed')
  })

  it.each(['json-v1', 'json-v2', 'zip'] as const)('keeps corrected status after reopening and %s restore', async (format) => {
    const result = await seed(2)
    await patchTransaction({ id: result.transactions[1]!.id, reviewStatus: 'rejected' })
    db.close(); await db.open()
    expect(await trustedSpending()).toBe(12880)
    const before = await readSnapshot()
    const backup = await exportDataBackup()
    const zip = format === 'zip' ? await buildFullBackupZip() : null
    await db.delete(); await db.open()
    if (zip) await restoreFullBackupZip(zip.blob)
    else if (format === 'json-v1') {
      const { reviewNotes: _notes, ...v1 } = backup as typeof backup & { reviewNotes: unknown }
      await importBackup({ ...v1, version: 1 })
    } else await importBackup(JSON.parse(JSON.stringify(backup)))
    expect(await readSnapshot()).toEqual(before)
    expect(await trustedSpending()).toBe(12880)
  })
})
