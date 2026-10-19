import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from '../db/db'
import {
  clearAllData,
  buildDataBackupBlob,
  getArchiveStatus,
  getReviewNotes,
  importBackup,
  mimeTypeForFile,
  persistImportResults,
  persistLegacyImport,
  purgeDemoRows,
  ensureDemoRowsPurged,
  readSnapshot,
  readImportSnapshot,
  markImportEvidenceMissing,
  saveOriginalFile,
  setReviewNote,
  patchTransactionWithStatements as persistTransactionPatch,
  recomputeStatement as persistStatementRecomputation,
  updateTransactions,
  validateBackup,
  type ArchiveStatus,
  type Snapshot,
} from '../db/repository'
import { getDemoSnapshot } from '../demo/demoStore'
import { buildFullBackupZip, restoreFullBackupZip } from '../backup/archive'
import {
  hashLegacyFile,
  planLegacyImport,
  previewLegacyWorkbook,
  type LegacyExisting,
} from '../importers/legacyImport'
import type { LegacyPreview } from '../importers/types'
import { ingestParsedStatement, failedImportRecord, unsupportedRecord, type IngestMeta, type IngestResult } from '../core/ingest'
import type { ParsedStatement } from '../parsers/types'
import { LedgerConflictError, readLedgerRevision, subscribeLedgerChanges } from '../db/ledgerRevision'
import { assertSourceFileSize, buildSourceDocument, MAX_IMPORT_BATCH_BYTES, sha256Hex } from '../parsers/extract'
import { detectParser, parseDocument, UnsupportedFileError } from '../parsers/registry'
import type { AppSettings, ImportRecord, Statement, Transaction } from '../core/types'
import { triggerDownload } from '../export/tabular'
import { downloadLedgerArchive, ledgerArchiveFileName } from '../export/ledgerArchive'
import { readJsonBackup } from '../backup/json'

export interface ImportProgress {
  fileName: string
  index: number
  total: number
  phase: string
}

export interface AppState extends Snapshot {
  ready: boolean
  settings: AppSettings
  notes: Record<string, string>
  progress: ImportProgress | null
  /** True when Demo Mode is on: real rows are hidden and imports are blocked. */
  demoMode: boolean
}

interface AppApi {
  state: AppState
  refresh: () => Promise<void>
  setSettings: (patch: Partial<AppSettings>) => Promise<void>
  importFiles: (files: File[]) => Promise<ImportRecord[]>
  previewLegacyImport: (file: File) => Promise<LegacyPreview>
  confirmLegacyImport: (preview: LegacyPreview) => Promise<ImportRecord>
  loadDemoData: () => Promise<void>
  updateTransaction: (patch: Partial<Transaction> & { id: string }) => Promise<void>
  recomputeStatement: (statementId: string) => Promise<void>
  saveNote: (transactionId: string, note: string) => Promise<void>
  backup: () => Promise<void>
  backupData: () => Promise<void>
  backupFull: () => Promise<{ warning: string | null }>
  exportLedgerXlsx: () => Promise<void>
  restore: (file: File) => Promise<{ ok: boolean; message: string }>
  archiveStatus: () => Promise<ArchiveStatus>
  clearData: (includeDemo: boolean) => Promise<void>
  visibleStatements: Statement[]
  visibleTransactions: Transaction[]
  visibleImports: ImportRecord[]
}

const AppContext = createContext<AppApi | null>(null)

const EMPTY: Snapshot = { statements: [], transactions: [], imports: [] }

function mergeStatementStates(current: Statement[], updated: Statement[]): Statement[] {
  const byId = new Map(updated.map(row => [row.id, row]))
  const next = current.map(row => {
    const replacement = byId.get(row.id)
    return replacement && JSON.stringify(replacement) !== JSON.stringify(row) ? replacement : row
  })
  return next.some((row, index) => row !== current[index]) ? next : current
}

interface ImportBatchResult extends IngestResult {
  evidence?: { buffer: ArrayBuffer; fileHash: string; fileName: string; mimeType: string }
  parsed?: ParsedStatement
  meta?: IngestMeta
}

