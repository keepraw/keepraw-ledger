import { beforeEach, describe, expect, it } from 'vitest'
import { bocomParser } from '../src/parsers/bocom'
import { bocParser } from '../src/parsers/boc'
import { pdfToText } from '../src/parsers/extract'
import { detectParser, supportedBanks } from '../src/parsers/registry'
import { detectSourceType, MAX_FILE_SIZE } from '../src/parsers/extract'
import { sanitizeHtml, extractTables, extractText } from '../src/parsers/html'
import { emptySummary, type SourceDocument } from '../src/parsers/types'
import { buildSyntheticBocPdf, SYNTHETIC_BOC } from './fixtures/bocPdf'
import { SYNTHETIC_BOCOM, SYNTHETIC_BOCOM_HTML } from './fixtures/bocomEml'
import { SYNTHETIC_CITIC_HTML } from './fixtures/citicEml'
import { ingestParsedStatement, type ExistingSnapshot } from '../src/core/ingest'
import { reconcileStatement } from '../src/core/reconcile'
import { buildDemoDataset } from '../src/demo/demoData'
import { applyFilters, DEFAULT_FILTERS, monthlyTrend, summarize } from '../src/core/analytics'
import { downloadCsv as _unused, buildCsv, escapeCsvCell, transactionToRow } from '../src/export/tabular'
import type { Transaction } from '../src/core/types'

void _unused

function bocDoc(): SourceDocument {
  const pdf = buildSyntheticBocPdf()
  return {
    fileName: 'synthetic.pdf',
    fileSize: 1,
    fileHash: 'h1',
    sourceType: 'pdf',
    pdf,
    html: null,
    tables: [],
    text: pdfToText(pdf),
    email: null,
  }
}

function bocomDoc(): SourceDocument {
  const safe = sanitizeHtml(SYNTHETIC_BOCOM_HTML)
  return {
    fileName: 'synthetic.eml',
    fileSize: 1,
    fileHash: 'h2',
    sourceType: 'eml',
    pdf: null,
    html: safe,
    tables: extractTables(safe),
    text: extractText(safe),
    email: { subject: '交通银行个人信用卡2026年08月电子账单', from: 'a@b.invalid', date: '2026-08-15' },
  }
}

function citicDoc(): SourceDocument {
  const safe = sanitizeHtml(SYNTHETIC_CITIC_HTML)
  return {
    fileName: 'synthetic-citic.eml',
    fileSize: 1,
    fileHash: 'h4',
    sourceType: 'eml',
    pdf: null,
    html: safe,
    tables: extractTables(safe),
    text: extractText(safe),
    email: { subject: '中信银行信用卡电子账单', from: 'citiccard@bill.citiccard.com', date: '2026-08-15' },
  }
}

const EMPTY: ExistingSnapshot = { statements: [], transactions: [], imports: [] }

describe('file type detection', () => {
  it('detects by extension and by magic bytes', () => {
    expect(detectSourceType('a.pdf', new Uint8Array())).toBe('pdf')
    expect(detectSourceType('a.eml', new Uint8Array())).toBe('eml')
    expect(detectSourceType('noext', new TextEncoder().encode('%PDF-1.7'))).toBe('pdf')
    expect(detectSourceType('a.docx', new Uint8Array())).toBe('unknown')
  })

  it('caps file size', () => {
    expect(MAX_FILE_SIZE).toBe(25 * 1024 * 1024)
  })
})

describe('bank detection', () => {
  it('only advertises banks that actually have a parser', () => {
    expect(supportedBanks().sort()).toEqual(['abc', 'boc', 'bocom', 'ccb', 'citic', 'icbc'])
  })

  it('picks the right parser', () => {
    expect(detectParser(bocDoc())!.parser.id).toBe('boc_pdf')
    expect(detectParser(bocomDoc())!.parser.id).toBe('bocom_eml')
    expect(detectParser(citicDoc())!.parser.id).toBe('citic_eml')
  })

  it('returns nothing for an unrecognised document instead of guessing', () => {
    const doc: SourceDocument = {
      fileName: 'unknown.pdf',
      fileSize: 1,
      fileHash: 'h3',
      sourceType: 'pdf',
      pdf: { numPages: 1, pages: [{ pageNumber: 1, width: 595, height: 842, items: [] }] },
      html: null,
      tables: [],
      text: '某旅行社的行程单',
      email: null,
    }
    expect(detectParser(doc)).toBeNull()
  })

  it('never falls back to a generic regex parser', () => {
    const doc = bocomDoc()
    doc.text = ''
    doc.email = null
    // Even with the structure present, the bank identity check must pass first.
    const match = detectParser(doc)
    expect(match === null || match.parser.bank === 'bocom').toBe(true)
  })
})

