import { db } from './db'
import Dexie from 'dexie'

export const LEDGER_REVISION_KEY = 'ledger:revision'
export const LEDGER_WRITER = crypto.randomUUID()
const changes = typeof window === 'undefined' || typeof window.BroadcastChannel === 'undefined'
  ? null : new window.BroadcastChannel('keepraw-ledger:committed')

export function subscribeLedgerChanges(refresh: () => void): () => void {
  const listener = (event: MessageEvent<{ writer?: string }>) => {
    if (event.data.writer !== LEDGER_WRITER) refresh()
  }
  changes?.addEventListener('message', listener)
  return () => changes?.removeEventListener('message', listener)
}
export interface LedgerRevision { version: number; generation: number; writer: string }

export class LedgerConflictError extends Error {
  constructor(readonly cleared = false) {
    super(cleared ? '账本已被其他标签页清除，本次导入已回滚。请确认后重新导入。'
      : '其他标签页正在修改账本，本次操作已回滚。请稍后重试。')
    this.name = 'LedgerConflictError'
  }
}

export async function readLedgerRevision(): Promise<LedgerRevision> {
  const stored = (await db.settings.get(LEDGER_REVISION_KEY))?.value
  if (stored === undefined) return { version: 0, generation: 0, writer: '' }
  const value = stored as Partial<LedgerRevision> | null
  if (!value || !Number.isSafeInteger(value.version) || !Number.isSafeInteger(value.generation) ||
    value.version! < 0 || value.generation! < 0 || typeof value.writer !== 'string') {
    throw new Error('账本提交版本无效，已停止写入，请先核查本地数据。')
  }
  return value as LedgerRevision
}

/** Read/check/write only inside the caller's financial write transaction. */
export async function assertLedgerRevision(expected: LedgerRevision): Promise<void> {
  const current = await readLedgerRevision()
  if (current.generation !== expected.generation) throw new LedgerConflictError(true)
  if (current.version !== expected.version) throw new LedgerConflictError()
}

export async function bumpLedgerRevision(cleared = false): Promise<void> {
  const current = await readLedgerRevision()
  if (current.version === Number.MAX_SAFE_INTEGER || current.generation === Number.MAX_SAFE_INTEGER) throw new Error('账本提交版本已超出安全范围，已停止写入。')
  await db.settings.put({ key: LEDGER_REVISION_KEY, value: {
    version: current.version + 1, generation: current.generation + (cleared ? 1 : 0), writer: LEDGER_WRITER,
  } satisfies LedgerRevision })
  // Notify only after the root IndexedDB transaction commits. Each event retains
  // its writer, so a later local write cannot hide an intervening foreign one.
  let transaction = Dexie.currentTransaction
  while (transaction?.parent) transaction = transaction.parent
  transaction?.on('complete', () => { changes?.postMessage({ writer: LEDGER_WRITER }) })
}
