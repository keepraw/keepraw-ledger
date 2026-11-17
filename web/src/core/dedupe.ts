import type { ReviewFlag, Transaction } from './types'
import { auditMigrationRows } from './migrationAudit'

/**
 * Duplicate handling.
 *
 * Four situations that must NOT be conflated:
 *
 *   1. the same file imported twice          -> the file hash short-circuits everything
 *   2. the same statement from another file  -> per-transaction fingerprint merge
 *   3. genuinely repeated purchases          -> the occurrence index keeps each one
 *   4. same day/amount but different wording -> flagged for review, never merged
 *
 * Nothing is ever silently deleted.
 */

export interface OccurrenceAssignment {
  fingerprint: string
  occurrence: number
}

/**
 * Identical rows inside one statement keep their own identity: the first keeps the
 * bare fingerprint, the second gets suffix `#2`, and so on.
 */
export function assignOccurrences(fingerprints: string[]): OccurrenceAssignment[] {
  const counters = new Map<string, number>()
  return fingerprints.map((fingerprint) => {
    const occurrence = (counters.get(fingerprint) ?? 0) + 1
    counters.set(fingerprint, occurrence)
    return { fingerprint, occurrence }
  })
}

export function transactionId(fingerprint: string, occurrence: number): string {
  return occurrence <= 1 ? fingerprint : `${fingerprint}#${occurrence}`
}

export function parseTransactionId(id: string): { fingerprint: string; occurrence: number } {
  const match = /^(.*)#(\d+)$/.exec(id)
  if (!match) return { fingerprint: id, occurrence: 1 }
  return { fingerprint: match[1]!, occurrence: Number(match[2]) }
}

export interface DuplicateOutcome {
  /** Incoming transaction ids already present in storage. */
  duplicateIds: Set<string>
  /** Incoming transaction ids flagged as *likely* duplicates with a differing description. */
  suspectedDuplicates: Map<string, string[]>
}

interface FingerprintView {
  fingerprint: string
  bank: string
  cardLast4: string
  transactionDate: string | null
  settlementAmountMinor: number
  type: string
  description: string
  postingDate?: string | null
  settlementCurrency?: string
  transactionCurrency?: string
  transactionAmountMinor?: number
  direction?: string
}

function exactKey(row: FingerprintView): string {
  // Normalization is deliberately lossy. Raw cleaned descriptions must also
  // agree before a stored occurrence can consume an incoming occurrence.
  return JSON.stringify([
    row.fingerprint, row.description, row.bank, row.cardLast4,
    row.transactionDate, row.postingDate, row.settlementCurrency,
    row.settlementAmountMinor, row.type, row.transactionCurrency,
    row.transactionAmountMinor, row.direction,
  ])
}

/** Reuse matched stored IDs; allocate free occurrence slots for unmatched rows. */
export function assignStoredOccurrences<T extends FingerprintView & { id: string; occurrence: number }>(
  incoming: T[],
  existing: Array<FingerprintView & { id: string; occurrence: number }>,
): T[] {
  const matches = new Map<string, Array<{ id: string; occurrence: number }>>()
  const cursors = new Map<string, number>()
  const used = new Set(existing.map((row) => row.id))
  const maxima = new Map<string, number>()
  for (const row of existing) {
    const key = exactKey(row)
    const bucket = matches.get(key) ?? []
    bucket.push(row)
    matches.set(key, bucket)
    maxima.set(row.fingerprint, Math.max(maxima.get(row.fingerprint) ?? 0, row.occurrence))
  }
  return incoming.map((row) => {
    const key = exactKey(row)
    const cursor = cursors.get(key) ?? 0
    cursors.set(key, cursor + 1)
    const match = matches.get(key)?.[cursor]
    if (match) return { ...row, id: match.id, occurrence: match.occurrence }
    let occurrence = row.occurrence
    if (used.has(transactionId(row.fingerprint, occurrence))) {
      occurrence = (maxima.get(row.fingerprint) ?? 0) + 1
      while (used.has(transactionId(row.fingerprint, occurrence))) occurrence += 1
    }
    const id = transactionId(row.fingerprint, occurrence)
    used.add(id)
    maxima.set(row.fingerprint, Math.max(maxima.get(row.fingerprint) ?? 0, occurrence))
    return { ...row, id, occurrence }
  })
}

