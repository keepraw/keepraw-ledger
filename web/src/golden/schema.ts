/**
 * Golden fixture schema v1 (Task A-3.4).
 *
 * Types only. Mirrors `src/ccparser/golden.py::GOLDEN_SCHEMA`.
 * Nothing here may change parser behavior.
 */

export const GOLDEN_SCHEMA = 'golden/v1' as const
export const GOLDEN_GENERATOR_WEB = 'keepraw-golden-ts/1.1.0' as const

export type Direction = 'debit' | 'credit'

export interface NormalizedTransaction {
  bank: string
  cardLast4: string
  transactionDate: string
  postingDate: string
  /** Signed integer minor units, settlement leg. Positive = expense. */
  amountMinor: number
  currency: string
  direction: Direction
  /** P1: cleaning rules may differ across pipelines. */
  description: string
  normalizedDescription: string
  /** Debug only: never part of the gate. */
  rawText: string
  /** Debug only: never part of the gate. */
  sourcePosition: Record<string, number | string | null>
  /** Native identity (python transaction_id / web fingerprint). */
  nativeId: string
  statementKey: string
}

export interface GoldenStatement {
  schema: typeof GOLDEN_SCHEMA
  origin: 'python' | 'web'
  generator: string
  bank: string
  bankNative: string
  cardLast4: string
  cycleStart: string | null
  cycleEnd: string | null
  parserName: string
  desensitized: boolean
  nativeIds: Record<string, string>
  transactionCount: number
  transactions: NormalizedTransaction[]
}

export type Severity = 'BLOCKING' | 'WARNING' | 'INFO'

export interface DiffFinding {
  severity: Severity
  rule: string
  pythonIndex?: number
  webIndex?: number
  side?: string
  field?: string
  detail?: string
  python?: unknown
  web?: unknown
}

export interface IdentityEntry {
  businessKey: string
  pythonNativeId: string | null
  webNativeId: string | null
  match: 'full' | 'partial' | 'unpaired'
  /** Observation only: the golden layer never merges. */
  merged: false
}

export interface DiffReport {
  schema: typeof GOLDEN_SCHEMA
  generator: string
  python: { transactionCount: number }
  web: { transactionCount: number }
  pairedRows: number
  verdict: 'BLOCKING' | 'WARNING' | 'PASS'
  severityCounts: Record<Severity, number>
  findings: DiffFinding[]
  identity: {
    pythonAlgo: string
    webAlgo: string
    compatible: boolean
    note: string
    merged: false
    entries: IdentityEntry[]
  }
}