describe('HTML sanitisation', () => {
  it('removes remote images, scripts and event handlers', () => {
    const dirty = `<html><body><img src="https://track.example.com/p.gif" onerror="alert(1)"><script>alert(2)</script><a href="https://x.test">t</a><p>正文</p></body></html>`
    const safe = sanitizeHtml(dirty)
    expect(safe).not.toContain('track.example.com')
    expect(safe).not.toContain('<script')
    expect(safe).not.toContain('onerror')
    expect(safe).toContain('正文')
  })
})

describe('ingest + reconciliation pipeline', () => {
  let bocResult: ReturnType<typeof ingestParsedStatement>

  beforeEach(() => {
    bocResult = ingestParsedStatement(bocParser.parse(bocDoc()), {
      fileName: 'synthetic.pdf',
      fileHash: 'h1',
      fileSize: 1,
      sourceType: 'pdf',
    }, EMPTY)
  })

  it('marks a balanced statement as reconciled', () => {
    expect(bocResult.statement!.status).toBe('reconciled')
    expect(bocResult.record.status).toBe('parsed')
    expect(bocResult.record.message).toContain('对账通过')
  })

  it('never inserts a transaction twice for the same file', () => {
    const second = ingestParsedStatement(bocParser.parse(bocDoc()), {
      fileName: 'synthetic.pdf',
      fileHash: 'h1',
      fileSize: 1,
      sourceType: 'pdf',
    }, { statements: [bocResult.statement!], transactions: bocResult.transactions, imports: [bocResult.record] })

    expect(second.record.status).toBe('duplicate')
    expect(second.inserted).toHaveLength(0)
    expect(second.skippedDuplicates.length).toBeGreaterThan(0)
  })

  it('merges transactions when the same statement arrives from another file', () => {
    const other = ingestParsedStatement(bocParser.parse(bocDoc()), {
      fileName: 'synthetic-copy.pdf',
      fileHash: 'different-hash',
      fileSize: 1,
      sourceType: 'pdf',
    }, { statements: [bocResult.statement!], transactions: bocResult.transactions, imports: [bocResult.record] })

    expect(other.record.status).not.toBe('duplicate')
    expect(other.inserted).toHaveLength(0)
    expect(other.statement!.transactionCount).toBe(SYNTHETIC_BOC.transactionCount)
  })

  it('keeps same-day same-merchant purchases as separate rows', () => {
    const pair = bocResult.transactions.filter((tx) => tx.description.startsWith('示例商户A'))
    expect(pair).toHaveLength(2)
    expect(new Set(pair.map((tx) => tx.id)).size).toBe(2)
  })

  it('flags a same-day same-amount row with a different description as a suspected duplicate', () => {
    const pair = bocResult.transactions.filter((tx) => tx.description.startsWith('示例商户A'))
    expect(pair).toHaveLength(2)
    // The later row is flagged; both rows are kept - nothing is merged away.
    const flagged = pair.filter((tx) => tx.flags.includes('suspected_duplicate'))
    expect(flagged).toHaveLength(1)
    expect(flagged[0]!.description).toContain('门店2')
    expect(bocResult.transactions).toHaveLength(SYNTHETIC_BOC.transactionCount)
  })

  it('routes a mismatching statement to review instead of the statistics', () => {
    const parsed = bocomParser.parse(bocomDoc())
    parsed.summary.currentBalanceMinor = (parsed.summary.currentBalanceMinor ?? 0) + 1234
    const result = ingestParsedStatement(parsed, {
      fileName: 'synthetic.eml',
      fileHash: 'h2',
      fileSize: 1,
      sourceType: 'eml',
    }, EMPTY)

    expect(result.statement!.status).toBe('needs_review')
    expect(result.record.status).toBe('needs_review')
    expect(result.transactions.every((tx) => tx.flags.includes('statement_mismatch'))).toBe(true)
    expect(result.statement!.reconciliation.status).toBe('mismatch')
  })

  it('reports insufficient data when the statement has no summary', () => {
    const parsed = bocParser.parse(bocDoc())
    parsed.summary = emptySummary()
    const result = reconcileStatement({ summary: parsed.summary, transactions: bocResult.transactions })
    expect(result.status).toBe('insufficient')
    expect(result.checks.find((check) => check.id === 'balance_equation')!.status).toBe('missing')
  })

  it('never counts the original installment purchase as new spending', () => {
    const parsed = bocomParser.parse(bocomDoc())
    const summary = summarize(
      ingestParsedStatement(parsed, { fileName: 'x.eml', fileHash: 'h', fileSize: 1, sourceType: 'eml' }, EMPTY).transactions,
    )
    expect(summary.billingDebitMinor).toBe(SYNTHETIC_BOCOM.newDebitMinor)
    // Billing movement excludes the original purchase too: the bank does not post it.
    expect(summary.billingDebitMinor).toBe(SYNTHETIC_BOCOM.newDebitMinor)
    // The raw statement rows do contain it, so the two numbers must differ.
    expect(SYNTHETIC_BOCOM.totalDebitRowsMinor - summary.billingDebitMinor).toBe(SYNTHETIC_BOCOM.installmentOriginalMinor)
  })

  it('separates real spending from billing movement', () => {
    const parsed = bocomParser.parse(bocomDoc())
    const transactions = ingestParsedStatement(parsed, { fileName: 'x.eml', fileHash: 'h', fileSize: 1, sourceType: 'eml' }, EMPTY)
      .transactions
    const summary = summarize(transactions)
    expect(summary.billingCreditMinor).toBe(720000)
    expect(summary.netMinor).toBe(summary.billingDebitMinor - summary.billingCreditMinor)
  })
})

