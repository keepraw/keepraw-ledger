import { ingestSynthetic } from './identity'
import { nativeTransaction } from './nativeLedger'
import type { Transaction } from '../../src/core/types'

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
