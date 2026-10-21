import { describe, expect, it } from 'vitest'
import { normalizeDisplayDescription as normalize, transactionDisplayDescription as display, matchesTransactionDescription as matches } from '../src/core/descriptionNormalizer'
import { extractMerchant, extractSourceTypeToken, classifyTransactionType } from '../src/core/classify'
import { buildCsv, EXPORT_COLUMNS, transactionToRow } from '../src/export/tabular'
import { buildLedgerArchiveBuffer, LEDGER_ARCHIVE_HUMAN_SHEET, LEDGER_ARCHIVE_METADATA_SHEET } from '../src/export/ledgerArchive'
import { ingestSynthetic, EMPTY_SNAPSHOT } from './fixtures/identity'
import { MIGRATION_FORMATS } from './fixtures/historicalMigration'
import { historyRow, workbookBytes } from './fixtures/legacyWorkbook'
import { planLegacyImport, previewLegacyWorkbook } from '../src/importers/legacyImport'
import { db } from '../src/db/db'
import { exportDataBackup, importBackup, readSnapshot } from '../src/db/repository'
import * as XLSX from 'xlsx'

const cases = [
  ['网上消费 支付宝，China Unicom (HONG KONG) Operations', '支付宝-China Unicom (HONG KONG) Operations'],
  ['消费 支付宝-上海拉扎斯信息科技有限公司', '支付宝-上海拉扎斯信息科技有限公司'],
  ['网上消费 支付宝', '支付宝'],
  ['网上消费 财付通，京东商城平台商户', '财付通-京东商城平台商户'],
  ['消费 微信支付-某某商户', '微信支付-某某商户'],
  ['网上消费 China Unicom (HONG KONG) Operations', 'China Unicom (HONG KONG) Operations'],
  ['消费 星巴克', '星巴克'],
  ['支付宝-上海拉扎斯信息科技有限公司', '支付宝-上海拉扎斯信息科技有限公司'],
  ['消费 云闪付：合成商户', '云闪付-合成商户'],
  ['消费 网银在线－－合成商户', '网银在线-合成商户'],
  ['网上消费 财付通', '财付通'], ['消费 微信支付', '微信支付'],
  ['消费 云闪付', '云闪付'], ['网上消费 网银在线', '网银在线'],
  ['消费 ACME-A:B (HK) 123 消费支付体验店', 'ACME-A:B (HK) 123 消费支付体验店'],
  ['消费品研究所-支付技术:2024', '消费品研究所-支付技术:2024'],
  ['网上消费品有限公司', '网上消费品有限公司'], ['支付科技有限公司', '支付科技有限公司'],
  ['消费 支付宝科技有限公司', '支付宝科技有限公司'],
  ['消费 ACME, Inc. / A--B', 'ACME, Inc. / A--B'],
  ['', ''], ['\u3000\t  ', ''],
  ['\u3000网上消费\t 消费 ： 支付宝，，－： 合成 A-B（01）\u3000', '支付宝-合成 A-B（01）'],
  ['消费', '消费'], ['网上消费退货 支付宝，合成商户', '网上消费退货 支付宝，合成商户'],
] as const

describe('local description display rules', () => {
  it.each(cases)('%s → %s (idempotent and complete merchant)', (raw, expected) => {
    expect(normalize(raw)).toBe(expected)
    expect(normalize(normalize(raw))).toBe(expected)
    expect(extractMerchant(raw)).toBe(expected)
  })
  it.each(['退款', '还款', '分期扣款', '分期原始', '手续费', '利息', '取现', '返现', '调整'])('retains %s semantics and classification', token => {
    const raw = `${token} 支付宝-合成商户`
    const direction = ['退款', '还款', '返现'].includes(token) ? 'credit' : 'debit'
    const before = classifyTransactionType(extractSourceTypeToken(raw), direction)
    expect(normalize(raw)).toBe(raw)
    expect(classifyTransactionType(extractSourceTypeToken(normalize(raw)), direction)).toEqual(before)
  })
  it('does not truncate long or mixed-language merchants', () => {
    const name = 'ACME-A:消费支付研究 (HONG KONG) 123 '.repeat(5).trim()
    expect(extractMerchant(`消费 支付宝-${name}`)).toBe(`支付宝-${name}`)
  })
})

