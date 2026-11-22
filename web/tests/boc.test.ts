import { describe, expect, it } from 'vitest'
import { bocParser, cleanDescription } from '../src/parsers/boc'
import { pdfToText } from '../src/parsers/extract'
import type { SourceDocument } from '../src/parsers/types'
import { buildSyntheticBocPdf, SYNTHETIC_BOC } from './fixtures/bocPdf'

function makeDoc(coordinates: 'top-down' | 'bottom-up' = 'top-down'): SourceDocument {
  const pdf = buildSyntheticBocPdf(coordinates)
  return {
    fileName: 'synthetic-boc.pdf',
    fileSize: 1000,
    fileHash: 'hash-boc',
    sourceType: 'pdf',
    pdf,
    html: null,
    tables: [],
    text: pdfToText(pdf),
    email: null,
  }
}

describe('BOC PDF parser', () => {
  it('recognises the bank and statement template', () => {
    expect(bocParser.match(makeDoc())).toBe(1)
  })

  it('does not match unrelated PDFs', () => {
    const doc = makeDoc()
    doc.text = 'Some unrelated travel receipt'
    expect(bocParser.match(doc)).toBe(0)
  })

  it('extracts card last four and the statement cycle', () => {
    const statement = bocParser.parse(makeDoc())
    expect(statement.cardLast4).toBe(SYNTHETIC_BOC.cardLast4)
    expect(statement.cycleEnd).toBe(SYNTHETIC_BOC.cycleEnd)
    expect(statement.cycleStart).toBe(SYNTHETIC_BOC.cycleStart)
    expect(statement.dueDate).toBe(SYNTHETIC_BOC.dueDate)
  })

  it('extracts every summary component from the account overview', () => {
    const { summary } = bocParser.parse(makeDoc())
    expect(summary.previousBalanceMinor).toBe(SYNTHETIC_BOC.previousBalanceMinor)
    expect(summary.newDebitMinor).toBe(SYNTHETIC_BOC.newDebitMinor)
    expect(summary.newCreditMinor).toBe(SYNTHETIC_BOC.newCreditMinor)
    expect(summary.currentBalanceMinor).toBe(SYNTHETIC_BOC.currentBalanceMinor)
    expect(summary.minimumPaymentMinor).toBe(SYNTHETIC_BOC.minimumPaymentMinor)
  })

  it('balances the statement: previous + new charges - new credits = current', () => {
    const { summary } = bocParser.parse(makeDoc())
    const computed =
      summary.previousBalanceMinor! + summary.newDebitMinor! - summary.newCreditMinor!
    expect(computed).toBe(summary.currentBalanceMinor)
    expect(computed).toBe(SYNTHETIC_BOC.currentBalanceMinor)
  })

  it('reads every transaction row', () => {
    const statement = bocParser.parse(makeDoc())
    expect(statement.transactions).toHaveLength(SYNTHETIC_BOC.transactionCount)
  })

  it('takes the amount direction from the printed column, not from the description', () => {
    const statement = bocParser.parse(makeDoc())

    // Printed in the 支出 (Expenditure) column -> expense, even though the text says 还款.
    const repayment = statement.transactions.find((tx) => tx.rawDescription.includes('还款'))
    expect(repayment).toBeDefined()
    expect(repayment!.direction).toBe('credit')
    expect(repayment!.transactionAmountMinor).toBe(-300000)

    const purchase = statement.transactions.find((tx) => tx.rawDescription.includes('咖啡'))
    expect(purchase!.direction).toBe('debit')
    expect(purchase!.transactionAmountMinor).toBe(4800)
  })

  it('keeps all rows in the 存入 column as credits and 支出 as debits', () => {
    const statement = bocParser.parse(makeDoc())
    const debit = statement.transactions.filter((tx) => tx.direction === 'debit')
    const credit = statement.transactions.filter((tx) => tx.direction === 'credit')
    expect(debit.reduce((sum, tx) => sum + tx.transactionAmountMinor, 0)).toBe(SYNTHETIC_BOC.newDebitMinor)
    expect(-credit.reduce((sum, tx) => sum + tx.transactionAmountMinor, 0)).toBe(SYNTHETIC_BOC.newCreditMinor)
  })

  it.each(['top-down', 'bottom-up'] as const)('reassembles complete wrapped descriptions in %s coordinates', (coordinates) => {
    const doc = makeDoc(coordinates)
    const page = doc.pdf!.pages[1]!
    page.items = page.items.map(item => ({ ...item,
      text: item.text === '示例超市-西门店' ? '支付宝-阿里健康大药房医'
        : item.text === '（测试）' ? '药连锁有限公司' : item.text,
    }))
    doc.text = pdfToText(doc.pdf!)
    const statement = bocParser.parse(doc)
    const wrapped = statement.transactions.find((tx) => tx.transactionAmountMinor === 4800)
    expect(wrapped!.description).toBe('微信-示例咖啡店')

    const twoLine = statement.transactions.find((tx) => tx.transactionAmountMinor === 100000)
    expect(twoLine!.rawDescription).toBe('支付宝-阿里健康大药房医药连锁有限公司')
    expect(twoLine!.description).toBe('支付宝-阿里健康大药房医药连锁有限公司')
    expect(statement.transactions.map(tx => tx.transactionAmountMinor)).toEqual([
      4800, 15200, 100000, -300000, -100000, -100000, -60000,
    ])
    expect(statement.transactions.map(tx => tx.sourceRow)).toEqual([0, 1, 2, 3, 4, 5, 6])
  })

  it('keeps identical same-day purchases as separate rows', () => {
    const statement = bocParser.parse(makeDoc())
    const identical = statement.transactions.filter(
      (tx) => tx.settlementAmountMinor === -100000 && tx.description.includes('示例商户A'),
    )
    expect(identical).toHaveLength(2)
  })

  it('keeps a 存款 qualified balance negative', () => {
    const doc = makeDoc()
    doc.pdf!.pages[0]!.items = doc.pdf!.pages[0]!.items.map((entry) =>
      entry.text.startsWith('欠款/DEBT 5000.00') ? { ...entry, text: '存款/CREDIT BAL 5000.00' } : entry,
    )
    const { summary } = bocParser.parse(doc)
    expect(summary.previousBalanceMinor).toBe(-500000)
  })
})

describe('BOC description cleanup', () => {
  it('strips only a trailing slash and keeps internal slashes', () => {
    expect(cleanDescription('财付通 /')).toBe('财付通')
    expect(cleanDescription('微信/支付宝')).toBe('微信/支付宝')
  })
})
