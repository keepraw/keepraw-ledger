import { describe, expect, it } from 'vitest'
import { icbcParser, locateCycle, locateTxnTable, parseSplitAmount, cleanDescription } from '../src/parsers/icbc'
import { extractTables, extractText, sanitizeHtml } from '../src/parsers/html'
import type { SourceDocument } from '../src/parsers/types'
import { SYNTHETIC_ICBC, SYNTHETIC_ICBC_HTML } from './fixtures/icbcEml'
import { ingestParsedStatement, type ExistingSnapshot } from '../src/core/ingest'

function makeDoc(html = SYNTHETIC_ICBC_HTML): SourceDocument {
  const safe = sanitizeHtml(html)
  return {
    fileName: 'synthetic-icbc.eml',
    fileSize: 5000,
    fileHash: 'hash-icbc',
    sourceType: 'eml',
    pdf: null,
    html: safe,
    tables: extractTables(safe),
    text: extractText(safe),
    email: { subject: '中国工商银行客户对账单(ICBC Peony Card Bank Statement)', from: 'webmaster@icbc.com.cn', date: '2026-08-15' },
  }
}

const EMPTY: ExistingSnapshot = { statements: [], transactions: [], imports: [] }

describe('ICBC EML parser', () => {
  it('recognises the bank and product', () => {
    expect(icbcParser.match(makeDoc())).toBe(1)
  })

  it('does not match unrelated mail', () => {
    const doc = makeDoc()
    doc.text = 'Some unrelated travel receipt'
    doc.email = { subject: 'hello', from: 'a@b.invalid', date: null }
    expect(icbcParser.match(doc)).toBe(0)
  })

  it('extracts card last four and the statement cycle', () => {
    const statement = icbcParser.parse(makeDoc())
    expect(statement.cardLast4).toBe(SYNTHETIC_ICBC.cardLast4)
    expect(statement.cycleStart).toBe(SYNTHETIC_ICBC.cycleStart)
    expect(statement.cycleEnd).toBe(SYNTHETIC_ICBC.cycleEnd)
    expect(statement.dueDate).toBe(SYNTHETIC_ICBC.dueDate)
  })

  it('finds the 7-column transaction table', () => {
    const located = locateTxnTable(makeDoc())
    expect(located).not.toBeNull()
  })

  it('extracts the cycle from the header', () => {
    expect(locateCycle(makeDoc())).toEqual({ start: SYNTHETIC_ICBC.cycleStart, end: SYNTHETIC_ICBC.cycleEnd })
  })

  it('reads every transaction row', () => {
    const statement = icbcParser.parse(makeDoc())
    expect(statement.transactions).toHaveLength(
      SYNTHETIC_ICBC.creditTransactionCount + SYNTHETIC_ICBC.debitTransactionCount,
    )
  })

  it('extracts summary components', () => {
    const { summary } = icbcParser.parse(makeDoc())
    expect(summary.previousBalanceMinor).toBe(SYNTHETIC_ICBC.previousBalanceMinor)
    expect(summary.newCreditMinor).toBe(SYNTHETIC_ICBC.newCreditMinor)
    expect(summary.newDebitMinor).toBe(SYNTHETIC_ICBC.newDebitMinor)
    expect(summary.currentBalanceMinor).toBe(SYNTHETIC_ICBC.currentBalanceMinor)
  })

  it('normalizes account-balance signs and reconciles the owed balance', () => {
    const parsed = icbcParser.parse(makeDoc())
    expect(parsed.summary).toMatchObject({
      previousBalanceMinor: 500000,
      newCreditMinor: 325000,
      newDebitMinor: 410000,
      currentBalanceMinor: 585000,
    })
    const result = ingestParsedStatement(parsed,
      { fileName: 'synthetic-icbc.eml', fileHash: 'hash-icbc-ingest', fileSize: 1, sourceType: 'eml' }, EMPTY)
    expect(result.statement!.reconciliation.status).toBe('passed')
  })

  it('warns when the payment overview differs from the account-balance row', () => {
    const html = SYNTHETIC_ICBC_HTML.replace('5850.00/RMB', '5800.00/RMB')
    expect(icbcParser.parse(makeDoc(html)).warnings).toContain('icbc_balance_disagreement')
  })

  it('balances the statement equation', () => {
    const { summary } = icbcParser.parse(makeDoc())
    const computed = summary.previousBalanceMinor! + summary.newDebitMinor! - summary.newCreditMinor!
    expect(computed).toBe(summary.currentBalanceMinor)
  })

  it('uses the 记账 suffix, not the merchant text, for the direction', () => {
    const statement = icbcParser.parse(makeDoc())
    const repayment = statement.transactions.find((tx) => tx.bankToken === '转账')
    expect(repayment!.direction).toBe('credit')
    expect(repayment!.transactionAmountMinor).toBeLessThan(0)

    const tricky = statement.transactions.find((tx) => tx.rawDescription.includes('还款机具'))
    expect(tricky!.direction).toBe('debit')
    expect(tricky!.transactionAmountMinor).toBeGreaterThan(0)

    const cashback = statement.transactions.find((tx) => tx.type === 'cashback')
    expect(cashback!.direction).toBe('credit')
    expect(cashback!.transactionAmountMinor).toBeLessThan(0)
  })

  it('credit rows total the 本期收入 component', () => {
    const statement = icbcParser.parse(makeDoc())
    const credits = statement.transactions.filter((tx) => tx.direction === 'credit')
    expect(-credits.reduce((sum, tx) => sum + tx.settlementAmountMinor, 0)).toBe(SYNTHETIC_ICBC.newCreditMinor)
  })

  it('separates the original installment purchase from the per-cycle posting', () => {
    const statement = icbcParser.parse(makeDoc())
    const original = statement.transactions.filter((tx) => tx.type === 'installment_original')
    expect(original).toHaveLength(1)
    expect(original[0]!.settlementAmountMinor).toBe(SYNTHETIC_ICBC.installmentOriginalMinor)

    const perCycle = statement.transactions.filter((tx) => tx.type === 'installment_payment')
    expect(perCycle).toHaveLength(1)
    expect(perCycle[0]!.settlementAmountMinor).toBe(SYNTHETIC_ICBC.installmentPaymentMinor)
  })

  it('new spending equals the debit rows minus the original installment purchase', () => {
    const statement = icbcParser.parse(makeDoc())
    const counted = statement.transactions
      .filter((tx) => tx.direction === 'debit' && tx.type !== 'installment_original')
      .reduce((sum, tx) => sum + tx.settlementAmountMinor, 0)
    expect(counted).toBe(SYNTHETIC_ICBC.newDebitMinor)
  })

  it('keeps identical same-day same-merchant rows separate', () => {
    const statement = icbcParser.parse(makeDoc())
    const duplicates = statement.transactions.filter(
      (tx) => tx.settlementAmountMinor === 10000 && tx.direction === 'debit',
    )
    expect(duplicates).toHaveLength(2)
  })

  it('parses split amounts with direction suffixes', () => {
    expect(parseSplitAmount('69.82/RMB')).toEqual({ currency: 'CNY', minor: 6982, direction: null })
    expect(parseSplitAmount('69.82/RMB(支出)')).toEqual({ currency: 'CNY', minor: 6982, direction: 'debit' })
    expect(parseSplitAmount('69.82/RMB(存入)')).toEqual({ currency: 'CNY', minor: 6982, direction: 'credit' })
    expect(parseSplitAmount('-')).toBeNull()
  })

  it('strips only a trailing slash from descriptions', () => {
    expect(cleanDescription('财付通 /')).toBe('财付通')
    expect(cleanDescription('微信/支付宝')).toBe('微信/支付宝')
  })

  it('repeating the import does not create duplicate transactions', () => {
    const parsed = icbcParser.parse(makeDoc())
    const first = ingestParsedStatement(
      parsed,
      { fileName: 'synthetic-icbc.eml', fileHash: 'hash-icbc', fileSize: 1, sourceType: 'eml' },
      EMPTY,
    )
    expect(first.record.status).toBe('parsed')
    const second = ingestParsedStatement(
      parsed,
      { fileName: 'synthetic-icbc.eml', fileHash: 'hash-icbc', fileSize: 1, sourceType: 'eml' },
      { statements: [first.statement!], transactions: first.transactions, imports: [first.record] },
    )
    expect(second.record.status).toBe('duplicate')
    expect(second.inserted).toHaveLength(0)
  })

  it('fails loudly when the statement has no transaction table', () => {
    const html = '<html><body><table><tr><td>与账单无关的通知</td></tr></table></body></html>'
    expect(() => icbcParser.parse(makeDoc(html))).toThrowError(/未找到交易明细表头/)
  })
})
