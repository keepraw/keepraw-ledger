import { extractTables, extractText, sanitizeHtml } from './html'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { PdfDocument, PdfPage, PdfTextItem, SourceDocument, SourceType } from './types'

/** 25 MB. Real statements are far below this; anything larger is refused early. */
export const MAX_FILE_SIZE = 25 * 1024 * 1024
export const MAX_IMPORT_BATCH_BYTES = 100 * 1024 * 1024
export const MAX_PDF_PAGES = 60

/** Check metadata before any full read, hash or retained evidence copy. */
export function assertSourceFileSize(size: number): void {
  if (!Number.isSafeInteger(size) || size < 0) throw new Error('文件大小无效，已拒绝读取。')
  if (size > MAX_FILE_SIZE) throw new ExtractionError('文件超过 25 MiB 上限，未读取或保存原始文件。请拆分文件后重新导入。', 'file_too_large')
}

export class ExtractionError extends Error {
  constructor(
    message: string,
    readonly reason: string,
  ) {
    super(message)
    this.name = 'ExtractionError'
  }
}

export function detectSourceType(fileName: string, bytes: Uint8Array): SourceType {
  const lower = fileName.toLowerCase()
  if (lower.endsWith('.pdf') || isPdf(bytes)) return 'pdf'
  if (lower.endsWith('.eml') || lower.endsWith('.msg')) return 'eml'
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'html'
  if (lower.endsWith('.txt')) return 'text'
  return 'unknown'
}

function isPdf(bytes: Uint8Array): boolean {
  const head = String.fromCharCode(...bytes.slice(0, 5))
  return head === '%PDF-'
}

/** SHA-256 of the raw file bytes, computed locally with WebCrypto. */
export async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buffer)
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

export async function buildSourceDocument(input: {
  fileName: string
  buffer: ArrayBuffer
  fileHash: string
}): Promise<SourceDocument> {
  const bytes = new Uint8Array(input.buffer)
  assertSourceFileSize(bytes.byteLength)
  if (bytes.byteLength === 0) {
    throw new ExtractionError('文件为空', 'empty_file')
  }

  const sourceType = detectSourceType(input.fileName, bytes)
  const base: SourceDocument = {
    fileName: input.fileName,
    fileSize: bytes.byteLength,
    fileHash: input.fileHash,
    sourceType,
    pdf: null,
    html: null,
    tables: [],
    text: '',
    email: null,
  }

  if (sourceType === 'pdf') {
    const pdf = await extractPdf(bytes)
    base.pdf = pdf
    base.text = pdfToText(pdf)
    return base
  }

  if (sourceType === 'eml') {
    const parsed = await parseEmail(bytes)
    base.html = parsed.html ? sanitizeHtml(parsed.html) : null
    base.text = parsed.text ?? (base.html ? extractText(base.html) : '')
    base.tables = base.html ? extractTables(base.html) : []
    base.email = {
      subject: parsed.subject ?? '',
      from: parsed.from?.address ?? '',
      date: normalizeEmailDate(parsed.date),
    }
    return base
  }

  if (sourceType === 'html') {
    const html = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
    base.html = sanitizeHtml(html)
    base.text = extractText(base.html)
    base.tables = extractTables(base.html)
    return base
  }

  if (sourceType === 'text') {
    base.text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
    return base
  }

  throw new ExtractionError('不支持的文件类型，请提供 PDF 或 EML 账单', 'unsupported_type')
}

function normalizeEmailDate(value: Date | string | undefined): string | null {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return date.toISOString().slice(0, 10)
}

async function parseEmail(bytes: Uint8Array): Promise<{
  html?: string
  text?: string
  subject?: string
  from?: { address?: string }
  date?: Date | string
}> {
  const { default: postalMime } = await import('postal-mime')
  return postalMime.parse(bytes) as never
}

let pdfjsModule: typeof import('pdfjs-dist') | null = null

async function loadPdfjs(): Promise<typeof import('pdfjs-dist')> {
  if (pdfjsModule) return pdfjsModule
  const pdfjs = await import('pdfjs-dist')
  if (typeof window !== 'undefined' && 'Worker' in window) {
    const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl
  }
  pdfjsModule = pdfjs
  return pdfjs
}

/** pdf.js wrapper that only ever reads text and coordinates. */
export async function extractPdf(bytes: Uint8Array): Promise<PdfDocument> {
  const pdfjs = await loadPdfjs()
  const task = pdfjs.getDocument({
    data: bytes,
    isEvalSupported: false,
    useSystemFonts: false,
    disableFontFace: true,
    verbosity: 0,
  })
  let doc: PDFDocumentProxy | null = null
  try {
    doc = await task.promise
  } catch (error) {
    throw new ExtractionError(
      `PDF 无法打开：${error instanceof Error ? error.message : '未知错误'}`,
      'pdf_open_failed',
    )
  }
  if (!doc) throw new ExtractionError('PDF 无法打开', 'pdf_open_failed')

  if (doc.numPages > MAX_PDF_PAGES) {
    await doc.destroy()
    throw new ExtractionError(`PDF 页数超过 ${MAX_PDF_PAGES} 页上限`, 'too_many_pages')
  }

  const pages: PdfPage[] = []
  try {
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
      const page = await doc.getPage(pageNumber)
      const viewport = page.getViewport({ scale: 1 })
      const content = await page.getTextContent()
      const items: PdfTextItem[] = []
      for (const raw of content.items) {
        if (!('str' in raw) || !raw.str.trim()) continue
        const transform = raw.transform as number[]
        items.push({
          text: raw.str,
          x: transform[4] ?? 0,
          // PDF user space has its origin at the bottom left; flip to top-down.
          y: viewport.height - (transform[5] ?? 0),
          width: raw.width ?? 0,
          height: raw.height ?? 0,
        })
      }
      pages.push({ pageNumber, width: viewport.width, height: viewport.height, items })
      page.cleanup()
    }
  } finally {
    await doc.destroy()
  }

  return { numPages: pages.length, pages }
}

export function pdfToText(pdf: PdfDocument): string {
  return pdf.pages
    .map((page) => page.items.map((item) => item.text).join(' '))
    .join('\n')
    .replace(/[ \t]{2,}/g, ' ')
}
