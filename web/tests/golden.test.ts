/**
 * Golden infrastructure tests (Task A-3.4).
 *
 * Mirrors `tests/test_golden.py`: schema stability, diff severity rules,
 * identity observation (no merging), desensitization determinism.
 * Does NOT assert post-fix parser results.
 */

import { describe, expect, it } from 'vitest'
import { normalizeDescription } from '../src/core/identity'
import { diffGolden } from '../src/golden/diff'
import { businessKeyOf } from '../src/golden/identityReport'
import { desensitizeDescription, desensitizeRawText, directionForMinor, fnv1a32, normalizeWebTransaction } from '../src/golden/normalize'
import { GOLDEN_SCHEMA, type GoldenStatement, type NormalizedTransaction } from '../src/golden/schema'
import { citicParser } from '../src/parsers/citic'
import { PARSERS } from '../src/parsers/registry'
import type { ParsedTransaction, SourceDocument } from '../src/parsers/types'

function makeParsed(): ParsedTransaction {
  return {
    cardLast4: '3443',
    transactionDate: '2026-05-23',
    postingDate: '2026-05-23',
    rawDescription: '消费 test-shop',
    description: '消费 test-shop',
    transactionCurrency: 'CNY',
    transactionAmountMinor: 1382,
    settlementCurrency: 'CNY',
    settlementAmountMinor: 1382,
    type: 'purchase',
    direction: 'debit',
    bankToken: '消费',
    confidence: 0.93,
    sourcePage: null,
    sourceRow: 0,
    rawText: '3443 | 2026-05-23 | 消费 test-shop | 13.82/RMB',
  }
}

function makeDoc(tx: NormalizedTransaction): GoldenStatement {
  return {
    schema: GOLDEN_SCHEMA,
    origin: 'web',
    generator: 'test',
    bank: 'icbc',
    bankNative: 'icbc',
    cardLast4: '3443',
    cycleStart: '2026-05-23',
    cycleEnd: '2026-06-22',
    parserName: 'icbc_eml',
    desensitized: false,
    nativeIds: {},
    transactionCount: 1,
    transactions: [tx],
  }
}

function norm(): NormalizedTransaction {
  return normalizeWebTransaction(makeParsed(), 'fp-1', 'skey-1', 0, { desensitize: false, bank: 'icbc' })
}

describe('golden normalize', () => {
  it('shares the fnv1a32 vector with the Python adapter', () => {
    expect(fnv1a32('hello')).toBe('4f9f2cab')
  })

  it('keeps P0 fields stable', () => {
    const tx = norm()
    expect(tx.bank).toBe('icbc')
    expect(tx.cardLast4).toBe('3443')
    expect(tx.transactionDate).toBe('2026-05-23')
    expect(tx.amountMinor).toBe(1382)
    expect(tx.currency).toBe('CNY')
    expect(tx.direction).toBe('debit')
    expect(tx.nativeId).toBe('fp-1')
    expect(tx.statementKey).toBe('skey-1')
  })

  it('derives direction from the settlement sign', () => {
    expect(directionForMinor(-500)).toBe('credit')
    expect(directionForMinor(500)).toBe('debit')
  })
})

describe('golden diff rules', () => {
  it('identical rows pass', () => {
    const report = diffGolden(makeDoc(norm()), makeDoc(norm()), 'test')
    expect(report.verdict).toBe('PASS')
    expect(report.findings).toEqual([])
    expect(report.pairedRows).toBe(1)
  })

  it('amount mismatch blocks via unpaired rows', () => {
    const web = norm()
    web.amountMinor = 1383
    const report = diffGolden(makeDoc(norm()), makeDoc(web), 'test')
    expect(report.verdict).toBe('BLOCKING')
    expect(report.findings.some((f) => f.severity === 'BLOCKING' && f.rule === 'transaction_count')).toBe(true)
  })

  it('direction mismatch blocks', () => {
    const web = norm()
    web.direction = 'credit'
    const report = diffGolden(makeDoc(norm()), makeDoc(web), 'test')
    expect(report.verdict).toBe('BLOCKING')
    expect(report.findings.some((f) => f.severity === 'BLOCKING' && f.rule === 'direction')).toBe(true)
  })

  it('currency mismatch blocks rather than becoming an approved warning', () => {
    const web = norm()
    web.currency = 'USD'
    const report = diffGolden(makeDoc(norm()), makeDoc(web), 'test')
    expect(report.verdict).toBe('BLOCKING')
    expect(report.severityCounts.BLOCKING).toBeGreaterThan(0)
  })

  it('scope mismatch blocks', () => {
    const web = norm()
    web.cardLast4 = '9999'
    const report = diffGolden(makeDoc(norm()), makeDoc(web), 'test')
    expect(report.verdict).toBe('BLOCKING')
    expect(report.findings.some((f) => f.severity === 'BLOCKING' && f.rule === 'identity_scope')).toBe(true)
  })
  it('date mismatch blocks via unpaired rows', () => {
    const web = norm()
    web.postingDate = '2026-05-24'
    const report = diffGolden(makeDoc(norm()), makeDoc(web), 'test')
    expect(report.verdict).toBe('BLOCKING')
    expect(report.findings.some((f) => f.severity === 'BLOCKING' && f.rule === 'transaction_count')).toBe(true)
  })

  it('count mismatch blocks', () => {
    const python = makeDoc(norm())
    python.transactions = [norm(), norm()]
    const report = diffGolden(python, makeDoc(norm()), 'test')
    expect(report.verdict).toBe('BLOCKING')
    expect(report.findings.some((f) => f.rule === 'transaction_count')).toBe(true)
  })

  it('description-only drift warns', () => {
    const web = norm()
    web.description = '消费 test-shop-b'
    web.normalizedDescription = normalizeDescription(web.description)
    expect(web.normalizedDescription).not.toBe(norm().normalizedDescription)
    const report = diffGolden(makeDoc(norm()), makeDoc(web), 'test')
    expect(report.verdict).toBe('WARNING')
    expect(report.findings.every((f) => f.severity === 'WARNING')).toBe(true)
    expect(report.findings.some((f) => f.rule === 'description')).toBe(true)
  })

  it('rawText-only drift is silent', () => {
    const web = norm()
    web.rawText = 'different debug text'
    const report = diffGolden(makeDoc(norm()), makeDoc(web), 'test')
    expect(report.verdict).toBe('PASS')
  })
})

