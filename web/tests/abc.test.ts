import { describe, expect, it } from 'vitest'
import { abcParser, locateCycle, locateTxnHeader, parseSlashAmount, resolveAbcDate } from '../src/parsers/abc'
import { extractTables, extractText, sanitizeHtml } from '../src/parsers/html'
import type { SourceDocument } from '../src/parsers/types'
import {
  SYNTHETIC_ABC,
  SYNTHETIC_ABC_ADJUSTMENT_8_HTML,
  SYNTHETIC_ABC_ADJUSTMENT_HTML,
  SYNTHETIC_ABC_HTML,
  SYNTHETIC_ABC_USD_HTML,
} from './fixtures/abcEml'
import { ingestParsedStatement, type ExistingSnapshot } from '../src/core/ingest'

function makeDoc(html = SYNTHETIC_ABC_HTML): SourceDocument {
  const safe = sanitizeHtml(html)
  return {
    fileName: 'synthetic-abc.eml',
    fileSize: 5000,
    fileHash: 'hash-abc',
    sourceType: 'eml',
    pdf: null,
    html: safe,
    tables: extractTables(safe),
    text: extractText(safe),
    email: { subject: '中国农业银行金穗信用卡电子对账单', from: 'e-statement@creditcard.abchina.com.cn', date: '2026-08-15' },
  }
}

const EMPTY: ExistingSnapshot = { statements: [], transactions: [], imports: [] }

