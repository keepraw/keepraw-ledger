import { describe, expect, it, vi } from 'vitest'
import { sortTransactions } from '../src/ui/pages/TransactionsPage'
import { TRANSACTION_TYPES, type Transaction } from '../src/core/types'
import { ingestSynthetic } from './fixtures/identity'

const base = ingestSynthetic(['sort workload']).transactions[0]!
const makeRows = (count: number, descriptions: string[]): Transaction[] => Array.from({ length: count }, (_, index) => ({
  ...base, id: `row-${index}`, description: descriptions[(index * 13) % descriptions.length]!,
  transactionDate: index % 19 ? `2025-01-${String(index % 28 + 1).padStart(2, '0')}` : null,
}))
const collator = new Intl.Collator()
const historical = (rows: Transaction[], direction: number) => [...rows].sort((a, b) => a.description === b.description
  ? (a.transactionDate ?? '').localeCompare(b.transactionDate ?? '')
  : collator.compare(a.description, b.description) * direction)

describe('AUD-002 repeated text sorting', () => {
  it('bounds expensive collation by distinct descriptions, rather than ledger size', () => {
    const descriptions = Array.from({ length: 32 }, (_, index) => `消费 商户 ${index}`)
    const rows = makeRows(18000, descriptions)
    // Capture an independent oracle before instrumenting production collation.
    const expected = historical(rows, 1).map(tx => tx.id)
    const getter = Object.getOwnPropertyDescriptor(Intl.Collator.prototype, 'compare')!.get!
    let comparisons = 0
    const spy = vi.spyOn(Intl.Collator.prototype, 'compare', 'get').mockImplementation(function (this: Intl.Collator) {
      const compare = getter.call(this) as (left: string, right: string) => number
      return (left: string, right: string) => { comparisons++; return compare(left, right) }
    })
    let sorted: Transaction[]
    try { sorted = sortTransactions(rows, 'description', 'asc') } finally { spy.mockRestore() }
    expect(sorted.map(tx => tx.id)).toEqual(expected)
    expect(sorted).not.toBe(rows)
    const originals = new Set(rows)
    expect(sorted.every(tx => originals.has(tx))).toBe(true)
    // 32 distinct strings need far fewer than 512 comparisons; no wall-clock flakiness.
    expect(comparisons).toBeLessThan(512)
  })

  it('preserves collation-equivalent strings, exact-string date ties, null dates and stable identity in both paths', () => {
    const descriptions = ['Café', 'Cafe\u0301', '咖啡', '咖啡 10', 'coffee', 'COFFEE', '', '😀']
    for (const count of [24, 18000]) {
      const rows = makeRows(count, descriptions), original = rows.map(tx => tx.id)
      for (const direction of [1, -1]) {
        expect(sortTransactions(rows, 'description', direction === 1 ? 'asc' : 'desc').map(tx => tx.id))
          .toEqual(historical(rows, direction).map(tx => tx.id))
      }
      expect(rows.map(tx => tx.id)).toEqual(original)
    }
  })

  it('groups repeated transaction types without changing stable date ties', () => {
    const rows = makeRows(600, ['合成商户']).map((tx, index) => ({ ...tx, type: TRANSACTION_TYPES[index % TRANSACTION_TYPES.length]! }))
    for (const direction of [1, -1]) {
      const expected = [...rows].sort((a, b) => a.type === b.type
        ? (a.transactionDate ?? '').localeCompare(b.transactionDate ?? '') : collator.compare(a.type, b.type) * direction)
      expect(sortTransactions(rows, 'type', direction === 1 ? 'asc' : 'desc')).toEqual(expected)
    }
  })

  it('keeps null text last even in the grouped path, independently of direction', () => {
    const rows = makeRows(600, ['合成商户', 'Coffee']).map((tx, index) => index % 7 ? tx : { ...tx, description: null as unknown as string })
    for (const direction of [1, -1]) {
      const expected = [...rows].sort((a, b) => {
        if (a.description === b.description) return (a.transactionDate ?? '').localeCompare(b.transactionDate ?? '')
        if (a.description === null) return 1
        if (b.description === null) return -1
        return collator.compare(a.description, b.description) * direction
      })
      expect(sortTransactions(rows, 'description', direction === 1 ? 'asc' : 'desc')).toEqual(expected)
    }
  })

  it('keeps the direct comparator correct when descriptions are mostly unique', () => {
    const rows = makeRows(600, Array.from({ length: 600 }, (_, index) => `商户 ${index}`))
    expect(sortTransactions(rows, 'description', 'desc')).toEqual(historical(rows, -1))
  })
})
