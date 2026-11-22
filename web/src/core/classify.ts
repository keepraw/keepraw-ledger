import type { Category, Direction, TransactionType } from './types'

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

const PAYMENT_PREFIX = /^(?:支付宝|财付通|微信支付|微信|网银在线|银联|云闪付|网上消费|境外消费|跨境消费|消费)(?:[\s:：,，\-－–—/|｜]+|$)/iu

export function normalizedMerchant(description: string): string {
  let merchant = (description ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim()
  while (PAYMENT_PREFIX.test(merchant)) merchant = merchant.replace(PAYMENT_PREFIX, '').trim()
  return merchant.toLowerCase()
}

const CATEGORY_RULES: Array<{ category: Category; re: RegExp }> = [
  { category: '医疗健康', re: /(医院|健康|大药房|药房|药店|药业|医药|诊所|口腔|挂号|体检|clinic|pharmacy|health|iherb)/i },
  { category: '交通出行', re: /(uber|滴滴|taxi|地铁|公交|铁路|济铁|铁旅|高铁|12306|航空|机票|加油|中石化|中石油|停车|\betc\b|出行|metro|\bgas\b|flight|airlines?)/i },
  { category: '旅行', re: /(携程|飞猪|酒店|旅行社|旅行服务|住宿|民宿|去哪儿|同程|travel|hotel|airbnb|trip|booking\.com|agoda)/i },
  { category: '订阅服务', re: /(权益|会员|订阅|subscription|netflix|icloud|apple\.com|优酷|腾讯视频|爱奇艺|哔哩哔哩|spotify|openai|chatgpt|github|youtube)/i },
  { category: '餐饮', re: /(餐|food|restaurant|\btea\b|coffee|咖啡|茶|外卖|美团|饿了么|星巴克|瑞幸|麦当劳|肯德基|汉堡王|必胜客|海底捞|kitchen|dining|starbucks|mcdonald|\bkfc\b)/i },
  { category: '购物', re: /(商城|购物|超市|便利店|淘宝|天猫|京东|拼多多|商场|阿迪达斯|耐克|优衣库|沃尔玛|山姆|盒马|屈臣氏|amazon|taobao|\bjd\b|shop|ebay|walmart|costco|adidas|nike|uniqlo|shein|temu|aliexpress)/i },
  { category: '生活缴费', re: /(电费|水费|燃气|物业|话费|充值|移动|联通|电信|utility|水电)/i },
  { category: '教育', re: /(学费|书店|教育|培训|course|book)/i },
  { category: '住房', re: /(房租|租金|公寓|房贷|rent)/i },
  { category: '其他', re: /\bcrossmint\b/i },
]

export function inferCategory(description: string): Category {
  const text = normalizedMerchant(description)
  for (const rule of CATEGORY_RULES) {
    if (rule.re.test(text)) return rule.category
  }
  return '未分类'
}

export function signForDirection(minor: number, direction: Direction): number {
  return direction === 'debit' ? Math.abs(minor) : -Math.abs(minor)
}

export function directionForSignedAmount(minor: number): Direction {
  return minor < 0 ? 'credit' : 'debit'
}