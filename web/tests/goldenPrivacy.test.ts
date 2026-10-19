import { describe, expect, it } from 'vitest'
import { desensitizeDescription, desensitizeRawText, KNOWN_PREFIXES, normalizeWebStatement } from '../src/golden/normalize'
import { syntheticStatement } from './fixtures/identity'
import { transactionFingerprint } from '../src/core/identity'

const CARD_FORMS = ['4111111111111111', '4111 1111 1111 1111', '4111-1111-1111-1111',
  '4111\u00a01111\u00a01111\u00a01111', '4111–1111–1111–1111', '3782 822463 10005', '6011-0009-9013-9424-123']

describe('AUD-013 synthetic-only privacy regressions', () => {
  it.each([...KNOWN_PREFIXES, '中国银行', '交易明细', '交易日期', '卡号后四位', '温馨提示', '积分统计'])(
    'never allows identifying CJK context because it contains %s', keyword => {
      for (const source of [`${keyword}合成姓名合成商户`, `合成姓名${keyword}合成商户`, `合成商户${keyword}`]) {
        const masked = desensitizeRawText(source)
        expect(masked).not.toContain('合成姓名')
        expect(masked).not.toContain('合成商户')
        expect(desensitizeRawText(masked)).toBe(masked)
      }
    })
  it.each(CARD_FORMS)('removes complete synthetic card %s', card => {
    const masked = desensitizeRawText(`消费合成姓名合成商户 account=${card} CNY 128.80`)
    expect(masked).not.toContain(card)
    expect(masked.replace(/\D/g, '')).not.toContain(card.replace(/\D/g, ''))
    expect(desensitizeRawText(masked)).toBe(masked)
  })
  it.each(['张', 'Li Wu', 'ACCOUNT_SYNTHETIC_001', 'AB12345', 'user@synthetic.invalid', '账户 12345678901234', '合成路88号'])(
    'does not retain identifying source token %s', token => {
      const masked = desensitizeRawText(`消费 ${token} | 2026-08-10 | CNY 128.80`)
      expect(masked).not.toContain(token)
      expect(desensitizeRawText(masked)).toBe(masked)
    })
  it.each(['消费合成姓名合成商户 4111-1111-1111-1111', '网上消费 合成门店', '合成姓名 Li Wu', '消费 商户_12345678合成姓名'])(
    'description placeholders are deterministic and idempotent for %s', source => {
      const masked = desensitizeDescription(source)
      expect(masked).toBe(desensitizeDescription(source))
      expect(desensitizeDescription(masked)).toBe(masked)
      expect(masked).not.toMatch(/合成|4111|Li Wu/)
    })
  it('projects shareable output without source debug text and preserves independent financial fields', () => {
    const parsed = syntheticStatement(Array.from({ length: 4 }, () => '消费合成姓名合成商户 4111-1111-1111-1111'))
    parsed.parserId = 'boc_pdf'
    const amounts = [-10001, 0, 12880, Number.MAX_SAFE_INTEGER]
    const currencies = ['USD', 'JPY', 'CNY', 'EUR']
    parsed.transactions.forEach((row, index) => {
      row.settlementAmountMinor = amounts[index]!
      row.settlementCurrency = currencies[index]!
      row.rawText = `消费合成姓名合成商户 4111-1111-1111-1111 账户 ACCOUNT_SYNTHETIC_001 Li Wu ${index}`
    })
    const before = structuredClone(parsed)
    const ids = parsed.transactions.map(row => transactionFingerprint({ bank: parsed.bank, cardLast4: row.cardLast4!,
      transactionDate: row.transactionDate, postingDate: row.postingDate, settlementCurrency: row.settlementCurrency,
      settlementAmountMinor: row.settlementAmountMinor, type: row.type, description: row.description }))
    const normalized = normalizeWebStatement(parsed, ids)
    expect(normalized).toEqual(normalizeWebStatement(parsed, ids))
    expect(normalized.transactionCount).toBe(4)
    expect(normalized.transactions.map(row => row.amountMinor)).toEqual(amounts)
    expect(normalized.transactions.map(row => row.currency)).toEqual(currencies)
    expect(normalized.transactions.map(row => row.direction)).toEqual(['credit', 'debit', 'debit', 'debit'])
    expect(normalized.transactions.map(row => [row.transactionDate, row.postingDate, row.cardLast4, row.nativeId]))
      .toEqual(parsed.transactions.map((row, i) => [row.transactionDate, row.postingDate, row.cardLast4, ids[i]]))
    expect(normalized.transactions.every(row => row.rawText === '')).toBe(true)
    expect(JSON.stringify(normalized)).not.toMatch(/合成姓名|合成商户|4111|ACCOUNT_SYNTHETIC_001|Li Wu/)
    expect(parsed).toEqual(before)
  })
  it('fails closed if an account identifier is supplied in the four-digit card field', () => {
    const parsed = syntheticStatement(['消费 合成门店'])
    parsed.parserId = 'boc_pdf'
    parsed.cardLast4 = '4111-1111-1111-1111'
    expect(() => normalizeWebStatement(parsed, ['abcdef0123456789#1'])).toThrow()
  })
  it('does not accept a full card number disguised as a hexadecimal native identifier', () => {
    const parsed = syntheticStatement(['消费 合成门店'])
    parsed.parserId = 'boc_pdf'
    expect(() => normalizeWebStatement(parsed, ['4111111111111111'])).toThrow()
  })
  it('does not publish arbitrary source text through debug position metadata', () => {
    const parsed = syntheticStatement(['消费 合成门店'])
    parsed.parserId = 'boc_pdf'
    parsed.transactions[0]!.sourceRow = 'SYNTHETIC_ACCOUNT_IDENTIFIER' as never
    expect(() => normalizeWebStatement(parsed, ['abcdef0123456789#1'])).toThrow()
  })
})