describe('demo dataset', () => {
  it('builds only clearly fictional data and is self-consistent', () => {
    const results = buildDemoDataset()
    expect(results.length).toBeGreaterThan(3)

    const cards = new Set(results.flatMap((r) => r.transactions.map((tx) => tx.cardLast4)))
    expect([...cards].every((card) => card === '0000' || card === '9999')).toBe(true)

    const reconciled = results.filter((r) => r.statement!.status === 'reconciled')
    expect(reconciled.length).toBeGreaterThanOrEqual(results.length - 1)
    // The last statement intentionally carries a discrepancy so review is demonstrable.
    expect(results[results.length - 1]!.statement!.status).toBe('needs_review')

    for (const result of results) {
      expect(result.transactions.every((tx) => tx.isDemo)).toBe(true)
    }
  })

  it('is reproducible', () => {
    const first = buildDemoDataset()
    const second = buildDemoDataset()
    expect(first.map((r) => r.transactions.length)).toEqual(second.map((r) => r.transactions.length))
    expect(first[0]!.transactions[0]!.id).toBe(second[0]!.transactions[0]!.id)
  })
})

describe('analytics', () => {
  it('groups monthly spending and refunds', () => {
    const results = buildDemoDataset()
    const transactions = results.flatMap((r) => r.transactions)
    const trend = monthlyTrend(transactions)
    expect(trend.length).toBeGreaterThan(1)
    expect(trend.every((entry) => entry.debit >= 0)).toBe(true)
    expect(new Set(trend.map((entry) => entry.month)).size).toBe(trend.length)
  })

  it('applies filters', () => {
    const transactions = buildDemoDataset().flatMap((r) => r.transactions)
    expect(applyFilters(transactions, { ...DEFAULT_FILTERS, banks: ['boc'] }).every((tx) => tx.bank === 'boc')).toBe(true)
    expect(applyFilters(transactions, { ...DEFAULT_FILTERS, cards: ['0000'] }).every((tx) => tx.cardLast4 === '0000')).toBe(true)
    const first = transactions.find((tx) => tx.transactionDate)!
    const bounded = applyFilters(transactions, { ...DEFAULT_FILTERS, from: first.transactionDate!, to: first.transactionDate! })
    expect(bounded.every((tx) => tx.transactionDate === first.transactionDate)).toBe(true)
  })
})

describe('export', () => {
  it('escapes formula-like text', () => {
    expect(escapeCsvCell('=1+1')).toBe("'=1+1")
    expect(escapeCsvCell('+cmd')).toBe("'+cmd")
    expect(escapeCsvCell('@SUM(A1)')).toBe("'@SUM(A1)")
    expect(escapeCsvCell('a,b')).toBe('"a,b"')
    expect(escapeCsvCell('普通文本')).toBe('普通文本')
  })

  it('writes amounts as exact decimals', () => {
    const tx = buildDemoDataset()[0]!.transactions[0] as Transaction
    const row = transactionToRow(tx)
    expect(row[8]).toMatch(/^-?\d+\.\d{2}$/)
    expect(row[8]).toBe((tx.settlementAmountMinor / 100).toFixed(2))
  })

  it('produces a header plus one row per transaction', () => {
    const transactions = buildDemoDataset()[0]!.transactions
    const csv = buildCsv(transactions)
    expect(csv.split('\r\n')).toHaveLength(transactions.length + 1)
    expect(csv.split('\r\n')[0]).toContain('交易描述')
  })
})