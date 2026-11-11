import type { IsoDate } from '../core/dates'
import type { BankId, Category, Direction, TransactionType } from '../core/types'

/**
 * Legacy Import adapters.
 *
 * A Legacy Adapter migrates *structured history from a known previous system*
 * into the current standard Transaction. It is deliberately NOT a generic
 * spreadsheet importer: an upload that does not match a known adapter schema
 * is rejected instead of guessed.
 *
 * Adapters live here, never in `src/parsers/`. Bank parsers turn bank
 * statements into data; adapters turn old-system data into data.
 */

/** Historical formats supported. Each one has an explicit adapter; unknown sheets are rejected. */
export const LEGACY_PYTHON_EXPORT_V1 = 'legacy-python-export-v1' as const
export const LEGACY_KEEPRAW_EXPORT_V1 = 'legacy-keepraw-export-v1' as const
export const LEGACY_UNIFIED_BILL_V1 = 'legacy-unified-bill-v1' as const
export const LEGACY_KEEPRAW_LEDGER_EXPORT_V1 = 'legacy-keepraw-ledger-export-v1' as const
export type LegacyFormatId = typeof LEGACY_PYTHON_EXPORT_V1 | typeof LEGACY_KEEPRAW_EXPORT_V1 | typeof LEGACY_UNIFIED_BILL_V1 | typeof LEGACY_KEEPRAW_LEDGER_EXPORT_V1

export const LEGACY_FORMAT_NAME: Record<LegacyFormatId, string> = {
  [LEGACY_PYTHON_EXPORT_V1]: '标准字段历史格式',
  [LEGACY_KEEPRAW_EXPORT_V1]: 'Keepraw History Export',
  [LEGACY_UNIFIED_BILL_V1]: '统一账单历史格式',
  [LEGACY_KEEPRAW_LEDGER_EXPORT_V1]: 'Keepraw-Ledger 原生交易导出',
}

export interface LegacyFileMeta {
  fileName: string
  fileSize: number
  fileHash: string
}

export type LegacyAnomalyKind = 'missing_field' | 'date_unparseable' | 'amount_unparseable' | 'invalid_field' | 'identity_conflict'

export interface LegacyAnomaly {
  /** 1-based Excel row number (header is row 1). */
  rowNumber: number
  kind: LegacyAnomalyKind
  detail: string
}

/** One validated migration row in standard units, optionally carrying native identity. */
export interface NormalizedLegacyRow {
  bank: BankId
  cardLast4: string
  transactionDate: IsoDate | null
  postingDate: IsoDate | null
  description: string
  rawDescription: string
  transactionCurrency: string
  transactionAmountMinor: number
  settlementCurrency: string
  settlementAmountMinor: number
  type: TransactionType
  direction: Direction
  category: Category
  confidence: number
  flags: import('../core/types').ReviewFlag[]
  rawText: string
  /** 1-based Excel row number. Provenance only, never used for identity. */
  sourceRow: number
  cycleStart: IsoDate | null
  cycleEnd: IsoDate | null
  /** Validated native identity and the metadata actually present in the XLSX. */
  native?: Pick<import('../core/types').Transaction, 'id' | 'fingerprint' | 'occurrence' | 'reviewStatus' | 'sourceFileName' | 'sourceFileHash' | 'sourcePage'>
}

export interface LegacyPreviewStats {
  formatId: LegacyFormatId
  formatName: string
  /** Non-empty data rows seen in the sheet. */
  totalRows: number
  validRows: number
  anomalyRows: number
  anomaliesByKind: Record<'missing_field' | 'date_unparseable' | 'amount_unparseable', number> &
    Partial<Record<'invalid_field' | 'identity_conflict', number>>
  dateRange: { min: IsoDate; max: IsoDate } | null
  banks: BankId[]
  /** Rows safely recognized as already stored (would be skipped). */
  alreadyStored: number
  /** True when this exact file (SHA-256) was imported before. */
  duplicateFile: boolean
  cards?: string[]
}

export interface LegacyPreview {
  meta: LegacyFileMeta
  stats: LegacyPreviewStats
  /** Valid rows with stable ids assigned (deterministic per batch). */
  rows: Array<NormalizedLegacyRow & { id: string; fingerprint: string; occurrence: number }>
  anomalies: LegacyAnomaly[]
  /** Source-row date warnings and native reconstruction limitations. */
  reviewIssues?: Array<{ rowNumber: number; detail: string }>
  /** Read-only cross-source observations. Never an ID migration or merge plan. */
  migrationAudit?: import('../core/migrationAudit').MigrationAudit
  identityWarnings?: Array<{ rowNumber: number; detail: string; blocking: boolean }>
}
