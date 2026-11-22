import type { PdfDocument, PdfPage } from '../../src/parsers/types'

/**
 * Synthetic Bank of China PDF layout.
 *
 * Every value here is invented for tests: no real statement data is used.
 * The geometry mirrors the real template (column positions, wrapped merchant lines,
 * a split `C` + `HN` currency marker) so the layout-sensitive code is exercised.
 */

interface ItemSpec {
  text: string
  x: number
  y: number
  width: number
}

const COL = {
  transactionDate: 42,
  postingDate: 135,
  card: 241,
  description: 300,
  deposit: 422,
  expenditure: 515,
}

function item(text: string, x: number, y: number, width = text.length * 6): ItemSpec {
  return { text, x, y, width }
}

function page(number: number, items: ItemSpec[]): PdfPage {
  return {
    pageNumber: number,
    width: 595,
    height: 842,
    items: items.map((spec) => ({
      text: spec.text,
      x: spec.x,
      y: spec.y,
      width: spec.width,
      height: 10,
    })),
  }
}

export function buildSyntheticBocPdf(coordinates: 'top-down' | 'bottom-up' = 'bottom-up'): PdfDocument {
  const summaryPage = page(1, [
    item('中国银行信用卡账单(2026年09月)', 181, 742, 232),
    item('BOC Credit Card Billing Statement(2026-09)', 140, 719, 314),
    item('账单信息总览/Account Summary', 17, 592, 236),
    item('到期还款日', 67, 556, 40),
    item('Payment Due Date', 51, 543, 72),
    item('账单日', 215, 556, 24),
    item('Statement Closing Date', 182, 543, 91),
    item('本期人民币欠款总计', 331, 556, 72),
    item('Current RMB Total Balance Due', 307, 543, 121),
    item('2026-09-24', 65, 519, 44),
    item('2026-09-04', 205, 519, 44),
    item('600.00', 357, 519, 21),
    item('卡号', 65, 444, 16),
    item('Credit Card No.', 43, 428, 60),
    item('本期应还款额New Balance', 176, 444, 131),
    item('本期最小还款Minimum Payment due', 380, 444, 171),
    item('6259 0737 **** 6505', 34, 411, 78),
    item('600.00', 175, 411, 21),
    item('60.00', 399, 411, 21),
    item('测试白金信用卡(卡号：6505)', 17, 363, 196),
    item('账号类型', 48, 304, 32),
    item('Account Type', 38, 291, 52),
    item('上期存款/欠款余额', 123, 304, 67),
    item('Previous Balance', 125, 291, 64),
    item('本期支出金额', 227, 316, 48),
    item('Purchase', 242, 287, 14),
    item('本期存入金额', 320, 316, 48),
    item('Payments', 335, 287, 15),
    item('本期存款/欠款余额', 403, 304, 67),
    item('New Balance', 413, 291, 49),
    item('人民币/RMB', 41, 244, 45),
    item('欠款/DEBT 5000.00', 121, 244, 72),
    item('1200.00', 235, 244, 30),
    item('5600.00', 329, 244, 30),
    item('欠款/DEBT 600.00', 406, 244, 62),
    item('人民币交易明细/RMB Transaction Detailed List', 17, 164, 283),
    item('第 1 页/共 2 页', 272, 5, 69),
  ])

  const detailPage = page(2, [
    item('卡号后四位', 231, 717, 40),
    item('交易日', 52, 706, 24),
    item('银行记账日', 137, 706, 40),
    item('Last Four', 232, 706, 35),
    item('交易描述', 328, 706, 32),
    item('存入', 429, 706, 16),
    item('Deposit', 422, 693, 30),
    item('支出', 523, 706, 16),
    item('Expenditure', 508, 693, 46),
    item('Digits', 238, 689, 22),
    item('of Card Number', 219, 675, 62),

    // Row 1: currency marker split across two text runs.
    item('微信-示例咖啡店C', COL.description, 643, 110),
    item('2026-08-06', COL.transactionDate, 633, 44),
    item('2026-08-07', COL.postingDate, 633, 44),
    item('6505', COL.card, 633, 19),
    item('48.00', COL.expenditure + 5, 633, 21),
    item('HN', COL.description + 38, 630, 12),

    // Row 2: plain description.
    item('2026-08-08', COL.transactionDate, 606, 44),
    item('2026-08-09', COL.postingDate, 606, 44),
    item('6505', COL.card, 606, 19),
    item('示例超市-东门店', COL.description, 606, 92),
    item('152.00', COL.expenditure + 4, 606, 26),

    // Row 3: wrapped merchant name.
    item('示例超市-西门店', COL.description, 588, 92),
    item('2026-08-08', COL.transactionDate, 578, 44),
    item('2026-08-09', COL.postingDate, 578, 44),
    item('6505', COL.card, 578, 19),
    item('1000.00', COL.expenditure + 1, 578, 30),
    item('（测试）', COL.description + 36, 575, 30),

    // Row 4: repayment.
    item('2026-08-12', COL.transactionDate, 551, 44),
    item('2026-08-12', COL.postingDate, 551, 44),
    item('6505', COL.card, 551, 19),
    item('网银转账-还款', COL.description, 551, 84),
    item('3000.00', COL.deposit + 1, 551, 30),

    // Row 5 and 6: same day, same merchant, same amount - two real purchases.
    item('2026-08-15', COL.transactionDate, 535, 44),
    item('2026-08-16', COL.postingDate, 535, 44),
    item('6505', COL.card, 535, 19),
    item('示例商户A', COL.description, 535, 60),
    item('1000.00', COL.deposit + 2, 535, 30),

    item('2026-08-15', COL.transactionDate, 519, 44),
    item('2026-08-16', COL.postingDate, 519, 44),
    item('6505', COL.card, 519, 19),
    item('示例商户A-门店2', COL.description, 519, 92),
    item('1000.00', COL.deposit + 2, 519, 30),

    // Row 7.
    item('2026-08-18', COL.transactionDate, 503, 44),
    item('2026-08-19', COL.postingDate, 503, 44),
    item('6505', COL.card, 503, 19),
    item('示例商户B', COL.description, 503, 60),
    item('600.00', COL.deposit + 4, 503, 30),
  ])

  const pages = [summaryPage, detailPage]
  if (coordinates === 'top-down') {
    for (const page of pages) {
      for (const item of page.items) item.y = page.height - item.y
    }
  }
  return { numPages: 2, pages }
}

/** Expected figures for the synthetic statement above. */
export const SYNTHETIC_BOC = {
  cardLast4: '6505',
  cycleStart: '2026-08-05',
  cycleEnd: '2026-09-04',
  dueDate: '2026-09-24',
  previousBalanceMinor: 500000,
  newDebitMinor: 120000,
  newCreditMinor: 560000,
  currentBalanceMinor: 60000,
  minimumPaymentMinor: 6000,
  transactionCount: 7,
}