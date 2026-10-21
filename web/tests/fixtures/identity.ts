import { emptySummary, type ParsedStatement } from '../../src/parsers/types'
import { ingestParsedStatement, type ExistingSnapshot } from '../../src/core/ingest'

export const EMPTY_SNAPSHOT: ExistingSnapshot = { statements: [], transactions: [], imports: [] }

export function syntheticStatement(descriptions: string[]): ParsedStatement {
  return {
    bank: 'boc', cardLast4: '1234', cycleStart: '2024-01-01', cycleEnd: '2024-01-31', dueDate: null,
    summary: emptySummary(), confidence: 1, parserId: 'synthetic', parserVersion: '1', warnings: [],
    transactions: descriptions.map((description, index) => ({
      cardLast4: '1234', transactionDate: '2024-01-05', postingDate: '2024-01-06',
      description, rawDescription: description, transactionCurrency: 'CNY',
      transactionAmountMinor: 12880, settlementCurrency: 'CNY', settlementAmountMinor: 12880,
      type: 'purchase', direction: 'debit', bankToken: '', confidence: 1,
      sourcePage: null, sourceRow: index + 1, rawText: description,
    })),
  }
}

export function ingestSynthetic(descriptions: string[], fileHash = 'synthetic-hash', existing = EMPTY_SNAPSHOT) {
  return ingestParsedStatement(syntheticStatement(descriptions), {
    fileName: 'synthetic.txt', fileHash, fileSize: 1, sourceType: 'text',
  }, existing)
}
