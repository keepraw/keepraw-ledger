import Dexie, { type Table } from 'dexie'
import type { AppSettings, ImportRecord, Statement, Transaction } from '../core/types'

export interface SettingRow {
  key: string
  value: unknown
}

export interface ReviewNoteRow {
  transactionId: string
  note: string
  updatedAt: string
}

/**
 * Original evidence file kept for one import.
 *
 * Keyed by SHA-256 of the raw bytes so identical re-imports deduplicate
 * automatically. Only files the browser could actually read are stored;
 * every historical import without a row here is `missing` in the manifest.
 *
 * Binary bytes are stored as ArrayBuffer (not Blob): it survives the
 * structured clone in real IndexedDB and in fake-indexeddb/jsdom alike.
 * A Blob is only materialised transiently when building the ZIP.
 */
export interface AttachmentRow {
  /** SHA-256 hex of the raw file bytes. Primary key. */
  fileHash: string
  fileName: string
  mimeType: string
  size: number
  data: ArrayBuffer
  importId: string
  parserId: string
  importedAt: string
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'system',
  demoMode: false,
  locale: 'zh-CN',
}

/**
 * Browser-local storage. Nothing here ever leaves the device: there is no network
 * call anywhere in this application.
 */
export class BillDatabase extends Dexie {
  statements!: Table<Statement, string>
  transactions!: Table<Transaction, string>
  imports!: Table<ImportRecord, string>
  settings!: Table<SettingRow, string>
  reviewNotes!: Table<ReviewNoteRow, string>
  attachments!: Table<AttachmentRow, string>

  constructor(name = 'credit-bill-manager') {
    super(name)
    this.version(1).stores({
      statements: 'id, bank, cardLast4, cycleEnd, status, isDemo',
      transactions:
        'id, statementId, bank, transactionDate, postingDate, type, category, reviewStatus, isDemo, fingerprint, [bank+transactionDate]',
      imports: 'id, fileHash, importedAt, status, isDemo',
      settings: 'key',
      reviewNotes: 'transactionId',
    })
    // v2 adds evidence-file storage without touching existing stores.
    this.version(2).stores({
      statements: 'id, bank, cardLast4, cycleEnd, status, isDemo',
      transactions:
        'id, statementId, bank, transactionDate, postingDate, type, category, reviewStatus, isDemo, fingerprint, [bank+transactionDate]',
      imports: 'id, fileHash, importedAt, status, isDemo',
      settings: 'key',
      reviewNotes: 'transactionId',
      attachments: 'fileHash, importId, importedAt',
    })
    // v3 removes unused secondary indexes only. Dexie's versionchange
    // transaction preserves every store, primary key and stored object.
    this.version(3).stores({
      statements: 'id',
      transactions: 'id, statementId',
      imports: 'id',
      settings: 'key',
      reviewNotes: 'transactionId',
      attachments: 'fileHash',
    })
    // One atomic versionchange transaction; identity and all other data stay exact.
    this.version(4).stores({}).upgrade(async transaction => {
      await transaction.table('transactions').toCollection().modify((row: { merchant?: unknown }) => {
        delete row.merchant
      })
    })
  }
}

export const db = new BillDatabase()

export async function loadSettings(): Promise<AppSettings> {
  const row = await db.settings.get('app')
  return { ...DEFAULT_SETTINGS, ...((row?.value as Partial<AppSettings>) ?? {}) }
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  await db.settings.put({ key: 'app', value: settings })
}