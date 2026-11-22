import { describe, expect, it } from 'vitest'
import {
  citicParser,
  locateCycle,
  locateTxnTable,
  parseCombinedAmount,
  cleanDescription,
} from '../src/parsers/citic'
import { detectParser } from '../src/parsers/registry'
import { extractTables, extractText, sanitizeHtml } from '../src/parsers/html'
import type { SourceDocument } from '../src/parsers/types'
import { SYNTHETIC_CITIC, SYNTHETIC_CITIC_HTML, SYNTHETIC_CITIC_NET_HTML } from './fixtures/citicEml'
import { SYNTHETIC_BOCOM_HTML } from './fixtures/bocomEml'
import { ingestParsedStatement, type ExistingSnapshot } from '../src/core/ingest'

function makeDoc(html = SYNTHETIC_CITIC_HTML): SourceDocument {
  const safe = sanitizeHtml(html)
  return {
    fileName: 'synthetic-citic.eml',
    fileSize: 5000,
    fileHash: 'hash-citic',
    sourceType: 'eml',
    pdf: null,
    html: safe,
    tables: extractTables(safe),
    text: extractText(safe),
    email: { subject: '中信银行信用卡电子账单', from: 'citiccard@bill.citiccard.com', date: '2026-08-15' },
  }
}

const EMPTY: ExistingSnapshot = { statements: [], transactions: [], imports: [] }

