import { transactionId } from '../core/dedupe'
import { transactionFingerprint } from '../core/identity'
import { transactionDisplayDescription } from '../core/descriptionNormalizer'
import { cleanSourceDescription } from '../core/sourceDescription'
import { BANKS, CATEGORIES, TRANSACTION_TYPE_LABELS, type Transaction, type TransactionType } from '../core/types'
import { parseDateInput } from '../core/dates'
import { parseLegacyAmount } from './legacyPythonExportV1'
import type { LegacyAnomaly, LegacyPreview, NormalizedLegacyRow } from './types'

export const NATIVE_LEDGER_SHEET = '交易明细'
/** Frozen pre-rawDescription export. Column 21 was subsequently appended by tabular.ts. */
export const NATIVE_LEDGER_COLUMNS = [
  '银行', '卡尾号', '交易日', '入账日', '交易描述', '交易币种', '交易金额', '入账币种', '入账金额',
  '交易类型', '借贷方向', '分类', '复核状态', '来源文件', '文件指纹', '来源页', '原始片段',
  '交易标识', '业务指纹', '重复序号',
] as const
export const NATIVE_LEDGER_CURRENT_COLUMNS = [...NATIVE_LEDGER_COLUMNS, '原始描述'] as const

/** Exact order, exact spelling, no duplicate, extra or conflicting columns. */
export function detectNativeLedgerShape(header: unknown[]): 20 | 21 | null {
  const schema = header.length === 20 ? NATIVE_LEDGER_COLUMNS : NATIVE_LEDGER_CURRENT_COLUMNS
  return header.length === schema.length && schema.every((name, index) => header[index] === name)
    ? header.length as 20 | 21 : null
}

const bankEntries = Object.entries(BANKS)
const typeEntries = Object.entries(TRANSACTION_TYPE_LABELS) as Array<[TransactionType, string]>
const statuses: readonly Transaction['reviewStatus'][] = ['ok', 'pending', 'confirmed', 'rejected']
const blank = (value: unknown) => value === null || value === undefined || value === ''
const text = (value: unknown): string => typeof value === 'string' ? value : ''
const positiveInteger = (value: unknown): number | null => {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^[1-9]\d*$/.test(value))) return null
  const number = Number(value)
  return Number.isSafeInteger(number) && number > 0 ? number : null
}

