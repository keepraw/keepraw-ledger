import type { Category, Direction, TransactionType } from './types'

/** Authoritative bank tokens and explicit, delimited source-format prefixes only. */
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

export function classifyTransactionType(bankToken: string, direction: Direction, amountMinor?: number): {
  type: TransactionType
  requiresReview: boolean
} {
  const token = bankToken.trim()
  let type = Object.hasOwn(TYPE_TOKENS, token) ? TYPE_TOKENS[token] : undefined
  let requiresReview = !type && (token.length > 0 || direction === 'credit')
  if (type && type !== 'adjustment') {
    const creditType = type === 'payment' || type === 'refund' || type === 'cashback'
    if (creditType !== (direction === 'credit')) { type = undefined; requiresReview = true }
  }
  if (amountMinor !== undefined && amountMinor !== 0 && (amountMinor < 0) !== (direction === 'credit')) requiresReview = true
  return { type: type ?? (direction === 'debit' ? 'purchase' : 'payment'), requiresReview }
}

export function inferTransactionType(bankToken: string, _description: string, direction: Direction): TransactionType {
  return classifyTransactionType(bankToken, direction).type
}

/** Business types that increase the card balance. */
export const DEBIT_TYPES: ReadonlySet<TransactionType> = new Set<TransactionType>([
  'purchase',
  'cash_advance',
  'fee',
  'interest',
  'installment_payment',
])

/**
 * Installment bookkeeping: some banks show both the original purchase and the
 * per-instalment posting in the same cycle. Summing both double counts spending,
 * so only `installment_payment` counts as real new spending.
 */
export const SPENDING_TYPES: ReadonlySet<TransactionType> = new Set<TransactionType>(['purchase', 'cash_advance'])

const CATEGORY_RULES: Array<{ category: Category; re: RegExp }> = [
  { category: '餐饮', re: /(餐|food|restaurant|餐饮|food|tea|coffee|咖啡|茶|外卖|美团饿了么|kitchen|dining)/i },
  { category: '交通出行', re: /(uber|滴滴|taxi|地铁|公交|加油|中石化|中石油|停车|高铁|12306|出行|metro|gas|flight|机票)/i },
  { category: '购物', re: /(商城|购物|超市|便利店|淘宝|天猫|京东|拼多多|商场|amazon|taobao|jd|shop)/i },
  { category: '生活缴费', re: /(电费|水费|燃气|物业|话费|充值|utility|水电)/i },
  { category: '医疗健康', re: /(医院|药房|药店|医药|挂号|clinic|pharmacy|health)/i },
  { category: '教育', re: /(学费|书店|教育|培训|course|book)/i },
  { category: '住房', re: /(房租|租金|公寓|房贷|rent)/i },
  { category: '旅行', re: /(携程|酒店|旅行社|住宿|travel|hotel|airbnb|trip)/i },
  { category: '订阅服务', re: /(会员|订阅|subscription|netflix|icloud|优酷|腾讯视频|爱奇艺)/i },
]

export function inferCategory(description: string, type: TransactionType): Category {
  if (type === 'payment') return '还款'
  if (type === 'refund') return '退款'
  const text = description ?? ''
  for (const rule of CATEGORY_RULES) {
    if (rule.re.test(text)) return rule.category
  }
  if (type === 'purchase' || type === 'installment_payment' || type === 'installment_original') return '未分类'
  return '其他'
}

/** Extract a merchant-ish label from a raw bank description. */
export function extractMerchant(description: string): string {
  const text = (description ?? '').trim()
  if (!text) return ''
  const withoutPrefix = text.replace(/^(消费|取现|还款|退款|退货|返现|手续费|利息|调整|刷卡金)\s*/, '')
  const parts = withoutPrefix.split(/[-–—:：]/).filter(Boolean)
  const candidate = parts.length > 1 ? parts.slice(1).join('-') : withoutPrefix
  return candidate.length > 40 ? candidate.slice(0, 40) : candidate
}

export function signForDirection(minor: number, direction: Direction): number {
  return direction === 'debit' ? Math.abs(minor) : -Math.abs(minor)
}

export function directionForSignedAmount(minor: number): Direction {
  return minor < 0 ? 'credit' : 'debit'
}