describe('CITIC EML parser', () => {
  it('recognises the bank and product', () => {
    expect(citicParser.match(makeDoc())).toBe(1)
  })

  it('is picked by the registry for a CITIC document', () => {
    expect(detectParser(makeDoc())?.parser.id).toBe('citic_eml')
  })

  it('does not match unrelated mail', () => {
    const doc = makeDoc()
    doc.text = 'Some unrelated travel receipt'
    doc.email = { subject: 'hello', from: 'a@b.invalid', date: null }
    expect(citicParser.match(doc)).toBe(0)
  })

  it('does not match other banks statements', () => {
    const safe = sanitizeHtml(SYNTHETIC_BOCOM_HTML)
    const bocomDoc: SourceDocument = {
      fileName: 'synthetic-bocom.eml',
      fileSize: 5000,
      fileHash: 'hash-bocom',
      sourceType: 'eml',
      pdf: null,
      html: safe,
      tables: extractTables(safe),
      text: extractText(safe),
      email: { subject: '交通银行个人信用卡2026年08月电子账单', from: 'a@b.invalid', date: '2026-08-15' },
    }
    expect(citicParser.match(bocomDoc)).toBe(0)
  })

  it('extracts card last four and the statement cycle', () => {
    const statement = citicParser.parse(makeDoc())
    expect(statement.cardLast4).toBe(SYNTHETIC_CITIC.cardLast4)
    expect(statement.cycleStart).toBe(SYNTHETIC_CITIC.cycleStart)
    expect(statement.cycleEnd).toBe(SYNTHETIC_CITIC.cycleEnd)
    expect(statement.dueDate).toBe(SYNTHETIC_CITIC.dueDate)
  })

  it('finds the transaction table header', () => {
    expect(locateTxnTable(makeDoc())).not.toBeNull()
  })

  it('extracts the cycle from the greeting sentence', () => {
    expect(locateCycle(makeDoc())).toEqual({ start: SYNTHETIC_CITIC.cycleStart, end: SYNTHETIC_CITIC.cycleEnd })
  })

  it('reads every transaction row', () => {
    const statement = citicParser.parse(makeDoc())
    expect(statement.transactions).toHaveLength(SYNTHETIC_CITIC.transactionCount)
  })

  it('extracts summary components', () => {
    const { summary } = citicParser.parse(makeDoc())
    expect(summary.previousBalanceMinor).toBe(SYNTHETIC_CITIC.previousBalanceMinor)
    expect(summary.newCreditMinor).toBe(SYNTHETIC_CITIC.newCreditMinor)
    expect(summary.newDebitMinor).toBe(SYNTHETIC_CITIC.newDebitMinor)
    expect(summary.currentBalanceMinor).toBe(SYNTHETIC_CITIC.currentBalanceMinor)
    expect(summary.minimumPaymentMinor).toBe(SYNTHETIC_CITIC.minimumPaymentMinor)
    expect(summary.detailBasis).toBe('net')
  })

  it('balances the statement equation', () => {
    const { summary } = citicParser.parse(makeDoc())
    const computed =
      summary.previousBalanceMinor! + summary.newDebitMinor! - summary.newCreditMinor!
    expect(computed).toBe(summary.currentBalanceMinor)
  })

  it('uses the amount sign, not the merchant text, for the direction', () => {
    const statement = citicParser.parse(makeDoc())
    const repayment = statement.transactions.find((tx) => tx.bankToken === '多渠道还款')
    expect(repayment!.direction).toBe('credit')
    expect(repayment!.settlementAmountMinor).toBeLessThan(0)
    expect(repayment!.type).toBe('payment')

    // The merchant name merely resembles a cashback word (返利, not the 返现
    // token) and the row stays a debit purchase.
    const tricky = statement.transactions.filter((tx) => tx.description.includes('返利体验店'))
    expect(tricky).toHaveLength(2)
    for (const tx of tricky) {
      expect(tx.direction).toBe('debit')
      expect(tx.settlementAmountMinor).toBeGreaterThan(0)
    }
  })

  it('credit rows total the 上期已还款额 component', () => {
    const statement = citicParser.parse(makeDoc())
    const credits = statement.transactions.filter((tx) => tx.direction === 'credit')
    expect(-credits.reduce((sum, tx) => sum + tx.settlementAmountMinor, 0)).toBe(SYNTHETIC_CITIC.newCreditMinor)
  })

  it('debit rows total the 本期新增金额 component', () => {
    const statement = citicParser.parse(makeDoc())
    const counted = statement.transactions
      .filter((tx) => tx.direction === 'debit')
      .reduce((sum, tx) => sum + tx.settlementAmountMinor, 0)
    expect(counted).toBe(SYNTHETIC_CITIC.newDebitMinor)
  })

  it('reconciles gross refund, cashback, and 延期还款 rows against the bank net summary', () => {
    const parsed = citicParser.parse(makeDoc(SYNTHETIC_CITIC_NET_HTML))
    const result = ingestParsedStatement(parsed,
      { fileName: 'synthetic-citic-net.eml', fileHash: 'citic-net', fileSize: 1, sourceType: 'eml' }, EMPTY)
    expect(parsed.transactions.some((tx) => tx.direction === 'credit' && tx.rawDescription.includes('退款'))).toBe(true)
    expect(parsed.transactions.some((tx) => tx.direction === 'credit' && tx.rawDescription.includes('返现'))).toBe(true)
    expect(parsed.transactions.filter((tx) => tx.rawDescription === '延期还款').map((tx) => tx.direction).sort())
      .toEqual(['credit', 'debit'])
    expect(result.statement!.reconciliation.status).toBe('passed')
    expect(result.statement!.reconciliation.checks.map((check) => check.id)).toContain('net_detail')
    expect(result.statement!.reconciliation.checks.map((check) => check.id)).not.toContain('debit_detail')
    expect(result.statement!.reconciliation.checks.map((check) => check.id)).not.toContain('credit_detail')

    const withoutDebit = SYNTHETIC_CITIC_NET_HTML.replace(
      '<tr><td>20260813</td><td>20260813</td><td>6543</td><td></td><td>网上消费 示例商城</td><td>CNY 20000.00</td><td>CNY 20000.00</td></tr>',
      '',
    )
    const missing = ingestParsedStatement(citicParser.parse(makeDoc(withoutDebit)),
      { fileName: 'synthetic-citic-net-missing.eml', fileHash: 'citic-net-missing', fileSize: 1, sourceType: 'eml' }, EMPTY)
    expect(missing.statement!.reconciliation.status).toBe('mismatch')
    expect(missing.statement!.reconciliation.checks.find((check) => check.id === 'net_detail')?.status).toBe('mismatch')
  })

  it('keeps identical same-day same-merchant rows separate', () => {
    const statement = citicParser.parse(makeDoc())
    const duplicates = statement.transactions.filter(
      (tx) => tx.settlementAmountMinor === 5000 && tx.direction === 'debit',
    )
    expect(duplicates).toHaveLength(2)
    expect(new Set(duplicates.map((tx) => tx.rawText)).size).toBe(1)
  })

  it('parses combined currency/amount cells with explicit signs', () => {
    expect(parseCombinedAmount('CNY -100.00')).toEqual({ currency: 'CNY', minor: 10000, negative: true })
    expect(parseCombinedAmount('CNY 100.00')).toEqual({ currency: 'CNY', minor: 10000, negative: false })
    expect(parseCombinedAmount('CNY146.00')).toEqual({ currency: 'CNY', minor: 14600, negative: false })
    expect(parseCombinedAmount('-')).toBeNull()
  })

  it('strips only a trailing slash from descriptions', () => {
    expect(cleanDescription('财付通 /')).toBe('财付通')
    expect(cleanDescription('微信/支付宝')).toBe('微信/支付宝')
  })

  it('repeating the import does not create duplicate transactions', () => {
    const parsed = citicParser.parse(makeDoc())
    const first = ingestParsedStatement(
      parsed,
      { fileName: 'synthetic-citic.eml', fileHash: 'hash-citic', fileSize: 1, sourceType: 'eml' },
      EMPTY,
    )
    expect(first.record.status).toBe('parsed')
    expect(first.statement!.bank).toBe('citic')
    const second = ingestParsedStatement(
      parsed,
      { fileName: 'synthetic-citic.eml', fileHash: 'hash-citic', fileSize: 1, sourceType: 'eml' },
      { statements: [first.statement!], transactions: first.transactions, imports: [first.record] },
    )
    expect(second.record.status).toBe('duplicate')
    expect(second.inserted).toHaveLength(0)
  })

  it('fails loudly when the statement has no transaction table', () => {
    const html = '<html><body><table><tr><td>与账单无关的通知</td></tr></table></body></html>'
    expect(() => citicParser.parse(makeDoc(html))).toThrowError(/未找到交易明细表头/)
  })
})