/**
 * Compare freshly parsed transactions with what is already stored.
 *
 * Exact identity is `fingerprint + occurrence`. A looser key (bank/card/date/amount/
 * type) is only used to raise `suspected_duplicate` for human review.
 */
export function detectDuplicates(
  incoming: Array<{ id: string } & FingerprintView>,
  existing: FingerprintView[],
): DuplicateOutcome {
  const duplicateIds = new Set<string>()
  const suspectedDuplicates = new Map<string, string[]>()

  const exact = new Map<string, number>()
  for (const row of existing) {
    const key = exactKey(row)
    exact.set(key, (exact.get(key) ?? 0) + 1)
  }

  const loose = new Map<string, Set<string>>()
  for (const row of existing) {
    const key = looseKey(row)
    const bucket = loose.get(key) ?? new Set<string>()
    bucket.add(row.description)
    loose.set(key, bucket)
  }

  for (const row of incoming) {
    const key = exactKey(row)
    const remaining = exact.get(key) ?? 0
    if (remaining > 0) {
      exact.set(key, remaining - 1)
      duplicateIds.add(row.id)
      continue
    }

    const bucket = loose.get(looseKey(row)) ?? new Set<string>()
    // Bounded examples keep review detection linear even for a huge same-day
    // bucket. Every non-identical row is still flagged; nothing is merged.
    const others: string[] = []
    for (const description of bucket) {
      if (description !== row.description) others.push(description)
      if (others.length === 3) break
    }
    if (others.length > 0) {
      suspectedDuplicates.set(row.id, [...others, row.description])
    }
    bucket.add(row.description)
    loose.set(looseKey(row), bucket)
  }

  // Classification, posting-date and original-money disagreements used to be
  // invisible when descriptions agreed. Observe them without broadening exact
  // matching, consuming extra occurrences or touching existing records.
  const audit = auditMigrationRows(incoming, existing)
  for (const observation of audit.observations) {
    if (observation.incomingId === null || duplicateIds.has(observation.incomingId) || observation.status === 'unmatched') continue
    suspectedDuplicates.set(observation.incomingId, observation.candidateIds.length > 0 ? observation.candidateIds : ['需复核业务字段'])
  }

  return { duplicateIds, suspectedDuplicates }
}

/**
 * Financial candidate key, independent of legacy business-type metadata.
 * Different descriptions remain review candidates, never automatic merges.
 */
function looseKey(row: FingerprintView): string {
  return JSON.stringify([row.bank, row.cardLast4, row.transactionDate ?? '', row.settlementCurrency,
    row.settlementAmountMinor, row.direction])
}

/** Transactions of one statement that share bank/card/date/amount but differ in text. */
export function findSuspectedDuplicateGroups(transactions: Transaction[]): Map<string, string[]> {
  const groups = new Map<string, Transaction[]>()
  for (const tx of transactions) {
    const key = looseKey(tx)
    const bucket = groups.get(key) ?? []
    bucket.push(tx)
    groups.set(key, bucket)
  }

  const result = new Map<string, string[]>()
  for (const [, bucket] of groups) {
    if (bucket.length < 2) continue
    const distinct = new Set(bucket.map((tx) => tx.description))
    if (distinct.size < 2) continue
    for (const tx of bucket) {
      result.set(
        tx.id,
        bucket.filter((other) => other.id !== tx.id).map((other) => other.description),
      )
    }
  }
  return result
}

export function addFlag(transaction: Transaction, flag: ReviewFlag): Transaction {
  if (transaction.flags.includes(flag)) return transaction
  return { ...transaction, flags: [...transaction.flags, flag] }
}
