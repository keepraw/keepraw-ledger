import { beforeEach, expect, it, vi } from 'vitest'
import { inferCategory, normalizedMerchant } from '../src/core/classify'
import { db } from '../src/db/db'
import { categorizeUncategorized, exportDataBackup, importBackup, persistImportResults, readSnapshot } from '../src/db/repository'
import { readLedgerRevision } from '../src/db/ledgerRevision'
import { ingestSynthetic } from './fixtures/identity'
import type { Category } from '../src/core/types'

beforeEach(async () => { vi.restoreAllMocks(); await db.delete(); await db.open() })

it.each<[string, Category]>([
  ['支付宝-消费-', '未分类'], ['微信-玖玖权益', '订阅服务'],
  ['财付通-微信支付-山东济铁旅行服务有限公司青', '交通出行'],
  ['支付宝-广州苓语健康科技', '医疗健康'], ['境外消费 CROSSMINT*', '其他'],
  ['支付宝-北京联合优易科技有', '未分类'], ['支付宝-阿里健康大药房', '医疗健康'],
  ['口腔诊所', '医疗健康'], ['示例药业', '医疗健康'], ['网银在线-12306', '交通出行'],
  ['铁路服务', '交通出行'], ['铁旅服务', '交通出行'], ['示例航空', '交通出行'],
  ['滴滴出行', '交通出行'], ['中石化加油站', '交通出行'], ['ETC通行费', '交通出行'],
  ['停车缴费', '交通出行'], ['示例旅行服务', '旅行'], ['美团酒店', '旅行'],
  ['携程旅行', '旅行'], ['飞猪', '旅行'], ['腾讯视频会员', '订阅服务'],
  ['爱奇艺', '订阅服务'], ['境外消费 APPLE.COM/BILL', '订阅服务'],
  ['美团外卖', '餐饮'], ['饿了么', '餐饮'], ['星巴克', '餐饮'], ['麦当劳', '餐饮'],
  ['肯德基', '餐饮'], ['示例咖啡', '餐饮'], ['京东', '购物'], ['淘宝', '购物'],
  ['天猫', '购物'], ['拼多多', '购物'], ['超市', '购物'], ['便利店', '购物'],
  ['阿迪达斯', '购物'], ['耐克', '购物'], ['优衣库', '购物'], ['移动话费', '生活缴费'],
  ['联通', '生活缴费'], ['电信', '生活缴费'], ['境外消费 AMAZON.COM', '购物'],
  ['跨境消费 iHerb', '医疗健康'], ['境外消费 SPOTIFY', '订阅服务'],
  ['Booking.com', '旅行'], ['境外消费 UNKNOWN*', '未分类'], ['', '未分类'],
])('classifies %s as %s', (description, category) => {
  expect(inferCategory(description)).toBe(category)
})

it('normalizes nested channels, fullwidth separators, casing and whitespace without merging distinct merchants or changing identity text', () => {
  expect(normalizedMerchant(' 消费－财付通：微信支付-示例商户 ')).toBe('示例商户')
  expect(normalizedMerchant('银联-网银在线-ABC  SHOP')).toBe('abc shop')
  expect(normalizedMerchant('支付宝-消费-')).toBe('')
  expect(normalizedMerchant('支付宝')).toBe('')
  expect(normalizedMerchant('示例商户-东店')).not.toBe(normalizedMerchant('示例商户-西店'))
  expect(normalizedMerchant(normalizedMerchant('消费-微信-示例'))).toBe('示例')
})

async function seed() {
  const result = ingestSynthetic(['支付宝-健康商户', '微信-健康商户', '财付通-微信支付-健康商户',
    '支付宝-健康商户东店', '支付宝-消费-', '京东', '未知商户'])
  result.transactions = result.transactions.map((row, index) => ({ ...row,
    category: index === 2 ? '旅行' : '未分类', isDemo: index === 5,
  }))
  result.inserted = result.transactions
  await persistImportResults([result])
  return result.transactions
}

it('reclassifies only real uncategorized rows, preserves every other field/store, and is idempotent', async () => {
  await seed()
  const before = await readSnapshot()
  const revision = await readLedgerRevision()
  const changed = await categorizeUncategorized()
  expect(changed).toHaveLength(3)
  expect((await readLedgerRevision()).version).toBe(revision.version + 1)
  const after = await readSnapshot()
  expect(after.statements).toEqual(before.statements)
  expect(after.imports).toEqual(before.imports)
  expect(after.transactions).toEqual(before.transactions.map(row => row.category === '未分类' && !row.isDemo && inferCategory(row.description) !== '未分类'
    ? { ...row, category: inferCategory(row.description) } : row))
  const committedRevision = await readLedgerRevision()
  expect(await categorizeUncategorized()).toEqual([])
  expect(await readLedgerRevision()).toEqual(committedRevision)
})

it('applies a saved category only to exact normalized-merchant uncategorized peers and preserves it in backup', async () => {
  const rows = await seed()
  const source = rows[0]!
  await db.transactions.update(source.id, { category: '教育' })
  const changed = await categorizeUncategorized({ id: source.id, category: '教育' })
  expect(changed.map(row => row.id)).toEqual([rows[1]!.id])
  expect(await db.transactions.get(rows[2]!.id)).toMatchObject({ category: '旅行' })
  expect(await db.transactions.get(rows[3]!.id)).toMatchObject({ category: '未分类' })
  const backup = await exportDataBackup()
  await db.delete(); await db.open()
  await importBackup(JSON.parse(JSON.stringify(backup)))
  expect(await db.transactions.get(rows[1]!.id)).toMatchObject({ category: '教育' })
})

it('handles empty ledgers and channel-only merchants without broad matches', async () => {
  expect(await categorizeUncategorized()).toEqual([])
  const rows = await seed()
  await db.transactions.update(rows[4]!.id, { category: '购物' })
  expect(await categorizeUncategorized({ id: rows[4]!.id, category: '购物' })).toEqual([])
})

it('rejects invalid or stale merchant references and demo mode without writes', async () => {
  const rows = await seed()
  const before = await readSnapshot()
  for (const reference of [{ id: 'missing', category: '购物' }, { id: rows[0]!.id, category: '教育' },
    { id: rows[0]!.id, category: '未分类' }, { id: rows[0]!.id, category: 'invalid' }]) {
    await expect(categorizeUncategorized(reference as { id: string; category: Category })).rejects.toThrow()
    expect(await readSnapshot()).toEqual(before)
  }
  await db.settings.put({ key: 'app', value: { demoMode: true } })
  await expect(categorizeUncategorized()).rejects.toThrow('演示模式')
  expect(await readSnapshot()).toEqual(before)
})

it('rolls back all category changes if the revision write fails', async () => {
  await seed()
  const before = await readSnapshot()
  const revision = await readLedgerRevision()
  vi.spyOn(db.settings, 'put').mockRejectedValueOnce(new Error('synthetic quota failure'))
  await expect(categorizeUncategorized()).rejects.toThrow('synthetic quota failure')
  expect(await readSnapshot()).toEqual(before)
  expect(await readLedgerRevision()).toEqual(revision)
})
