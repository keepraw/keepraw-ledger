import Dexie from 'dexie'
import { beforeEach, expect, it } from 'vitest'
import { BillDatabase, db } from '../src/db/db'
import { acknowledgeStatement, exportDataBackup, importBackup, persistImportResults, readSnapshot, recomputeStatement } from '../src/db/repository'
import { buildFullBackupZip, restoreFullBackupZip } from '../src/backup/archive'
import { canAcknowledgeStatement, deriveStatementState, normalizeHistoricalStatement, statementNeedsReview } from '../src/core/statementState'
import { ingestSynthetic } from './fixtures/identity'
import type { Statement } from '../src/core/types'

beforeEach(async () => { await db.delete(); await db.open() })

function fixture() { return ingestSynthetic(['消费 合成复核商户']) }
function history(): Statement {
  return { ...fixture().statement!, status: 'needs_review', parserId: 'legacy-unified-bill-v1', sourceFileName: 'synthetic.xlsx' }
}

it('normalizes stuck historical records by adapter, filename, import provenance, or transaction origin, but not bank statements or mismatches', () => {
  const result = fixture()
  const statement = history()
  expect(normalizeHistoricalStatement(statement).status).toBe('imported')
  expect(normalizeHistoricalStatement({ ...statement, parserId: 'old-adapter' }).status).toBe('imported')
  expect(normalizeHistoricalStatement(result.statement!, [], [{ ...result.record, sourceType: 'xlsx' }]).status).toBe('imported')
  expect(deriveStatementState(result.statement!, result.transactions.map(row => ({ ...row, origin: 'legacy_import' }))).status).toBe('imported')
  expect(normalizeHistoricalStatement(result.statement!)).toBe(result.statement)
  const mismatch = { ...statement, reconciliation: { ...statement.reconciliation, status: 'mismatch' as const } }
  expect(normalizeHistoricalStatement(mismatch)).toBe(mismatch)
  expect(statementNeedsReview(mismatch)).toBe(true)
  expect(canAcknowledgeStatement(mismatch)).toBe(false)
})

it('upgrades v6 stuck history once, preserving other fields and stores across reopen', async () => {
  const name = 'synthetic-statement-review-upgrade'
  await Dexie.delete(name)
  const old = new Dexie(name)
  old.version(6).stores({ statements: 'id', transactions: 'id, statementId', imports: 'id', settings: 'key', reviewNotes: 'transactionId', attachments: 'fileHash' })
  const stuck = history()
  const bank = { ...fixture().statement!, id: 'bank-control' }
  const mismatch = { ...stuck, id: 'mismatch-control', reconciliation: { ...stuck.reconciliation, status: 'mismatch' as const } }
  await old.table('statements').bulkAdd([stuck, bank, mismatch])
  await old.table('reviewNotes').put({ transactionId: 'synthetic-note', note: '保留' })
  old.close()
  const upgraded = new BillDatabase(name)
  try {
    await upgraded.open()
    expect(await upgraded.statements.get(stuck.id)).toEqual({ ...stuck, status: 'imported' })
    expect(await upgraded.statements.get(bank.id)).toEqual(bank)
    expect(await upgraded.statements.get(mismatch.id)).toEqual(mismatch)
    expect(await upgraded.reviewNotes.get('synthetic-note')).toMatchObject({ note: '保留' })
    upgraded.close(); await upgraded.open()
    expect(await upgraded.statements.get(stuck.id)).toEqual({ ...stuck, status: 'imported' })
  } finally { await upgraded.delete() }
})

it.each(['json', 'zip'] as const)('normalizes old history during %s restore and recomputation', async format => {
  const result = fixture()
  await persistImportResults([result])
  const stuck = history()
  await db.statements.put(stuck)
  const backup = await exportDataBackup()
  const zip = format === 'zip' ? await buildFullBackupZip() : null
  await db.delete(); await db.open()
  if (zip) await restoreFullBackupZip(zip.blob)
  else await importBackup(JSON.parse(JSON.stringify(backup)))
  expect(await db.statements.get(stuck.id)).toMatchObject({ status: 'imported' })
  await db.statements.put(stuck)
  expect(await recomputeStatement(stuck.id)).toMatchObject({ status: 'imported' })
})

it.each(['json', 'zip'] as const)('persists reversible acknowledgement through reopen and %s backup round trip', async format => {
  const result = fixture()
  await persistImportResults([result])
  expect(statementNeedsReview(result.statement!)).toBe(true)
  const accepted = await acknowledgeStatement(result.statement!.id, true)
  expect(accepted).toMatchObject({ reconciliationAcknowledged: true, status: 'needs_review', reconciliation: { status: 'insufficient' } })
  expect(statementNeedsReview(accepted)).toBe(false)
  db.close(); await db.open()
  expect((await db.statements.get(accepted.id))!.reconciliationAcknowledged).toBe(true)
  const backup = await exportDataBackup()
  const zip = format === 'zip' ? await buildFullBackupZip() : null
  await db.delete(); await db.open()
  if (zip) await restoreFullBackupZip(zip.blob)
  else await importBackup(JSON.parse(JSON.stringify(backup)))
  expect(statementNeedsReview((await readSnapshot()).statements[0]!)).toBe(false)
  expect(await recomputeStatement(accepted.id)).toMatchObject({ reconciliationAcknowledged: true })
  expect(statementNeedsReview(await acknowledgeStatement(accepted.id, false))).toBe(true)
})

it('rejects missing statements and genuine mismatches without writes; stale acknowledgement never hides a mismatch', async () => {
  await expect(acknowledgeStatement('absent', true)).rejects.toThrow('账单不存在')
  const result = fixture()
  await persistImportResults([result])
  const statement = result.statement!
  await db.statements.update(statement.id, { summary: { ...statement.summary, previousBalanceMinor: 0, currentBalanceMinor: 1, newDebitMinor: 0, newCreditMinor: 0 } })
  const before = await readSnapshot()
  await expect(acknowledgeStatement(statement.id, true)).rejects.toThrow('不存在对账差额')
  expect(await readSnapshot()).toEqual(before)
  const next = deriveStatementState({ ...before.statements[0]!, reconciliationAcknowledged: true }, result.transactions)
  expect(next.reconciliation.status).toBe('mismatch')
  expect(next.reconciliationAcknowledged).toBe(false)
  expect(statementNeedsReview(next)).toBe(true)
})

it.each([false, true])('preserves acknowledgement on another same-period import unless it introduces a mismatch (%s)', async mismatch => {
  const first = fixture()
  await persistImportResults([first])
  await acknowledgeStatement(first.statement!.id, true)
  const second = ingestSynthetic(['消费 合成另一来源'], 'synthetic-second-file', await readSnapshot())
  expect(second.statement!.reconciliationAcknowledged).toBeUndefined()
  if (mismatch) second.statement!.summary = { ...second.statement!.summary, previousBalanceMinor: 0, currentBalanceMinor: 1 }
  await persistImportResults([second])
  const stored = (await db.statements.get(first.statement!.id))!
  expect(stored.reconciliationAcknowledged).toBe(!mismatch)
  expect(statementNeedsReview(stored)).toBe(mismatch)
  if (mismatch) expect(stored.reconciliation.status).toBe('mismatch')
})