describe('golden identity report', () => {
  it('never merges and stays observable', () => {
    const python = makeDoc(norm())
    python.transactions = [norm(), norm()]
    const report = diffGolden(python, makeDoc(norm()), 'test')
    expect(report.identity.compatible).toBe(false)
    expect(report.identity.merged).toBe(false)
    expect(report.identity.entries.length).toBeGreaterThan(0)
    expect(report.identity.entries.every((e) => e.merged === false)).toBe(true)
    expect(new Set(report.identity.entries.map((e) => e.match))).toEqual(new Set(['full', 'unpaired']))
  })

  it('builds stable business keys', () => {
    expect(businessKeyOf(norm())).toBe('2026-05-23|2026-05-23|1382|CNY')
  })
})

describe('citic parser identity', () => {
  function citicDoc(text: string): SourceDocument {
    return {
      fileName: 'citic.eml',
      fileSize: 1000,
      fileHash: 'hash-citic',
      sourceType: 'eml',
      pdf: null,
      html: null,
      tables: [],
      text,
      email: { subject: '中信银行信用卡电子账单', from: 'citic@citicbank.com', date: null },
    }
  }

  it('is bank citic and registered in production', () => {
    expect(citicParser.bank).toBe('citic')
    expect(citicParser.id).toBe('citic_eml')
    expect(citicParser.sourceTypes).toContain('eml')
    expect(PARSERS).toContain(citicParser)
  })

  it('matches CITIC mail text and rejects unrelated mail', () => {
    expect(citicParser.match(citicDoc('中信银行信用卡电子账单 账单周期 交易明细'))).toBeGreaterThan(0)
    const unrelated = citicDoc('Some unrelated travel receipt')
    unrelated.email = { subject: 'hello', from: 'a@b.invalid', date: null }
    expect(citicParser.match(unrelated)).toBe(0)
  })
})

describe('golden desensitization', () => {
  it('is deterministic and keeps structural prefixes', () => {
    const first = desensitizeDescription('网上消费 财付通，京东商城平台商户')
    expect(first).toBe(desensitizeDescription('网上消费 财付通，京东商城平台商户'))
    expect(first.startsWith('网上消费 商户_')).toBe(true)
    const other = desensitizeDescription('网上消费 另一家完全不同的店铺名称')
    expect(other.startsWith('网上消费 商户_')).toBe(true)
    expect(other).not.toBe(first)
    expect(desensitizeDescription('还款')).toBe('还款')
  })

  it('masks raw text but keeps amounts and dates', () => {
    const masked = desensitizeRawText('3443 | 2026-05-23 | 消费 财付通京东商城 | 13.82/RMB(支出)')
    expect(masked).toContain('13.82')
    expect(masked).toContain('2026-05-23')
    expect(masked).not.toContain('财付通京东商城')
    const latin = desensitizeRawText('5155 | 消费 FILA旗舰店-SHARESIES LTD SYDNEY | CNY 1672.90')
    expect(latin).not.toContain('FILA')
    expect(latin).not.toContain('SHARESIES')
    expect(latin).not.toContain('SYDNEY')
    expect(latin).toContain('CNY')
    expect(latin).toContain('1672.90')
  })
})
