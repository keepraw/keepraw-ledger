import type { Transaction } from './types'
import { cleanSourceDescription } from './sourceDescription'

const spaces = (text: string): string => text.replace(/\s+/gu, ' ').trim()
const ACTION = /^(?:网上消费|消费)[\s:：,，\-－–—]+(?=\S)/u
const CHANNEL = /^(支付宝|财付通|微信支付|云闪付|网银在线)([\s,，:：\-－–—/|｜]+)(.*)$/u

/** Conservative, local display rules; never use this output to calculate identity. */
export function normalizeDisplayDescription(description: string): string {
  let text = spaces(description)
  // Consume all leading action tokens in one pass to keep normalization idempotent.
  while (ACTION.test(text)) text = text.replace(ACTION, '')
  const channel = CHANNEL.exec(text)
  if (channel) text = channel[1]! + (channel[3] ? `-${channel[3]}` : '')
  return text
}

/**
 * Read-only compatibility for new imports and old databases. Only transform a
 * recognized original import value. Divergent (possibly edited) values stay exact.
 * No persisted description, merchant, category or identity field is rewritten.
 */
export function transactionDisplayDescription(tx: Pick<Transaction, 'description' | 'rawDescription' | 'bank'>): string {
  const original = spaces(tx.rawDescription)
  const source = tx.bank === 'bocom' ? original : cleanSourceDescription(tx.rawDescription, tx.bank)
  if (tx.description !== original && tx.description !== source && tx.description !== tx.rawDescription) return tx.description
  return normalizeDisplayDescription(tx.description)
}

export function matchesTransactionDescription(tx: Transaction, needle: string): boolean {
  const query = needle.toLowerCase()
  return [transactionDisplayDescription(tx), tx.description, tx.merchant, tx.rawDescription]
    .some(value => value.toLowerCase().includes(query))
}