describe('ABC EML parser', () => {
  it('recognises the bank and product', () => {
    expect(abcParser.match(makeDoc())).toBe(1)
  })

  it('extracts card last four and the statement cycle', () => {
    const statement = abcParser.parse(makeDoc())
    expect(statement.cardLast4).toBe(SYNTHETIC_ABC.cardLast4)
    expect(statement.cycleStart).toBe(SYNTHETIC_ABC.cycleStart)
    expect(statement.cycleEnd).toBe(SYNTHETIC_ABC.cycleEnd)
    expect(statement.dueDate).toBe(SYNTHETIC_ABC.dueDate)
  })

  it('finds the 6-column transaction header', () => {
    expect(locateTxnHeader(makeDoc())).not.toBeNull()
  })

  it('extracts the cycle from the header', () => {
    expect(locateCycle(makeDoc())).toEqual({ start: SYNTHETIC_ABC.cycleStart, end: SYNTHETIC_ABC.cycleEnd })
  })

  it('reads every transaction row across sections', () => {
    const statement = abcParser.parse(makeDoc())
    expect(statement.transactions).toHaveLength(
      SYNTHETIC_ABC.creditTransactionCount + SYNTHETIC_ABC.debitTransactionCount,
    )
  })

  it('extracts summary components', () => {
    const { summary } = abcParser.parse(makeDoc())
    expect(summary.previousBalanceMinor).toBe(SYNTHETIC_ABC.previousBalanceMinor)
    expect(summary.newCreditMinor).toBe(SYNTHETIC_ABC.newCreditMinor)
    expect(summary.newDebitMinor).toBe(SYNTHETIC_ABC.newDebitMinor)
    expect(summary.currentBalanceMinor).toBe(SYNTHETIC_ABC.currentBalanceMinor)
  })

  it('reconciles a signed adjustment and mismatches when it changes by one cent', () => {
    const html = SYNTHETIC_ABC_ADJUSTMENT_HTML
    const parsed = abcParser.parse(makeDoc(html))
    expect(parsed.summary.adjustmentMinor).toBe(3000)
    expect(ingestParsedStatement(parsed,
      { fileName: 'synthetic-abc-adjustment.eml', fileHash: 'abc-adjustment', fileSize: 1, sourceType: 'eml' }, EMPTY)
      .statement!.reconciliation.status).toBe('passed')

    const changed = abcParser.parse(makeDoc(html.replace('30.00</td>', '30.01</td>')))
    expect(changed.summary.adjustmentMinor).toBe(3001)
    expect(ingestParsedStatement(changed,
      { fileName: 'synthetic-abc-adjustment-changed.eml', fileHash: 'abc-adjustment-changed', fileSize: 1, sourceType: 'eml' }, EMPTY)
      .statement!.reconciliation.status).toBe('mismatch')
  })

  it('reads signed adjustment from the compressed eight-value summary row', () => {
    const parsed = abcParser.parse(makeDoc(SYNTHETIC_ABC_ADJUSTMENT_8_HTML))
    expect(parsed.summary.adjustmentMinor).toBe(3000)
    expect(ingestParsedStatement(parsed,
      { fileName: 'synthetic-abc-adjustment-8.eml', fileHash: 'abc-adjustment-8', fileSize: 1, sourceType: 'eml' }, EMPTY)
      .statement!.reconciliation.status).toBe('passed')
  })

  it('uses the equation row currency for all ABC summary components', () => {
    const parsed = abcParser.parse(makeDoc(SYNTHETIC_ABC_USD_HTML))
    expect(parsed.summary.components.every((component) => component.currency === 'USD')).toBe(true)
    const result = ingestParsedStatement(parsed,
      { fileName: 'synthetic-abc-usd.eml', fileHash: 'abc-usd', fileSize: 1, sourceType: 'eml' }, EMPTY)
    expect(result.statement!.reconciliation.status).toBe('passed')
  })

  it('balances the statement equation', () => {
    const { summary } = abcParser.parse(makeDoc())
    const computed =
      summary.previousBalanceMinor! + summary.newDebitMinor! - summary.newCreditMinor!
    expect(computed).toBe(summary.currentBalanceMinor)
  })

  it('uses the section marker, not the merchant text, for the direction', () => {
    const statement = abcParser.parse(makeDoc())
    const repayment = statement.transactions.find((tx) => tx.bankToken === '还款')
    expect(repayment!.direction).toBe('credit')
    expect(repayment!.transactionAmountMinor).toBeLessThan(0)

    const purchase = statement.transactions.find((tx) => tx.rawDescription.includes('示例餐厅'))
    expect(purchase!.direction).toBe('debit')
    expect(purchase!.transactionAmountMinor).toBeGreaterThan(0)

    const refund = statement.transactions.filter((tx) => tx.type === 'refund')
    expect(refund.length).toBeGreaterThan(0)
    expect(refund.every((tx) => tx.direction === 'credit')).toBe(true)
  })

  it('credit rows total the 本期还款、退货金额 component', () => {
    const statement = abcParser.parse(makeDoc())
    const credits = statement.transactions.filter((tx) => tx.direction === 'credit')
    expect(-credits.reduce((sum, tx) => sum + tx.settlementAmountMinor, 0)).toBe(SYNTHETIC_ABC.newCreditMinor)
  })

  it('separates the original installment purchase from the per-cycle posting', () => {
    const statement = abcParser.parse(makeDoc())
    const original = statement.transactions.filter((tx) => tx.type === 'installment_original')
    expect(original).toHaveLength(1)
    expect(Math.abs(original[0]!.settlementAmountMinor)).toBe(SYNTHETIC_ABC.installmentOriginalMinor)

    const perCycle = statement.transactions.filter((tx) => tx.type === 'installment_payment')
    expect(perCycle).toHaveLength(1)
    expect(Math.abs(perCycle[0]!.settlementAmountMinor)).toBe(SYNTHETIC_ABC.installmentPaymentMinor)
  })

  it('new spending equals the debit rows minus the original installment purchase', () => {
    const statement = abcParser.parse(makeDoc())
    const counted = statement.transactions
      .filter((tx) => tx.direction === 'debit' && tx.type !== 'installment_original')
      .reduce((sum, tx) => sum + tx.settlementAmountMinor, 0)
    expect(counted).toBe(SYNTHETIC_ABC.newDebitMinor)
  })

  it('resolves compact MMDD dates inside the cycle', () => {
    expect(resolveAbcDate('0716', { start: '2026-07-15', end: '2026-08-14' })).toBe('2026-07-16')
    expect(resolveAbcDate('0814', { start: '2026-07-15', end: '2026-08-14' })).toBe('2026-08-14')
    expect(parseSlashAmount('68.00/CNY')).toEqual({ currency: 'CNY', minor: 6800, negative: false })
    expect(parseSlashAmount('-68.00/CNY')).toEqual({ currency: 'CNY', minor: 6800, negative: true })
  })

  it('keeps identical same-day same-merchant rows separate', () => {
    const statement = abcParser.parse(makeDoc())
    const duplicates = statement.transactions.filter(
      (tx) => Math.abs(tx.settlementAmountMinor) === 10000 && tx.direction === 'debit',
    )
    expect(duplicates).toHaveLength(2)
  })

  it('repeating the import does not create duplicate transactions', () => {
    const parsed = abcParser.parse(makeDoc())
    const first = ingestParsedStatement(
      parsed,
      { fileName: 'synthetic-abc.eml', fileHash: 'hash-abc', fileSize: 1, sourceType: 'eml' },
      EMPTY,
    )
    expect(first.record.status).toBe('parsed')
    const second = ingestParsedStatement(
      parsed,
      { fileName: 'synthetic-abc.eml', fileHash: 'hash-abc', fileSize: 1, sourceType: 'eml' },
      { statements: [first.statement!], transactions: first.transactions, imports: [first.record] },
    )
    expect(second.record.status).toBe('duplicate')
    expect(second.inserted).toHaveLength(0)
  })

  it('fails loudly when the statement has no transaction table', () => {
    const html = '<html><body><table><tr><td>与账单无关的通知</td></tr></table></body></html>'
    expect(() => abcParser.parse(makeDoc(html))).toThrowError(/未找到交易明细表头/)
  })
})