export function parseNativeLedgerRows(data: unknown[][], width: 20 | 21) {
  const rows: NormalizedLegacyRow[] = []
  const anomalies: LegacyAnomaly[] = []
  const reviewIssues: NonNullable<LegacyPreview['reviewIssues']> = []
  let totalRows = 0
  // Count even invalid companion rows before validation: a malformed duplicate
  // must not cause another row with that ID to be selected as the winner.
  const counts = new Map<string, number>()
  for (const cells of data) {
    const id = text(cells[17])
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  for (const [index, cells] of data.entries()) {
    if (cells.every(blank)) continue
    totalRows++
    const sourceRow = index + 2
    const fail = (kind: LegacyAnomaly['kind'], detail: string) => anomalies.push({ rowNumber: sourceRow, kind, detail })
    const bank = bankEntries.find(([, bank]) => bank.name === cells[0])?.[0] as Transaction['bank'] | undefined
    const cardLast4 = text(cells[1])
    const displayed = text(cells[4])
    if (!bank || !/^(?:\d{4}|\?{4})$/.test(cardLast4) || !displayed.trim()) {
      fail('missing_field', '银行、卡尾号或交易描述缺失/无效（卡尾号必须保留为文本）'); continue
    }
    const date = (value: unknown) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && parseDateInput(value) === value ? value : null
    const transactionDate = date(cells[2])
    const postingDate = date(cells[3])
    if ((!blank(cells[2]) && !transactionDate) || (!blank(cells[3]) && !postingDate) || (!transactionDate && !postingDate)) {
      fail('date_unparseable', '日期无效，或交易日与入账日均缺失；不替换原日期'); continue
    }
    const transactionCurrency = text(cells[5])
    const settlementCurrency = text(cells[7])
    const money = (value: unknown, currency: string) => /^[A-Z]{3}$/.test(currency) &&
      (typeof value === 'number' || (typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value)))
      ? parseLegacyAmount(value, currency) : null
    const transactionAmountMinor = money(cells[6], transactionCurrency)
    const settlementAmountMinor = money(cells[8], settlementCurrency)
    if (transactionAmountMinor === null || settlementAmountMinor === null) {
      fail('amount_unparseable', '原币或入账币种/金额无效、超精度或缺失；两组金额独立校验，不相互替代'); continue
    }
    const type = typeEntries.find(([, label]) => label === cells[9])?.[0]
    const direction: Transaction['direction'] | null = cells[10] === '借' ? 'debit' : cells[10] === '贷' ? 'credit' : null
    const category = CATEGORIES.find(value => value === cells[11])
    const reviewStatus = statuses.find(value => value === cells[12])
    const sourcePage = blank(cells[15]) ? null : positiveInteger(cells[15])
    if (!type || !direction || !category || !reviewStatus || (!blank(cells[15]) && sourcePage === null) ||
      (settlementAmountMinor !== 0 && (settlementAmountMinor < 0) !== (direction === 'credit')) ||
      [13, 14, 16].some(index => !blank(cells[index]) && typeof cells[index] !== 'string') ||
      cells.slice(width).some(value => !blank(value))) {
      fail('invalid_field', '类型、方向、分类、复核状态或来源信息无效/冲突'); continue
    }
    const id = text(cells[17])
    const fingerprint = text(cells[18])
    const occurrence = positiveInteger(cells[19])
    const rawDescription = width === 21 ? text(cells[20]) : displayed
    if (width === 21 && !blank(cells[20]) && typeof cells[20] !== 'string') {
      fail('invalid_field', '原始描述必须是文本'); continue
    }
    // Older 20-column exports only retain the displayed identity candidate.
    // Reapplying display normalization can change that text even though its
    // fingerprint is valid. The 21-column raw-description recovery still
    // requires BOTH fingerprint and display agreement.
    const candidates = width === 20 ? [displayed] : [
      cleanSourceDescription(rawDescription, bank), rawDescription.replace(/\s+/g, ' ').trim(), rawDescription, displayed,
    ]
    const financial = { bank, cardLast4, transactionDate, postingDate, transactionCurrency,
      transactionAmountMinor, settlementCurrency, settlementAmountMinor, type, direction }
    const description = candidates.find(description => transactionFingerprint({ ...financial, description }) === fingerprint &&
      (width === 20 || transactionDisplayDescription({ bank, description, rawDescription }) === displayed))
    if (!/^[a-f0-9]{16}$/.test(fingerprint) || occurrence === null ||
      id !== transactionId(fingerprint, occurrence) || description === undefined) {
      fail('identity_conflict', '交易标识、业务指纹、重复序号或金融字段无法互相验证；显示描述可能已丢失身份文本'); continue
    }
    rows.push({ ...financial, description, rawDescription, category, confidence: 0,
      // Confidence and flags were never exported. Explicitly require review
      // rather than pretending the original parser confidence was recovered.
      flags: ['low_confidence'], rawText: text(cells[16]), sourceRow, cycleStart: null, cycleEnd: null,
      native: { id, fingerprint, occurrence, reviewStatus, sourcePage, sourceFileName: text(cells[13]), sourceFileHash: text(cells[14]) } })
  }
  // An ID repeated within a workbook is ambiguous, even when financial fields
  // agree. Exclude every occurrence; never choose a winning spreadsheet row.
  const valid = rows.filter(row => {
    if (counts.get(row.native!.id) === 1) return true
    anomalies.push({ rowNumber: row.sourceRow, kind: 'identity_conflict', detail: `工作簿内交易标识重复：${row.native!.id}` })
    return false
  })
  if (valid.length) reviewIssues.push({ rowNumber: valid[0]!.sourceRow,
    detail: 'XLSX 未导出置信度、复核标记、账期、原来源行号或独立备注；置信度设为 0 并标记低置信度，来源行号使用本工作簿行号。' +
      (width === 20 ? '20 列版本没有原始描述，使用交易描述，无法验证的身份行已排除。' : '身份描述按已知源文本清理规则验证；无法还原的身份行已排除。') })
  return { rows: valid, anomalies, totalRows, reviewIssues }
}

/** Native identities are authoritative only after parsing validation. Unlike
 * historical business matching, a different occurrence may never consume one. */
export function compareNativeLedgerRows(rows: LegacyPreview['rows'], existing: Transaction[]) {
  const byId = new Map(existing.map(row => [row.id, row]))
  const duplicateIds = new Set<string>()
  const warnings: NonNullable<LegacyPreview['identityWarnings']> = []
  const fields = ['bank', 'cardLast4', 'transactionDate', 'postingDate', 'description', 'transactionCurrency',
    'transactionAmountMinor', 'settlementCurrency', 'settlementAmountMinor', 'type', 'direction', 'fingerprint', 'occurrence'] as const
  for (const row of rows) {
    const current = byId.get(row.id)
    if (!current) continue
    if (fields.some(field => current[field] !== row[field])) {
      warnings.push({ rowNumber: row.sourceRow, blocking: true, detail: `交易标识冲突，拒绝覆盖：${row.id}` })
    } else duplicateIds.add(row.id)
  }
  return { duplicateIds, warnings }
}
