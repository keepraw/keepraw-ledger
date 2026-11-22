import type { Direction, TransactionType } from './types'

/** Frozen source-token encoding for identity compatibility, not financial facts. */
const TYPE_TOKENS: Record<string, TransactionType> = {
  分期利息: 'interest', 分期手续费: 'interest', 分期扣款: 'installment_payment',
  每期入账: 'installment_payment', 分期入账: 'installment_payment',
  分期原始: 'installment_original', 分期消费原始: 'installment_original', 商户分期: 'installment_original',
  信用卡还款: 'payment', 转账还款: 'payment', 自助还款: 'payment', 网上还款: 'payment', 多渠道还款: 'payment',
  还款: 'payment', 转账: 'payment', 卡卡转账: 'payment',
  网上消费退货: 'refund', 退货: 'refund', 退款: 'refund', 退汇: 'refund',
  刷卡金: 'cashback', 返现: 'cashback', 返还: 'cashback', 费用返还: 'cashback', 积分兑换: 'cashback', 优惠: 'cashback',
  手续费: 'fee', 年费: 'fee', 服务费: 'fee', 短信服务费: 'fee', 短信费: 'fee', 违约金: 'fee',
  利息: 'interest', 透支利息: 'interest', 计息: 'interest', 取现: 'cash_advance', 预借现金: 'cash_advance',
  消费: 'purchase', 网上消费: 'purchase', 购物: 'purchase', 支付: 'purchase', 跨行二维码支付: 'purchase',
  调整: 'adjustment', 冲正: 'adjustment', 其他: 'adjustment',
}

// These labels are defined by the supported source formats. A merchant substring,
// or a word such as 优惠 in an ordinary name, is never a transaction-type token.
const SOURCE_PREFIX = /^(分期消费原始|分期原始|分期利息|分期手续费|分期扣款|每期入账|分期入账|商户分期|网上消费退货|网上消费|跨行二维码支付|信用卡还款|转账还款|多渠道还款|自助还款|网上还款|卡卡转账|费用返还|还款|退货|退款|退汇|刷卡金|返现|返还|手续费|年费|服务费|短信服务费|短信费|违约金|透支利息|利息|取现|预借现金|消费|购物|支付|调整|冲正|其他)(?=$|[\s:：\-－])/u

export function extractSourceTypeToken(description: string): string {
  return SOURCE_PREFIX.exec(description.trim())?.[1] ?? ''
}

/** Frozen pre-direction-first mapping, solely to reproduce existing fingerprints.
 * Even its purchase/payment fallbacks are opaque compatibility metadata, not a
 * business classification. Do not use its result outside identity storage.
 */
export function legacyTypeForIdentity(bankToken: string, direction: Direction): TransactionType {
  const token = bankToken.trim()
  let type = Object.hasOwn(TYPE_TOKENS, token) ? TYPE_TOKENS[token] : undefined
  if (type && type !== 'adjustment') {
    const creditType = type === 'payment' || type === 'refund' || type === 'cashback'
    if (creditType !== (direction === 'credit')) type = undefined
  }
  return type ?? (direction === 'debit' ? 'purchase' : 'payment')
}

export function signForDirection(minor: number, direction: Direction): number {
  return direction === 'debit' ? Math.abs(minor) : -Math.abs(minor)
}

export function directionForSignedAmount(minor: number): Direction {
  return minor < 0 ? 'credit' : 'debit'
}