it('shows old source text without mutating identity or creating repeat imports', () => {
  const raw = '消费 支付宝-合成 A-B (HK)'
  const first = ingestSynthetic([raw, raw])
  const stored = structuredClone(first.transactions)
  for (const tx of stored) {
    expect(display(tx)).toBe('支付宝-合成 A-B (HK)')
    expect(matches(tx, '支付宝-合成')).toBe(true)
    expect(matches(tx, '消费 支付宝')).toBe(true)
    expect(transactionToRow(tx)[4]).toBe('支付宝-合成 A-B (HK)')
    expect(transactionToRow(tx)[EXPORT_COLUMNS.findIndex(c => c.key === 'rawDescription')]).toBe(raw)
  }
  expect(stored).toEqual(first.transactions)
  const repeat = ingestSynthetic([raw, raw], 'different-file', { imports: [], statements: [first.statement!], transactions: stored })
  expect(repeat.inserted).toEqual([])
  expect(repeat.skippedDuplicates.map(tx => [tx.id, tx.fingerprint, tx.occurrence])).toEqual(stored.map(tx => [tx.id, tx.fingerprint, tx.occurrence]))
  expect(buildCsv(stored)).toContain('支付宝-合成 A-B (HK)')
})

it('preserves manual description, merchant and category across display, search, exports and JSON recovery', async () => {
  await db.delete(); await db.open()
  const result = ingestSynthetic(['消费 支付宝-合成原始商户'])
  const edited = { ...result.transactions[0]!, description: '消费 自定义 A-B:01', merchant: '我的消费支付商户', category: '教育' as const }
  expect(display(edited)).toBe(edited.description)
  expect(matches(edited, '我的消费支付商户')).toBe(true)
  expect(matches(edited, '支付宝-合成原始商户')).toBe(true)
  expect(transactionToRow(edited)[4]).toBe(edited.description)
  await db.transactions.add(edited); await db.statements.add(result.statement!)
  const backup = JSON.parse(JSON.stringify(await exportDataBackup()))
  await db.delete(); await db.open(); await importBackup(backup)
  expect((await readSnapshot()).transactions).toEqual([edited])
  expect(display((await db.transactions.get(edited.id))!)).toBe(edited.description)
  await db.delete()
})

it.each(['boc', 'abc', 'ccb', 'citic', 'icbc', 'bocom'] as const)('%s: recognizes source cleanup while retaining raw text', bank => {
  const rawDescription = bank === 'boc' ? '网上消费 支付宝，合成商户 CHN /' : '网上消费 支付宝，合成商户 /'
  const description = bank === 'bocom' ? rawDescription : '网上消费 支付宝，合成商户'
  expect(display({ bank, rawDescription, description })).toBe(bank === 'bocom' ? '支付宝-合成商户 /' : '支付宝-合成商户')
})

it.each(MIGRATION_FORMATS)('$sheet: normalizes all imported banks and retains duplicate identity', async format => {
  const raw = '消费 支付宝，合成 A-B (HK)'
  const rows = ['中国银行', '工商银行', '农业银行', '建设银行', '交通银行', '中信银行'].map(bank => historyRow({
    bank, 银行: bank, 银行名称: bank, description: raw, 说明: raw, 交易详情: raw,
  }, format.format))
  const buffer = workbookBytes(format.sheet, format.columns, rows)
  const meta = { fileName: 'synthetic-description.xlsx', fileHash: 'synthetic-description', fileSize: buffer.byteLength }
  const preview = await previewLegacyWorkbook(buffer, meta, EMPTY_SNAPSHOT)
  const first = planLegacyImport(preview, EMPTY_SNAPSHOT)
  expect(first.inserted).toHaveLength(6)
  for (const tx of first.inserted) {
    expect(display(tx)).toBe('支付宝-合成 A-B (HK)')
    expect(tx.merchant).toBe('支付宝-合成 A-B (HK)')
    expect(tx.rawDescription).toBe(raw)
  }
  const existing = { imports: [], transactions: first.inserted, statements: first.statements }
  const repeat = planLegacyImport(await previewLegacyWorkbook(buffer, { ...meta, fileHash: 'repacked' }, existing), existing)
  expect(repeat.inserted).toEqual([])
  expect(repeat.skipped).toBe(6)
})

it('writes normalized XLSX display and verbatim raw descriptions and identities', async () => {
  const tx = ingestSynthetic(['网上消费 支付宝，合成 A-B (HK)']).transactions[0]!
  const book = XLSX.read(await buildLedgerArchiveBuffer([tx], []), { type: 'array' })
  const human = XLSX.utils.sheet_to_json<string[]>(book.Sheets[LEDGER_ARCHIVE_HUMAN_SHEET]!, { header: 1 })
  const metadata = XLSX.utils.sheet_to_json<string[]>(book.Sheets[LEDGER_ARCHIVE_METADATA_SHEET]!, { header: 1 })
  expect(human[1]![4]).toBe('支付宝-合成 A-B (HK)')
  expect(metadata[1]![0]).toBe(tx.id)
  expect(metadata[1]![2]).toBe(tx.fingerprint)
  expect(metadata[1]![6]).toBe(tx.rawDescription)
})
