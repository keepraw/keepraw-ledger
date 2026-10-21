/**
 * Golden diff rules (Task A-3.4.4).
 *
 * Canonical rule set, mirrored in `src/ccparser/golden.py::diff_normalized`:
 * P0 amount/direction/currency/date/count/scope -> BLOCKING,
 * P1 description (+ identity incompatibility, reported once in `identity`) -> WARNING,
 * P2 category/flags/summary are Web-only and never compared -> INFO (count 0).
 */

import { alignTransactions, buildIdentityEntries } from './identityReport'
import { GOLDEN_SCHEMA, type DiffFinding, type DiffReport, type GoldenStatement } from './schema'

export function diffGolden(python: GoldenStatement, web: GoldenStatement, generator: string): DiffReport {
  const pairing = alignTransactions(python.transactions, web.transactions)
  const findings: DiffFinding[] = []

  for (const pIndex of pairing.pythonUnpaired) {
    const key = python.transactions[pIndex]!
    findings.push({
      severity: 'BLOCKING',
      rule: 'transaction_count',
      side: 'python_only',
      pythonIndex: pIndex,
      detail: `Python row ${pIndex} has no Web counterpart (business key ${[key.transactionDate, key.postingDate, key.amountMinor, key.currency].join('|')}).`,
    })
  }
  for (const wIndex of pairing.webUnpaired) {
    const key = web.transactions[wIndex]!
    findings.push({
      severity: 'BLOCKING',
      rule: 'transaction_count',
      side: 'web_only',
      webIndex: wIndex,
      detail: `Web row ${wIndex} has no Python counterpart (business key ${[key.transactionDate, key.postingDate, key.amountMinor, key.currency].join('|')}).`,
    })
  }

  for (const [pIndex, wIndex] of pairing.pairs) {
    const p = python.transactions[pIndex]!
    const w = web.transactions[wIndex]!
    if (p.amountMinor !== w.amountMinor) {
      findings.push({ severity: 'BLOCKING', rule: 'amountMinor', pythonIndex: pIndex, webIndex: wIndex, python: p.amountMinor, web: w.amountMinor })
    }
    if (p.direction !== w.direction) {
      findings.push({ severity: 'BLOCKING', rule: 'direction', pythonIndex: pIndex, webIndex: wIndex, python: p.direction, web: w.direction })
    }
    if (p.currency !== w.currency) {
      findings.push({ severity: 'BLOCKING', rule: 'currency', pythonIndex: pIndex, webIndex: wIndex, python: p.currency, web: w.currency })
    }
    if (p.transactionDate !== w.transactionDate) {
      findings.push({ severity: 'BLOCKING', rule: 'date', field: 'transactionDate', pythonIndex: pIndex, webIndex: wIndex, python: p.transactionDate, web: w.transactionDate })
    }
    if (p.postingDate !== w.postingDate) {
      findings.push({ severity: 'BLOCKING', rule: 'date', field: 'postingDate', pythonIndex: pIndex, webIndex: wIndex, python: p.postingDate, web: w.postingDate })
    }
    if (p.bank !== w.bank || p.cardLast4 !== w.cardLast4) {
      findings.push({
        severity: 'BLOCKING',
        rule: 'identity_scope',
        pythonIndex: pIndex,
        webIndex: wIndex,
        python: { bank: p.bank, cardLast4: p.cardLast4 },
        web: { bank: w.bank, cardLast4: w.cardLast4 },
      })
    }
    if (p.normalizedDescription !== w.normalizedDescription) {
      findings.push({ severity: 'WARNING', rule: 'description', pythonIndex: pIndex, webIndex: wIndex, python: p.description, web: w.description })
    }
  }

  const blocking = findings.filter((f) => f.severity === 'BLOCKING').length
  const warnings = findings.filter((f) => f.severity === 'WARNING').length
  return {
    schema: GOLDEN_SCHEMA,
    generator,
    python: { transactionCount: python.transactions.length },
    web: { transactionCount: web.transactions.length },
    pairedRows: pairing.pairs.length,
    verdict: blocking > 0 ? 'BLOCKING' : warnings > 0 ? 'WARNING' : 'PASS',
    severityCounts: { BLOCKING: blocking, WARNING: warnings, INFO: 0 },
    findings,
    identity: {
      pythonAlgo: 'sha256-pipe',
      webAlgo: 'fnv1a-dual-lane',
      compatible: false,
      note: 'Identity schemes are incompatible by design (A-3.2 section 5). This table only observes which business keys pair; nothing is merged.',
      merged: false,
      entries: buildIdentityEntries(python.transactions, web.transactions, pairing),
    },
  }
}
