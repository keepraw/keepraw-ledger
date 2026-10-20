/**
 * Golden fixture generator, Web side (Task A-3.4.3).
 *
 * Run from web/:
 *   npm run golden:generate -- --input <bill> --out <golden-dir>
 *
 * Reads a real bill file locally, parses it with the registered Web parsers
 * (read-only), and writes desensitized `web.json` next to the Python output.
 * Raw bill content is never copied into golden/.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

interface Args {
  input: string
  out: string
}

function parseArgs(argv: string[]): Args {
  const args: Args = { input: '', out: '' }
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (token === '--input') args.input = argv[++i] ?? ''
    else if (token === '--out') args.out = argv[++i] ?? ''
    else throw new Error('Golden generation requires desensitization; unsupported argument.')
  }
  if (!args.input || !args.out) throw new Error('usage: generate-golden.ts --input <bill> --out <golden-dir>')
  return args
}

export async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2))

  // html.ts needs a DOMParser; provide it from jsdom when running under node.
  if (typeof (globalThis as Record<string, unknown>).DOMParser === 'undefined') {
    const { JSDOM } = await import('jsdom')
    ;(globalThis as Record<string, unknown>).DOMParser = new JSDOM('').window.DOMParser
  }

  const { buildSourceDocument } = await import('../src/parsers/extract.ts')
  const { detectParser, parseDocument } = await import('../src/parsers/registry.ts')
  const { transactionFingerprint } = await import('../src/core/identity.ts')
  const { assignOccurrences, transactionId } = await import('../src/core/dedupe.ts')
  const { normalizeWebStatement } = await import('../src/golden/normalize.ts')
  const { GOLDEN_GENERATOR_WEB } = await import('../src/golden/schema.ts')

  const inputPath = resolve(args.input)
  const outDir = resolve(args.out)
  const bytes = readFileSync(inputPath)
  const fileHash = createHash('sha256').update(bytes).digest('hex')
  const fileName = inputPath.split(/[/\\]/).pop() ?? inputPath

  const doc = await buildSourceDocument({
    fileName,
    buffer: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    fileHash,
  })
  const match = detectParser(doc)
  if (!match) throw new Error(`no Web parser matched ${fileName} (sourceType=${doc.sourceType})`)
  const parsed = parseDocument(doc, match.parser)

  const cardLast4 = parsed.cardLast4 || '????'
  const fingerprints = parsed.transactions.map((tx) =>
    transactionFingerprint({
      bank: parsed.bank,
      cardLast4: tx.cardLast4 || cardLast4,
      transactionDate: tx.transactionDate,
      postingDate: tx.postingDate,
      settlementCurrency: tx.settlementCurrency,
      settlementAmountMinor: tx.settlementAmountMinor,
      type: tx.type,
      description: tx.description,
    }),
  )
  const occurrences = assignOccurrences(fingerprints)
  const nativeIds = fingerprints.map((fp, i) => transactionId(fp, occurrences[i]!.occurrence))
  const statement = normalizeWebStatement(parsed, nativeIds)

  mkdirSync(outDir, { recursive: true })
  const metaPath = resolve(outDir, 'input.meta.json')
  if (existsSync(metaPath)) {
    const meta = JSON.parse(readFileSync(metaPath, 'utf-8')) as { sha256?: string }
    if (meta.sha256 !== fileHash) {
      throw new Error(`sha256 mismatch: ${inputPath} does not match ${metaPath} (expected ${meta.sha256}, got ${fileHash})`)
    }
  }
  writeFileSync(resolve(outDir, 'web.json'), JSON.stringify(statement, null, 2) + '\n', 'utf-8')
  console.log(`bank=${statement.bank} txs=${statement.transactionCount} parser=${statement.parserName}`)
  console.log(`wrote web.json (generator=${GOLDEN_GENERATOR_WEB}, desensitized=true)`)
  return 0
}
