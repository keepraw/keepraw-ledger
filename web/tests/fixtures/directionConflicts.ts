import { SYNTHETIC_CCB_HTML } from './ccbEml'
import { SYNTHETIC_CITIC_HTML } from './citicEml'
import { SYNTHETIC_BOCOM_HTML } from './bocomEml'
import { SYNTHETIC_ICBC_HTML } from './icbcEml'
import { buildSyntheticBocPdf } from './bocPdf'
import type { Direction } from '../../src/core/types'

// All amounts, descriptions and accounts are synthetic. Expected signs are
// literal references rather than values derived from the parser under test.
const ccbSixColumns = SYNTHETIC_CCB_HTML.replace(
  /<td>CNY<\/td><td>(-?\d+\.\d{2})<\/td><td>CNY<\/td><td>(-?\d+\.\d{2})<\/td>/g,
  '<td>$1/CNY</td><td>$2/CNY</td>',
)

function htmlCase(id: string, bank: string, source: string, before: string, after: string,
  description: string, direction: Direction, transactionAmountMinor: number, settlementAmountMinor: number,
  rawSigns: string[], count: number) {
  if (!source.includes(before)) throw new Error(`Synthetic conflict fixture not found: ${id}`)
  return { id, bank, html: source.replace(before, after), description, direction,
    transactionAmountMinor, settlementAmountMinor, rawSigns, count }
}

export const BANK_SIGN_CONFLICTS = [
  htmlCase('ccb-eight-original-minus', 'ccb', SYNTHETIC_CCB_HTML,
    '<td>CNY</td><td>68.00</td><td>CNY</td><td>68.00</td>', '<td>CNY</td><td>-68.00</td><td>CNY</td><td>68.00</td>',
    '示例餐厅-消费测试店', 'debit', -6800, 6800, ['-68.00', '68.00'], 14),
  htmlCase('ccb-eight-settlement-minus', 'ccb', SYNTHETIC_CCB_HTML,
    '<td>CNY</td><td>68.00</td><td>CNY</td><td>68.00</td>', '<td>CNY</td><td>68.00</td><td>CNY</td><td>-68.00</td>',
    '示例餐厅-消费测试店', 'credit', 6800, -6800, ['68.00', '-68.00'], 14),
  htmlCase('ccb-six-original-parentheses', 'ccb', ccbSixColumns,
    '<td>68.00/CNY</td><td>68.00/CNY</td>', '<td>(68.00)/CNY</td><td>68.00/CNY</td>',
    '示例餐厅-消费测试店', 'debit', -6800, 6800, ['(68.00)/CNY', '68.00/CNY'], 14),
  htmlCase('ccb-six-settlement-minus', 'ccb', ccbSixColumns,
    '<td>68.00/CNY</td><td>68.00/CNY</td>', '<td>68.00/CNY</td><td>-68.00/CNY</td>',
    '示例餐厅-消费测试店', 'credit', 6800, -6800, ['68.00/CNY', '-68.00/CNY'], 14),
  htmlCase('citic-original-minus', 'citic', SYNTHETIC_CITIC_HTML,
    '<td>CNY 1200.00</td><td>CNY 1200.00</td>', '<td>CNY -1200.00</td><td>CNY 1200.00</td>',
    '财付通－示例餐厅', 'debit', -120000, 120000, ['CNY -1200.00', 'CNY 1200.00'], 5),
  htmlCase('citic-settlement-minus', 'citic', SYNTHETIC_CITIC_HTML,
    '<td>CNY 1200.00</td><td>CNY 1200.00</td>', '<td>CNY 1200.00</td><td>CNY -1200.00</td>',
    '财付通－示例餐厅', 'credit', 120000, -120000, ['CNY 1200.00', 'CNY -1200.00'], 5),
  htmlCase('bocom-debit-original-minus', 'bocom', SYNTHETIC_BOCOM_HTML,
    '<td>CNY 68.00</td><td>CNY 68.00</td>', '<td>CNY -68.00</td><td>CNY 68.00</td>',
    '消费 支付宝-示例餐厅', 'debit', -6800, 6800, ['CNY -68.00', 'CNY 68.00'], 14),
  htmlCase('bocom-debit-settlement-minus', 'bocom', SYNTHETIC_BOCOM_HTML,
    '<td>CNY 68.00</td><td>CNY 68.00</td>', '<td>CNY 68.00</td><td>CNY -68.00</td>',
    '消费 支付宝-示例餐厅', 'debit', 6800, -6800, ['CNY 68.00', 'CNY -68.00'], 14),
  htmlCase('bocom-credit-original-minus', 'bocom', SYNTHETIC_BOCOM_HTML,
    '<td>CNY 3000.00</td><td>CNY 3000.00</td>', '<td>CNY -3000.00</td><td>CNY 3000.00</td>',
    '信用卡还款 转账还款-示例银行-张示例 尾号1234', 'credit', -300000, 300000, ['CNY -3000.00', 'CNY 3000.00'], 14),
  htmlCase('bocom-credit-settlement-minus', 'bocom', SYNTHETIC_BOCOM_HTML,
    '<td>CNY 3000.00</td><td>CNY 3000.00</td>', '<td>CNY 3000.00</td><td>CNY -3000.00</td>',
    '信用卡还款 转账还款-示例银行-张示例 尾号1234', 'credit', 300000, -300000, ['CNY 3000.00', 'CNY -3000.00'], 14),
  htmlCase('bocom-debit-both-minus', 'bocom', SYNTHETIC_BOCOM_HTML,
    '<td>CNY 68.00</td><td>CNY 68.00</td>', '<td>CNY -68.00</td><td>CNY -68.00</td>',
    '消费 支付宝-示例餐厅', 'debit', -6800, -6800, ['CNY -68.00', 'CNY -68.00'], 14),
  htmlCase('icbc-marked-debit-original-minus', 'icbc', SYNTHETIC_ICBC_HTML,
    '<td>68.00/RMB</td><td>68.00/RMB(支出)</td>', '<td>-68.00/RMB</td><td>68.00/RMB(支出)</td>',
    '示例餐厅-还款机具测试店', 'debit', -6800, 6800, ['-68.00/RMB', '68.00/RMB(支出)'], 13),
  htmlCase('icbc-conflicting-direction-marks', 'icbc', SYNTHETIC_ICBC_HTML,
    '<td>68.00/RMB</td><td>68.00/RMB(支出)</td>', '<td>68.00/RMB(支出)</td><td>68.00/RMB(存入)</td>',
    '示例餐厅-还款机具测试店', 'credit', 6800, 6800, ['68.00/RMB(支出)', '68.00/RMB(存入)'], 13),
]

export function bocAmountColumns(debitText: string, creditText: string | null, reverse = false) {
  const pdf = buildSyntheticBocPdf()
  const page = pdf.pages[1]!
  const debit = page.items.find(item => item.text === '152.00')!
  debit.text = debitText
  if (creditText !== null) page.items.push({ ...debit, text: creditText, x: 423 })
  if (reverse) page.items.reverse()
  return pdf
}
