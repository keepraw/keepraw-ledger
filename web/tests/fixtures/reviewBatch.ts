import { deriveStatementState } from '../../src/core/statementState'
import { ingestSynthetic } from './identity'
import { nativeTransaction } from './nativeLedger'
import type { BankColumnAmounts, Statement, Transaction } from '../../src/core/types'

export function reviewBatchFixture(count: number) {
  const result = ingestSynthetic(['消费 合成批量复核'])
  const rows = Array.from({ length: count }, (_, index) => nativeTransaction(index + 1, {
    statementId: result.statement!.id, description: `Synthetic review ${index}`, rawDescription: `Synthetic review ${index}`,
    reviewStatus: 'pending', flags: index < 2 ? ['date_missing', 'suspected_duplicate'] : ['date_missing'],
  }))
  const controls: Transaction[] = [nativeTransaction(count + 1, { statementId: result.statement!.id, flags: [], reviewStatus: 'ok' }),
    nativeTransaction(count + 2, { statementId: result.statement!.id, flags: ['date_missing'], reviewStatus: 'rejected' })]
  return { statements: [{ ...result.statement!, status: 'imported' as const, transactionCount: rows.length + 2 }],
    transactions: [...rows, ...controls], imports: [result.record],
    notes: [...rows, ...controls].map(row => ({ transactionId: row.id, note: `Synthetic review note ${row.id}`, updatedAt: '2024-01-01T00:00:00Z' })) }
}

const BOC_DUAL_COLUMNS: BankColumnAmounts = {
  source: 'boc_pdf',
  rowBinding: 'single_transaction_anchor',
  debit: { direction: 'debit', rawText: '152.00', amountMinor: 15200, currency: 'CNY' },
  credit: { direction: 'credit', rawText: '12.34', amountMinor: 1234, currency: 'CNY' },
}

