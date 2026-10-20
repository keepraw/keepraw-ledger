import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { SYNTHETIC_CCB_HTML } from './fixtures/ccbEml'
import { buildSourceDocument } from '../src/parsers/extract'
import { ccbParser } from '../src/parsers/ccb'

it('runs the TypeScript Golden generator on a synthetic source without Python', () => {
  const dir = mkdtempSync(join(tmpdir(), 'keepraw-golden-generator-'))
  try {
    const input = join(dir, 'synthetic.html')
    const out = join(dir, 'output')
    writeFileSync(input, SYNTHETIC_CCB_HTML)
    execFileSync(process.execPath, ['scripts/generate-golden.mjs', '--input', input, '--out', out], { encoding: 'utf8' })
    const doc = JSON.parse(readFileSync(join(out, 'web.json'), 'utf8'))
    expect(doc.schema).toBe('golden/v1')
    expect(doc.origin).toBe('web')
    expect(doc.bank).toBe('ccb')
    expect(doc.desensitized).toBe(true)
    expect(doc.transactionCount).toBe(14)
    expect(doc.transactions).toHaveLength(14)
    expect(readFileSync(input, 'utf8')).toBe(SYNTHETIC_CCB_HTML)
  } finally { rmSync(dir, { recursive: true, force: true }) }
}, 30_000)

it('CLI retains source SHA-256 validation and never overwrites a reference on mismatch', () => {
  const dir = mkdtempSync(join(tmpdir(), 'keepraw-golden-meta-'))
  try {
    const input = join(dir, 'synthetic.html')
    writeFileSync(input, SYNTHETIC_CCB_HTML)
    writeFileSync(join(dir, 'input.meta.json'), JSON.stringify({ sha256: '0'.repeat(64) }))
    writeFileSync(join(dir, 'web.json'), 'synthetic existing reference')
    expect(() => execFileSync(process.execPath, ['scripts/generate-golden.mjs', '--input', input, '--out', dir], { encoding: 'utf8', stdio: 'pipe' })).toThrow()
    expect(readFileSync(join(dir, 'web.json'), 'utf8')).toBe('synthetic existing reference')
    expect(readFileSync(input, 'utf8')).toBe(SYNTHETIC_CCB_HTML)
  } finally { rmSync(dir, { recursive: true, force: true }) }
}, 30_000)

it('CLI errors do not print source filenames or source text', () => {
  const dir = mkdtempSync(join(tmpdir(), 'keepraw-golden-error-'))
  try {
    const input = join(dir, 'SYNTHETIC_PRIVATE_SOURCE_NAME.txt'), out = join(dir, 'output')
    writeFileSync(input, '合成姓名合成账号 SECRET_SYNTHETIC_SOURCE')
    const result = spawnSync(process.execPath, ['scripts/generate-golden.mjs', '--input', input, '--out', out], { encoding: 'utf8' })
    expect(result.status).toBe(2)
    expect(result.stdout + result.stderr).not.toMatch(/SYNTHETIC_PRIVATE_SOURCE_NAME|合成姓名|SECRET_SYNTHETIC_SOURCE/)
    expect(() => readFileSync(join(out, 'web.json'))).toThrow()
  } finally { rmSync(dir, { recursive: true, force: true }) }
}, 30_000)

it('CLI never publishes synthetic identifying source text and keeps independently parsed financial evidence', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'keepraw-golden-privacy-'))
  try {
    const input = join(dir, 'SYNTHETIC_PRIVATE_FILENAME.html'), out = join(dir, 'output')
    const html = SYNTHETIC_CCB_HTML.replace('示例餐厅-消费测试店', '消费合成姓名合成商户 4111-1111-1111-1111 账户ACCOUNT_SYNTHETIC_001 Li Wu')
    expect(html).not.toBe(SYNTHETIC_CCB_HTML)
    writeFileSync(input, html)
    const stdout = execFileSync(process.execPath, ['scripts/generate-golden.mjs', '--input', input, '--out', out], { encoding: 'utf8' })
    const output = readFileSync(join(out, 'web.json'), 'utf8')
    expect(output + stdout).not.toMatch(/合成姓名|合成商户|4111|ACCOUNT_SYNTHETIC_001|Li Wu|SYNTHETIC_PRIVATE_FILENAME/)
    const bytes = new TextEncoder().encode(html).buffer
    const parsed = ccbParser.parse(await buildSourceDocument({ fileName: 'synthetic.html', buffer: bytes, fileHash: 'synthetic' }))
    const result = JSON.parse(output)
    expect(result.transactionCount).toBe(parsed.transactions.length)
    expect(result.transactions.map((row: { amountMinor: number; currency: string }) => [row.amountMinor, row.currency]))
      .toEqual(parsed.transactions.map(row => [row.settlementAmountMinor, row.settlementCurrency]))
    execFileSync(process.execPath, ['scripts/generate-golden.mjs', '--input', input, '--out', out], { encoding: 'utf8' })
    expect(readFileSync(join(out, 'web.json'), 'utf8')).toBe(output)
    expect(readFileSync(input, 'utf8')).toBe(html)
  } finally { rmSync(dir, { recursive: true, force: true }) }
}, 30_000)

it('CLI refuses the unredacted-output flag without writing any snapshot', () => {
  const dir = mkdtempSync(join(tmpdir(), 'keepraw-golden-unsafe-'))
  try {
    const input = join(dir, 'synthetic.html'), out = join(dir, 'output')
    writeFileSync(input, SYNTHETIC_CCB_HTML)
    expect(() => execFileSync(process.execPath, ['scripts/generate-golden.mjs', '--input', input, '--out', out, '--no-desensitize'], { encoding: 'utf8', stdio: 'pipe' })).toThrow()
    expect(() => readFileSync(join(out, 'web.json'))).toThrow()
  } finally { rmSync(dir, { recursive: true, force: true }) }
}, 30_000)