function advanceImportSnapshot(current: Snapshot, result: IngestResult): Snapshot {
  if (!result.statement) return { ...current, imports: current.imports.filter(row => row.id !== result.record.id).concat(result.record) }
  return {
    statements: current.statements.filter(row => row.id !== result.statement!.id).concat(result.statement),
    transactions: current.transactions.filter(row => row.statementId !== result.statement!.id).concat(result.transactions),
    imports: current.imports.filter(row => row.id !== result.record.id).concat(result.record),
  }
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<Snapshot>(EMPTY)
  const [settings, setSettingsState] = useState<AppSettings>(DEFAULT_SETTINGS)
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [ready, setReady] = useState(false)
  const [progress, setProgress] = useState<ImportProgress | null>(null)
  const initialised = useRef(false)
  const committedPreferences = useRef<AppSettings>(DEFAULT_SETTINGS)
  const pendingPreferences = useRef(0)

  // Serialize state-changing operations with refreshes. A delayed read cannot
  // overwrite a later successful edit; rejected writes do not poison the queue.
  const pending = useRef<Promise<unknown>>(Promise.resolve())
  const enqueue = useCallback(<T,>(operation: () => Promise<T>): Promise<T> => {
    const result = pending.current.then(operation)
    pending.current = result.catch(() => undefined)
    return result
  }, [])

  const reload = useCallback(async (firstVisit = false) => {
    const [next, nextNotes, storedSettings] = await Promise.all([readSnapshot(), getReviewNotes(), loadSettings()])
    const nextSettings = firstVisit && next.imports.length === 0 ? { ...DEFAULT_SETTINGS, demoMode: true } : storedSettings
    if (nextSettings !== storedSettings) await saveSettings(nextSettings)
    setSnapshot(next)
    setNotes(nextNotes)
    committedPreferences.current = nextSettings
    if (pendingPreferences.current === 0) setSettingsState(nextSettings)
  }, [])

  const refresh = useCallback(() => enqueue(() => reload()), [enqueue, reload])

  useEffect(() => {
    const unsubscribe = subscribeLedgerChanges(() => { void refresh() })
    const onFocus = () => { void refresh() }
    window.addEventListener('focus', onFocus)
    return () => { unsubscribe(); window.removeEventListener('focus', onFocus) }
  }, [refresh])

  useEffect(() => {
    if (initialised.current) return
    initialised.current = true
    void enqueue(async () => {
      await ensureDemoRowsPurged()
      // First visits still use the in-memory demo; load the real snapshot once.
      await reload(true)
      setReady(true)
    })
  }, [enqueue, reload])

  const setSettings = useCallback((patch: Partial<AppSettings>) => {
    const ownedPatch = { ...patch }
    // Preserve immediate controlled-input feedback for preferences. Imports
    // check committed settings in the queue; failed saves roll the preview back.
    pendingPreferences.current++
    setSettingsState(current => ({ ...current, ...ownedPatch }))
    return enqueue(async () => {
      try {
        const current = await loadSettings()
        committedPreferences.current = current
        const next = { ...current, ...ownedPatch }
        await saveSettings(next)
        committedPreferences.current = next
      } finally {
        pendingPreferences.current--
        if (pendingPreferences.current === 0) setSettingsState(committedPreferences.current)
      }
    })
  }, [enqueue])

  const importFiles = useCallback(
    (files: File[]): Promise<ImportRecord[]> => enqueue(async () => {
      if ((await loadSettings()).demoMode) {
        throw new Error('演示模式下无法导入真实账单，请先在设置中关闭演示模式。')
      }
      if (files.reduce((total, file) => total + file.size, 0) > MAX_IMPORT_BATCH_BYTES) {
        throw new Error('本批文件超过 100 MiB 预算，未读取或保存任何文件。请分批导入。')
      }
      let results: ImportBatchResult[] = []
      const initial = await readImportSnapshot()
      let planningRevision = initial.revision
      let current = initial.snapshot

      for (const [index, file] of files.entries()) {
        setProgress({ fileName: file.name, index, total: files.length, phase: '读取文件' })
        const meta = { fileName: file.name, fileSize: file.size, sourceType: 'unknown' as const }
        let evidence: ImportBatchResult['evidence']
        try {
          assertSourceFileSize(file.size)
          const buffer = await readFileWithRetry(file)
          assertSourceFileSize(buffer.byteLength)
          setProgress({ fileName: file.name, index, total: files.length, phase: '计算 SHA-256' })
          const fileHash = await sha256Hex(buffer)
          // Bind evidence before parsing: extraction failures must retain the
          // same bytes that were hashed, without a second, potentially different read.
          evidence = { buffer: buffer.slice(0), fileHash, fileName: file.name, mimeType: file.type || mimeTypeForFile(file.name) }
          setProgress({ fileName: file.name, index, total: files.length, phase: '解析内容' })
          const doc = await buildSourceDocument({ fileName: file.name, buffer, fileHash })
          const match = detectParser(doc)
          if (!match) {
            const record = unsupportedRecord(
              { ...meta, fileHash, sourceType: doc.sourceType },
              `无法识别 ${file.name} 的银行与账单格式，未识别的文件不会被当作成功导入。`,
            )
            results.push({
              record,
              statement: null,
              transactions: [],
              inserted: [],
              skippedDuplicates: [],
              evidence,
            })
            continue
          }
          setProgress({ fileName: file.name, index, total: files.length, phase: '解析账单' })
          const parsed = parseDocument(doc, match.parser)
          const result = ingestParsedStatement(
            parsed,
            { ...meta, fileHash, sourceType: doc.sourceType },
            { statements: current.statements, transactions: current.transactions, imports: current.imports },
          )
          results.push({ ...result, evidence, parsed, meta: { fileName: file.name, fileHash, fileSize: file.size, sourceType: doc.sourceType } })
          current = advanceImportSnapshot(current, result)
        } catch (error) {
          const message = describeError(error)
          const fileHash = evidence?.fileHash ?? `unavailable-${crypto.randomUUID()}`
          results.push({
            record: failedImportRecord({ ...meta, fileHash }, message),
            statement: null,
            transactions: [],
            inserted: [],
            skippedDuplicates: [],
            evidence,
          })
        }
      }

      setProgress(null)
      try {
        for (let attempt = 0; ; attempt++) {
          try { await persistImportResults(results, planningRevision); break }
          catch (error) {
            if (!(error instanceof LedgerConflictError) || error.cleared || attempt >= 2) throw error
            const fresh = await readImportSnapshot()
            if (fresh.revision.generation !== initial.revision.generation) throw new LedgerConflictError(true)
            planningRevision = fresh.revision
            current = fresh.snapshot
            results = results.map(result => {
              const next = result.parsed && result.meta ? { ...result, ...ingestParsedStatement(result.parsed, result.meta, current) } : result
              current = advanceImportSnapshot(current, next)
              return next
            })
          }
        }
      } catch (error) {
        await reload()
        throw error
      }
      // Archive raw evidence keyed by hash. Best-effort: never fails the import.
      for (const result of results) {
        const raw = result.evidence
        let retained = false
        if (raw) try {
          await saveOriginalFile({
            fileHash: raw.fileHash,
            fileName: raw.fileName,
            mimeType: raw.mimeType,
            data: raw.buffer.slice(0),
            importId: result.record.id,
            parserId: result.record.parserId,
            generation: initial.revision.generation,
          })
          retained = true
        } catch {
          // IndexedDB quota or private-mode limits must not break the import itself.
        }
        if (!retained) {
          result.record = { ...result.record, message: `${result.record.message}，原始文件未保留，可稍后重新导入。` }
          // The manifest also derives missing evidence from the attachment table,
          // even if quota prevents this optional warning from being persisted.
          try { await markImportEvidenceMissing(result.record, initial.revision.generation) } catch { /* Evidence remains missing. */ }
        }
      }
      await reload()
      if ((await readLedgerRevision()).generation !== initial.revision.generation) throw new LedgerConflictError(true)
      return results.map((result) => result.record)
    }),
    [enqueue, reload],
  )

  const loadDemoData = useCallback(() => enqueue(async () => {
    // Demo data lives in memory only: drop any legacy fictional rows, warm
    // the cache and reload the real snapshot. Nothing demo is ever written
    // to the production tables.
    await purgeDemoRows()
    getDemoSnapshot()
    await reload()
  }), [enqueue, reload])

  /**
   * Legacy history import, kept strictly separate from bank-statement imports.
   * Preview is read-only; the confirm step writes one atomic transaction.
   */
  const previewLegacyImport = useCallback(
    (file: File): Promise<LegacyPreview> => enqueue(async () => {
      if ((await loadSettings()).demoMode) {
        throw new Error('演示模式下无法导入历史数据，请先在设置中关闭演示模式。')
      }
      setProgress({ fileName: file.name, index: 0, total: 1, phase: '读取历史数据' })
      try {
        const { buffer, fileHash } = await hashLegacyFile(file)
        setProgress({ fileName: file.name, index: 0, total: 1, phase: '生成预览' })
        const snapshot = await readSnapshot()
        const existing: LegacyExisting = {
          imports: snapshot.imports,
          statements: snapshot.statements,
          transactions: snapshot.transactions,
        }
        return await previewLegacyWorkbook(
          buffer,
          { fileName: file.name, fileSize: file.size, fileHash },
          existing,
        )
      } finally {
        setProgress(null)
      }
    }),
    [enqueue],
  )

  const confirmLegacyImport = useCallback(
    (preview: LegacyPreview): Promise<ImportRecord> => enqueue(async () => {
      if ((await loadSettings()).demoMode) {
        throw new Error('演示模式下无法导入历史数据，请先在设置中关闭演示模式。')
      }
      setProgress({ fileName: preview.meta.fileName, index: 0, total: 1, phase: '写入历史数据' })
      try {
        const initial = await readImportSnapshot()
        let captured = initial
        for (let attempt = 0; ; attempt++) {
          const plan = planLegacyImport(preview, captured.snapshot)
          try {
            await persistLegacyImport(plan, captured.revision)
            await reload()
            return plan.record
          } catch (error) {
            if (!(error instanceof LedgerConflictError) || error.cleared || attempt >= 2) { await reload(); throw error }
            captured = await readImportSnapshot()
            if (captured.revision.generation !== initial.revision.generation) throw new LedgerConflictError(true)
          }
        }
      } finally {
        setProgress(null)
      }
    }),
    [enqueue, reload],
  )

  const patchTransaction = useCallback((patch: Partial<Transaction> & { id: string }) => {
    // Own caller-provided arrays before the operation waits in the queue.
    const ownedPatch = structuredClone(patch)
    return enqueue(async () => {
      const committed = await persistTransactionPatch(ownedPatch)
      if (!committed) return
      setSnapshot(current => ({ ...current,
        transactions: current.transactions.map(tx => tx.id === committed.transaction.id ? committed.transaction : tx),
        statements: mergeStatementStates(current.statements, committed.statements),
      }))
    })
  }, [enqueue])

  const recomputeStatement = useCallback((statementId: string) => enqueue(async () => {
    if ((await loadSettings()).demoMode) throw new Error('请先关闭演示模式，再重新核对真实账单。')
    const statement = await persistStatementRecomputation(statementId)
    if (statement) setSnapshot(current => ({ ...current, statements: mergeStatementStates(current.statements, [statement]) }))
  }), [enqueue])

  const saveNote = useCallback((transactionId: string, note: string) => enqueue(async () => {
    await setReviewNote(transactionId, note)
    setNotes(current => {
      const next = { ...current }
      if (note.trim()) next[transactionId] = note.trim()
      else delete next[transactionId]
      return next
    })
  }), [enqueue])

  const backupData = useCallback(() => enqueue(async () => {
    triggerDownload(
      await buildDataBackupBlob(),
      `credit-card-data-${new Date().toISOString().slice(0, 10)}.json`,
    )
  }), [enqueue])

  const backup = useCallback(async () => {
    await backupData()
  }, [backupData])

  const backupFull = useCallback((): Promise<{ warning: string | null }> => enqueue(async () => {
    const { blob, warning } = await buildFullBackupZip()
    triggerDownload(blob, `credit-card-full-backup-${new Date().toISOString().slice(0, 10)}.zip`)
    return { warning }
  }), [enqueue])

  const archiveStatus = useCallback(async (): Promise<ArchiveStatus> => getArchiveStatus(), [])

  const restore = useCallback(
    (file: File) => enqueue(async () => {
      try {
        if (file.name.toLowerCase().endsWith('.zip')) {
          const result = await restoreFullBackupZip(file)
          await reload()
          const notesPart = result.backupVersion === 2
            ? `、${result.notes} 条复核备注`
            : '。V1 备份不含独立复核备注，本地已有备注已保留'
          const base = result.backupVersion === 2
            ? `已恢复 ${result.transactions} 笔交易、${result.statements} 份账单${notesPart}、${result.files} 个原始文件。`
            : `已恢复 ${result.transactions} 笔交易、${result.statements} 份账单、${result.files} 个原始文件${notesPart}。`
          return { ok: true, message: result.warning ? `${base}${result.warning}。` : base }
        }
        const payload = await readJsonBackup(file)
        if (!validateBackup(payload)) return { ok: false, message: '文件格式不正确，不是本应用导出的备份。' }
        await importBackup(payload)
        await reload()
        if (payload.version === 2) {
          return { ok: true, message: `已恢复 ${payload.transactions.length} 笔交易、${payload.statements.length} 份账单、${payload.reviewNotes.length} 条复核备注。` }
        }
        return { ok: true, message: `已恢复 ${payload.transactions.length} 笔交易、${payload.statements.length} 份账单。V1 备份不含独立复核备注，本地已有备注已保留。` }
      } catch (error) {
        return { ok: false, message: `恢复失败：${describeError(error)}` }
      }
    }),
    [enqueue, reload],
  )

  const clearData = useCallback(
    (includeDemo: boolean) => enqueue(async () => {
      await clearAllData({ includeDemo })
      await reload()
    }),
    [enqueue, reload],
  )

  // Demo Mode is a view switch, not a second database: the fictional rows
  // come from an in-memory snapshot while `snapshot` always holds the real
  // IndexedDB content. Production pages keep filtering `!isDemo` so stray
  // legacy rows can never leak in before the next purge.
  const demoSnapshot = useMemo(() => (settings.demoMode ? getDemoSnapshot() : EMPTY), [settings.demoMode])

  const visibleStatements = useMemo(
    () => (settings.demoMode ? demoSnapshot.statements : snapshot.statements.filter((row) => !row.isDemo)),
    [settings.demoMode, snapshot.statements, demoSnapshot],
  )
  const visibleTransactions = useMemo(
    () => (settings.demoMode ? demoSnapshot.transactions : snapshot.transactions.filter((row) => !row.isDemo)),
    [settings.demoMode, snapshot.transactions, demoSnapshot],
  )
  const visibleImports = useMemo(
    () => (settings.demoMode ? demoSnapshot.imports : snapshot.imports.filter((row) => !row.isDemo)),
    [settings.demoMode, snapshot.imports, demoSnapshot],
  )

  /**
   * Human-readable XLSX archive of the currently visible ledger.
   * Unlike JSON backup, this file cannot restore the app: sheet 1 (交易明细)
   * keeps exact stored currencies and minor-unit amounts for independent
   * viewing in Excel / LibreOffice, while sheet 2 (Technical Metadata) keeps
   * exact stored IDs, fingerprints and occurrences. No conversion or
   * recalculation.
   */
  const exportLedgerXlsx = useCallback(async (): Promise<void> => {
    const transactions = settings.demoMode ? demoSnapshot.transactions : snapshot.transactions.filter((row) => !row.isDemo)
    const statements = settings.demoMode ? demoSnapshot.statements : snapshot.statements.filter((row) => !row.isDemo)
    await downloadLedgerArchive(ledgerArchiveFileName(), transactions, statements)
  }, [settings.demoMode, snapshot.transactions, snapshot.statements, demoSnapshot])

  const api = useMemo<AppApi>(
    () => ({
      state: { ...snapshot, ready, settings, notes, progress, demoMode: settings.demoMode },
      refresh,
      setSettings,
      importFiles,
      previewLegacyImport,
      confirmLegacyImport,
      loadDemoData,
      updateTransaction: patchTransaction,
      recomputeStatement,
      saveNote,
      backup,
      backupData,
      backupFull,
      exportLedgerXlsx,
      restore,
      archiveStatus,
      clearData,
      visibleStatements,
      visibleTransactions,
      visibleImports,
    }),
    [
      snapshot,
      ready,
      settings,
      notes,
      progress,
      refresh,
      setSettings,
      importFiles,
      previewLegacyImport,
      confirmLegacyImport,
      loadDemoData,
      patchTransaction,
      recomputeStatement,
      saveNote,
      backup,
      backupData,
      backupFull,
      exportLedgerXlsx,
      restore,
      archiveStatus,
      clearData,
      visibleStatements,
      visibleTransactions,
      visibleImports,
    ],
  )

  return <AppContext.Provider value={api}>{children}</AppContext.Provider>
}

async function readFileWithRetry(file: File): Promise<ArrayBuffer> {
  try {
    return await file.arrayBuffer()
  } catch {
    return file.arrayBuffer()
  }
}

function describeError(error: unknown): string {
  if (error instanceof UnsupportedFileError) return error.message
  if (error instanceof Error) return error.message
  return '未知错误'
}

export function useApp(): AppApi {
  const context = useContext(AppContext)
  if (!context) throw new Error('useApp must be used inside <AppProvider>')
  return context
}

export { updateTransactions }
