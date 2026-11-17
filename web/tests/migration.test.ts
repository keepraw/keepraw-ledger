/**
 * Legacy migration dry-run (Task A-4.1). No database, no writes.
 *
 * Runs the REAL legacy adapter, identity, classify and dedupe functions on
 * synthetic export-shaped rows to prove, with code rather than prose:
 *  1. legacy rows can produce fingerprints (incl. float dust + excel serials),
 *  2. token-dependent native types fork under legacy inference,
 *  3. forked rows are NOT merged by detectDuplicates but now request review,
 *     while plain rows link and skip.
 */

import { describe, expect, it } from 'vitest'
import { legacyTypeForIdentity } from '../src/core/classify'
import { assignOccurrences, detectDuplicates, transactionId } from '../src/core/dedupe'
import { transactionFingerprint } from '../src/core/identity'
import {
  LEGACY_UNIFIED_COLUMNS,
  detectLegacyShape,
  parseLegacyRows,
} from '../src/importers/legacyPythonExportV1'

function legacyRow(cells: Record<string, unknown>): unknown[] {
  return LEGACY_UNIFIED_COLUMNS.map((column) => cells[column] ?? null)
}

const HEADER = [...LEGACY_UNIFIED_COLUMNS]

describe('legacy export rows produce fingerprints', () => {
  it('handles float dust, excel serials, RMB and masked cards', () => {
    const shape = detectLegacyShape(HEADER)
    expect(shape).not.toBeNull()
    const { rows, anomalies, totalRows } = parseLegacyRows(
      [
        legacyRow({
          bank: '中国银行',
          card_last4: '6505',
          statement_start: '2026-06-05',
          statement_end: '2026-07-04',
          transaction_date: 45812,
          posting_date: 45812,
          description: '消费 支付宝-示例餐厅',
          transaction_currency: 'RMB',
          transaction_amount: 11.120000000000001,
          settlement_currency: 'RMB',
          settlement_amount: 11.120000000000001,
          source_file_name: 'boc.pdf',
          source_file_hash: 'h',
          confidence: 0.9,
          raw_text: 'row',
        }),
      ],
      shape!,
    )
    expect(totalRows).toBe(1)
    expect(anomalies).toEqual([])
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row.bank).toBe('boc')
    expect(row.transactionDate).toBe('2025-06-04')
    expect(row.transactionCurrency).toBe('CNY')
    expect(row.settlementAmountMinor).toBe(1112)
    expect(row.direction).toBe('debit')
    expect(row.type).toBe('purchase')

    const fingerprint = transactionFingerprint({
      bank: row.bank,
      cardLast4: row.cardLast4,
      transactionDate: row.transactionDate,
      postingDate: row.postingDate,
      settlementCurrency: row.settlementCurrency,
      settlementAmountMinor: row.settlementAmountMinor,
      type: row.type,
      description: row.description,
    })
    expect(fingerprint).toMatch(/^[0-9a-f]{16}$/)
    const occurrences = assignOccurrences([fingerprint, fingerprint])
    expect(transactionId(fingerprint, occurrences[0]!.occurrence)).toBe(fingerprint)
    expect(transactionId(fingerprint, occurrences[1]!.occurrence)).toBe(`${fingerprint}#2`)
  })
})

describe('legacy inference forks token-dependent native types', () => {
  it('installment posting: native installment_payment vs legacy purchase', () => {
    expect(legacyTypeForIdentity('分期扣款', 'debit')).toBe('installment_payment')
    expect(legacyTypeForIdentity('', 'debit')).toBe('purchase')
  })

  it('unprefixed cashback: native cashback vs legacy payment', () => {
    expect(legacyTypeForIdentity('刷卡金', 'credit')).toBe('cashback')
    expect(legacyTypeForIdentity('', 'credit')).toBe('payment')
  })

  it('prefixed purchase agrees on both paths', () => {
    expect(legacyTypeForIdentity('消费', 'debit')).toBe('purchase')
    expect(legacyTypeForIdentity('', 'debit')).toBe('purchase')
  })
})

describe('duplicate risk on re-import after legacy migration', () => {
  const base = {
    bank: 'icbc',
    cardLast4: '3443',
    transactionDate: '2026-07-16',
    settlementCurrency: 'CNY',
    settlementAmountMinor: 30000,
    description: '1/3期-商户分期-示例通讯-分3期',
  }

  it('forked installment rows request review without merging', () => {
    const nativeFingerprint = transactionFingerprint({ ...base, postingDate: '2026-07-16', type: 'installment_payment' })
    const legacyFingerprint = transactionFingerprint({ ...base, postingDate: '2026-07-16', type: 'purchase' })
    expect(nativeFingerprint).not.toBe(legacyFingerprint)

    const { duplicateIds, suspectedDuplicates } = detectDuplicates(
      [
        {
          id: nativeFingerprint,
          fingerprint: nativeFingerprint,
          bank: base.bank,
          cardLast4: base.cardLast4,
          transactionDate: base.transactionDate,
          settlementAmountMinor: base.settlementAmountMinor,
          type: 'installment_payment',
          description: base.description,
        },
      ],
      [
        {
          fingerprint: legacyFingerprint,
          bank: base.bank,
          cardLast4: base.cardLast4,
          transactionDate: base.transactionDate,
          settlementAmountMinor: base.settlementAmountMinor,
          type: 'purchase',
          description: base.description,
        },
      ],
    )
    // The fingerprint stays different. Read-only business candidates now expose
    // the type disagreement, while insertion remains conservative.
    expect(duplicateIds.size).toBe(0)
    expect(suspectedDuplicates.size).toBe(1)
  })

  it('plain purchase rows link and skip', () => {
    const fingerprint = transactionFingerprint({
      ...base,
      postingDate: '2026-07-16',
      settlementAmountMinor: 6800,
      description: '消费 支付宝-示例餐厅',
      type: 'purchase',
    })
    const { duplicateIds } = detectDuplicates(
      [
        {
          id: fingerprint,
          fingerprint,
          bank: base.bank,
          cardLast4: base.cardLast4,
          transactionDate: base.transactionDate,
          settlementAmountMinor: 6800,
          type: 'purchase',
          description: '消费 支付宝-示例餐厅',
        },
      ],
      [
        {
          fingerprint,
          bank: base.bank,
          cardLast4: base.cardLast4,
          transactionDate: base.transactionDate,
          settlementAmountMinor: 6800,
          type: 'purchase',
          description: '消费 支付宝-示例餐厅',
        },
      ],
    )
    expect(duplicateIds.has(fingerprint)).toBe(true)
  })
})
