import { expect, test } from '@playwright/test'
import { ingestSynthetic } from '../tests/fixtures/identity'

for (const version of [1, 2]) {
  test(`Chromium v${version} upgrade preserves financial records, notes and evidence; aborted upgrade is atomic`, async ({ page }) => {
    await page.goto('/')
    const result = ingestSynthetic(['消费 合成迁移商户', '消费 合成迁移商户'])
    const rows = result.transactions.map(row => ({ ...row, category: '旅行', reviewStatus: 'confirmed' }))
    const observed = await page.evaluate(async ({ version, result, rows }) => {
      const url = '/src/db/db.ts'
      const { BillDatabase } = await import(url)
      const Dexie = Object.getPrototypeOf(BillDatabase)
      const name = `synthetic-ci-upgrade-${version}`
      const old = new Dexie(name)
      const schema = { statements: 'id, bank, cardLast4, cycleEnd, status, isDemo',
        transactions: 'id, statementId, bank, transactionDate, postingDate, type, category, reviewStatus, isDemo, fingerprint, [bank+transactionDate]',
        imports: 'id, fileHash, importedAt, status, isDemo', settings: 'key', reviewNotes: 'transactionId' }
      old.version(version).stores(version === 1 ? schema : { ...schema, attachments: 'fileHash, importId, importedAt' })
      await old.open()
      await old.table('transactions').bulkAdd(rows)
      await old.table('statements').put(result.statement)
      await old.table('imports').put(result.record)
      await old.table('settings').put({ key: 'app', value: { demoMode: false, theme: 'dark', locale: 'zh-CN' } })
      await old.table('reviewNotes').put({ transactionId: rows[0]!.id, note: '合成保留备注', updatedAt: '2024-01-01T00:00:00Z' })
      if (version === 2) await old.table('attachments').put({ fileHash: 'synthetic-hash', fileName: 'synthetic.txt',
        mimeType: 'text/plain', size: 4, data: new Uint8Array([1, 2, 3, 4]).buffer,
        importId: result.record.id, parserId: result.record.parserId, importedAt: '2024-01-01T00:00:00Z' })
      const read = async (database: typeof old) => {
        const snapshot: Record<string, unknown> = {}
        for (const table of database.tables) {
          const values = await table.toArray()
          snapshot[table.name] = table.name === 'attachments' ? values.map((row: { data: ArrayBuffer }) => ({ ...row, data: [...new Uint8Array(row.data)] })) : values
        }
        if (!('attachments' in snapshot)) snapshot.attachments = []
        return snapshot
      }
      const before = await read(old); old.close()
      const failing = new BillDatabase(name)
      failing.version(3).upgrade(() => { throw new Error('synthetic upgrade abort') })
      let failed = false
      try { await failing.open() } catch { failed = true } finally { failing.close() }
      const rolledBack = new Dexie(name)
      await rolledBack.open()
      const nativeVersion = rolledBack.backendDB().version
      const rolledBackData = await read(rolledBack); rolledBack.close()
      const upgraded = new BillDatabase(name)
      await upgraded.open()
      const after = await read(upgraded)
      const indexes = upgraded.tables.reduce((sum: number, table: { schema: { indexes: unknown[] } }) => sum + table.schema.indexes.length, 0)
      upgraded.close(); await upgraded.open()
      const reopened = await read(upgraded); upgraded.close()
      return { before, after, rolledBackData, reopened, failed, nativeVersion, indexes }
    }, { version, result, rows })
    expect(observed.failed).toBe(true)
    expect(observed.nativeVersion).toBe(version * 10)
    expect(observed.rolledBackData).toEqual(observed.before)
    expect(observed.after).toEqual(observed.before)
    expect(observed.reopened).toEqual(observed.before)
    expect(observed.indexes).toBe(1)
  })
}

test('Chromium v3 → v4 removes only merchant; abort rolls back rows, notes, settings and evidence', async ({ page }) => {
  await page.goto('/')
  const result = ingestSynthetic(['消费 支付宝-合成迁移商户', '消费 支付宝-合成迁移商户'])
  const rows = result.transactions.map(row => ({ ...row, merchant: '旧版独立标签', category: '教育', reviewStatus: 'confirmed', retainedExtension: 'keep' }))
  const observed = await page.evaluate(async ({ result, rows }) => {
    const url = '/src/db/db.ts', { BillDatabase } = await import(url)
    const Dexie = Object.getPrototypeOf(BillDatabase)
    const name = 'synthetic-merchant-removal-v3'
    const old = new Dexie(name)
    old.version(3).stores({ statements: 'id', transactions: 'id, statementId', imports: 'id', settings: 'key', reviewNotes: 'transactionId', attachments: 'fileHash' })
    await old.table('transactions').bulkAdd(rows)
    await old.table('statements').put(result.statement)
    await old.table('imports').put(result.record)
    await old.table('settings').put({ key: 'app', value: { demoMode: false, theme: 'dark', locale: 'zh-CN' } })
    await old.table('reviewNotes').put({ transactionId: rows[0]!.id, note: '合成保留备注', updatedAt: '2024-01-01T00:00:00Z' })
    await old.table('attachments').put({ fileHash: 'synthetic-hash', fileName: 'synthetic.txt', mimeType: 'text/plain', size: 4,
      data: new Uint8Array([1, 2, 3, 4]).buffer, importId: result.record.id, parserId: result.record.parserId, importedAt: '2024-01-01T00:00:00Z' })
    const read = async (database: typeof old) => {
      const snapshot: Record<string, unknown[]> = {}
      for (const table of database.tables) {
        const values = await table.toArray()
        snapshot[table.name] = table.name === 'attachments' ? values.map((row: { data: ArrayBuffer }) => ({ ...row, data: [...new Uint8Array(row.data)] })) : values
      }
      return snapshot
    }
    const before = await read(old); old.close()
    const failing = new BillDatabase(name)
    let deletionObserved = false
    failing.version(5).stores({}).upgrade(async (transaction: { table: (name: string) => { get: (id: string) => Promise<object> } }) => {
      deletionObserved = !Object.hasOwn(await transaction.table('transactions').get(rows[0]!.id), 'merchant')
      throw new Error('synthetic failure after merchant deletion')
    })
    let failed = false
    try { await failing.open() } catch { failed = true } finally { failing.close() }
    const rollback = new Dexie(name); await rollback.open()
    const rolledBack = await read(rollback), rollbackVersion = rollback.verno; rollback.close()
    const upgraded = new BillDatabase(name); await upgraded.open()
    const after = await read(upgraded), version = upgraded.verno
    const indexes = upgraded.transactions.schema.indexes.map((index: { name: string }) => index.name)
    upgraded.close(); await upgraded.open()
    const reopened = await read(upgraded); await upgraded.delete()
    return { before, after, reopened, failed, deletionObserved, rolledBack, rollbackVersion, version, indexes }
  }, { result, rows })
  expect(observed.failed).toBe(true)
  expect(observed.deletionObserved).toBe(true)
  expect(observed.rollbackVersion).toBe(3)
  expect(observed.rolledBack).toEqual(observed.before)
  const expected = structuredClone(observed.before)
  for (const row of expected.transactions as Array<{ merchant?: unknown }>) delete row.merchant
  expect(observed.after).toEqual(expected)
  expect(observed.reopened).toEqual(expected)
  expect(observed.version).toBe(4)
  expect(observed.indexes).toEqual(['statementId'])
})