export function mixedDirectionReviewBatchFixture(count = 946) {
  const firstIngest = ingestSynthetic(['消费 合成账单甲'])
  const secondIngest = ingestSynthetic(['消费 合成账单乙'])
  const firstId = 'boc:0012:2024-01-01:2024-01-31'
  const secondId = 'abc:8899:2024-02-01:2024-02-29'

  const pendingRows: Transaction[] = Array.from({ length: count }, (_, index) => {
    const occurrence = index + 1
    const inSecond = index >= Math.floor(count / 2)
    const statementId = inSecond ? secondId : firstId
    const txDate = inSecond ? '2024-02-10' : '2024-01-10'
    const postDate = inSecond ? '2024-02-11' : '2024-01-11'
    const base = {
      statementId,
      transactionDate: txDate,
      postingDate: postDate,
      transactionCurrency: 'CNY',
      settlementCurrency: 'CNY',
      postingExclusion: null,
      description: `Synthetic mixed ${index}`,
      rawDescription: `Synthetic mixed ${index}`,
      rawText: `${txDate} | Synthetic mixed ${index} | 152.00 | 12.34`,
    }
    const kind = index % 10
    if (kind === 0) {
      // 1. Ordinary positive debit
      return nativeTransaction(occurrence, {
        ...base, bank: 'boc', cardLast4: '0012', direction: 'debit',
        transactionAmountMinor: 1000, settlementAmountMinor: 1000,
        directionEvidence: { kind: 'bank', detail: '合成借记列' },
        flags: ['low_confidence'], reviewStatus: 'pending',
      })
    }
    if (kind === 1) {
      // 2. Ordinary negative credit (some with suspected_duplicate)
      return nativeTransaction(occurrence, {
        ...base, bank: 'abc', cardLast4: '8899', type: 'refund', direction: 'credit',
        transactionAmountMinor: -400, settlementAmountMinor: -400,
        directionEvidence: { kind: 'bank', detail: '合成贷记列' },
        flags: index % 20 === 1 ? ['suspected_duplicate'] : ['low_confidence'], reviewStatus: 'pending',
      })
    }
    if (kind === 2) {
      // 3a. Bank direction evidence (debit) with negative source amount sign conflict
      return nativeTransaction(occurrence, {
        ...base, bank: 'abc', cardLast4: '8899', direction: 'debit',
        transactionAmountMinor: -6800, settlementAmountMinor: 6800,
        directionEvidence: { kind: 'bank', detail: '合成农业银行支出分区' },
        flags: ['amount_direction_unclear', 'statement_mismatch'], reviewStatus: 'pending',
      })
    }
    if (kind === 3) {
      // 3b. Bank direction evidence (credit) with positive source amount sign conflict + suspected_duplicate
      return nativeTransaction(occurrence, {
        ...base, bank: 'ccb', cardLast4: '8899', type: 'payment', direction: 'credit',
        transactionAmountMinor: 3000, settlementAmountMinor: -3000,
        directionEvidence: { kind: 'bank', detail: '合成建设银行存入标记' },
        flags: ['amount_direction_unclear', 'suspected_duplicate'], reviewStatus: 'pending',
      })
    }
    if (kind === 4) {
      // 4a. Historical record without directionEvidence (undefined), debit with sign conflict
      return nativeTransaction(occurrence, {
        ...base, bank: 'citic', cardLast4: '0012', direction: 'debit',
        transactionAmountMinor: -2500, settlementAmountMinor: 2500,
        origin: 'legacy_import', sourceId: 'legacy-python-export-v1',
        flags: ['amount_direction_unclear'], reviewStatus: 'pending',
      })
    }
    if (kind === 5) {
      // 4b. Historical migrated record without directionEvidence (undefined), credit with prior 'confirmed' status + unclear flag
      return nativeTransaction(occurrence, {
        ...base, bank: 'icbc', cardLast4: '8899', type: 'payment', direction: 'credit',
        transactionAmountMinor: 1800, settlementAmountMinor: -1800,
        origin: 'legacy_import', sourceId: 'legacy-unified-bill-v1',
        flags: ['amount_direction_unclear', 'suspected_duplicate'], reviewStatus: 'confirmed',
      })
    }
    if (kind === 6) {
      // 4c. Missing bank direction marker (ICBC style), stored debit
      return nativeTransaction(occurrence, {
        ...base, bank: 'icbc', cardLast4: '0012', direction: 'debit',
        transactionAmountMinor: 2200, settlementAmountMinor: 2200,
        directionEvidence: { kind: 'missing', detail: '合成工商银行正数缺少借贷标记' },
        flags: ['amount_direction_unclear'], reviewStatus: 'pending',
      })
    }
    if (kind === 7) {
      // 5a. BOC dual-column row with stored direction 'debit' -> selects debit_column (15200)
      return nativeTransaction(occurrence, {
        ...base, bank: 'boc', cardLast4: '0012', direction: 'debit',
        transactionAmountMinor: 15200, settlementAmountMinor: 15200,
        bankColumnAmounts: structuredClone(BOC_DUAL_COLUMNS),
        directionEvidence: { kind: 'missing', detail: '中国银行同一行同时出现借记和贷记金额列，无法确定唯一方向' },
        flags: ['amount_direction_unclear', 'suspected_duplicate'], reviewStatus: 'pending',
      })
    }
    if (kind === 8) {
      // 5b. BOC dual-column row with stored direction 'credit' -> selects credit_column (-1234)
      return nativeTransaction(occurrence, {
        ...base, bank: 'boc', cardLast4: '0012', type: 'refund', direction: 'credit',
        transactionAmountMinor: 15200, settlementAmountMinor: 15200,
        bankColumnAmounts: structuredClone(BOC_DUAL_COLUMNS),
        directionEvidence: { kind: 'missing', detail: '中国银行同一行同时出现借记和贷记金额列，无法确定唯一方向' },
        flags: ['amount_direction_unclear'], reviewStatus: 'pending',
      })
    }
    // kind === 9: Informational installment original with postingExclusion (must never double-post)
    if (index === 9) {
      return nativeTransaction(occurrence, {
        ...base, bank: 'bocom', cardLast4: '0012', type: 'installment_original', direction: 'debit',
        transactionAmountMinor: -90000, settlementAmountMinor: 90000,
        directionEvidence: { kind: 'bank', detail: '合成交通银行消费分区' },
        postingExclusion: { source: 'bocom_plan', detail: '合成账单分期计划原始本金' },
        flags: ['amount_direction_unclear'], reviewStatus: 'pending',
      })
    }
    // Remaining kind === 9 rows: ordinary positive debit with suspected_duplicate
    return nativeTransaction(occurrence, {
      ...base, bank: 'bocom', cardLast4: '0012', direction: 'debit',
      transactionAmountMinor: 1500, settlementAmountMinor: 1500,
      directionEvidence: { kind: 'bank', detail: '合成借记列' },
      flags: ['suspected_duplicate'], reviewStatus: 'pending',
    })
  })

  const okControl = nativeTransaction(count + 1, {
    statementId: firstId, bank: 'boc', cardLast4: '0012',
    transactionDate: '2024-01-12', postingDate: '2024-01-13',
    transactionCurrency: 'CNY', settlementCurrency: 'CNY',
    transactionAmountMinor: 500, settlementAmountMinor: 500,
    direction: 'debit', directionEvidence: { kind: 'bank', detail: '合成正常借记' },
    postingExclusion: null, flags: [], reviewStatus: 'ok',
    description: 'Synthetic normal control', rawDescription: 'Synthetic normal control',
    rawText: '2024-01-12 | Synthetic normal control | 5.00',
  })
  const rejectedControl = nativeTransaction(count + 2, {
    statementId: secondId, bank: 'abc', cardLast4: '8899',
    transactionDate: '2024-02-12', postingDate: '2024-02-13',
    transactionCurrency: 'CNY', settlementCurrency: 'CNY',
    transactionAmountMinor: 9999, settlementAmountMinor: 9999,
    direction: 'debit', postingExclusion: null, flags: ['date_missing'], reviewStatus: 'rejected',
    description: 'Synthetic rejected control', rawDescription: 'Synthetic rejected control',
    rawText: '2024-02-12 | Synthetic rejected control | 99.99',
  })

  const allTransactions = [...pendingRows, okControl, rejectedControl]

  function expectedEffectiveMinor(tx: Transaction): number {
    if (tx.reviewStatus === 'rejected' || tx.postingExclusion) return 0
    if (tx.bankColumnAmounts) {
      return tx.direction === 'debit' ? tx.bankColumnAmounts.debit.amountMinor : -tx.bankColumnAmounts.credit.amountMinor
    }
    return Math.abs(tx.settlementAmountMinor) * (tx.direction === 'credit' ? -1 : 1)
  }

  function buildBalancedStatement(baseStmt: Statement, id: string, bank: Statement['bank'], cardLast4: string, cycleStart: string, cycleEnd: string): Statement {
    const rows = allTransactions.filter(tx => tx.statementId === id)
    let newDebitMinor = 0
    let newCreditMinor = 0
    for (const tx of rows) {
      const amount = expectedEffectiveMinor(tx)
      if (amount > 0) newDebitMinor += amount
      else if (amount < 0) newCreditMinor += -amount
    }
    const previousBalanceMinor = 100000
    const currentBalanceMinor = previousBalanceMinor + newDebitMinor - newCreditMinor
    const raw: Statement = {
      ...baseStmt,
      id,
      statementKey: id,
      bank,
      cardLast4,
      cycleStart,
      cycleEnd,
      summary: {
        ...baseStmt.summary,
        previousBalanceMinor,
        newDebitMinor,
        newCreditMinor,
        chargeMinor: 0,
        interestMinor: 0,
        currentBalanceMinor,
        components: [{ label: '本期应还', minor: currentBalanceMinor, currency: 'CNY' }],
      },
      status: 'needs_review',
    }
    return deriveStatementState(raw, rows)
  }

  const statements: Statement[] = [
    buildBalancedStatement(firstIngest.statement!, firstId, 'boc', '0012', '2024-01-01', '2024-01-31'),
    buildBalancedStatement(secondIngest.statement!, secondId, 'abc', '8899', '2024-02-01', '2024-02-29'),
  ]
  const imports = [
    { ...firstIngest.record, id: 'import-mixed-1', fileHash: 'hash-mixed-1', statementId: firstId, bank: 'boc' as const, detectedBank: 'boc' as const, cardLast4: '0012' },
    { ...secondIngest.record, id: 'import-mixed-2', fileHash: 'hash-mixed-2', statementId: secondId, bank: 'abc' as const, detectedBank: 'abc' as const, cardLast4: '8899' },
  ]
  const notes = [pendingRows[0]!, pendingRows[count - 1]!, okControl].map(row => ({
    transactionId: row.id,
    note: `Synthetic mixed note ${row.occurrence}`,
    updatedAt: '2024-03-01T00:00:00.000Z',
  }))

  let expectedDebitMinor = 0
  let expectedCreditMinor = 0
  let expectedPostedCount = 0
  for (const tx of allTransactions) {
    if (tx.reviewStatus === 'rejected' || tx.postingExclusion) continue
    expectedPostedCount += 1
    const eff = expectedEffectiveMinor(tx)
    if (eff >= 0) expectedDebitMinor += eff
    else expectedCreditMinor += -eff
  }

  return {
    statements,
    transactions: allTransactions,
    pendingIds: pendingRows.map(tx => tx.id),
    imports,
    notes,
    expectedTotals: {
      billingDebitMinor: expectedDebitMinor,
      billingCreditMinor: expectedCreditMinor,
      netMinor: expectedDebitMinor - expectedCreditMinor,
      transactionCount: expectedPostedCount,
    },
  }
}
