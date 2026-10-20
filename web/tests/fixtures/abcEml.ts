/**
 * Synthetic ABC e-mail statement (HTML).
 *
 * Mirrors the real 金穗信用卡 template (section markers ● 还款/消费/退货,
 * 6-column MMDD dates, AMT/CURR with 支出为-) with invented data.
 *
 * Reconciliation: 3000.00 (previous) + 6500.00 (new charge) - 7200.00 (payments) = 2300.00
 * where 6500.00 = all debit rows minus the original installment purchase (900.00);
 * 分期扣款 300.00 counts as new spending.
 */

const rows = (cells: string[]): string => `<tr>${cells.map((cell) => `<td>${cell}</td>`).join('')}</tr>`

export const SYNTHETIC_ABC_HTML = `
<html>
  <body>
    <table>${rows(['尊敬的示例先生: 感谢您一直以来对金穗信用卡的支持。中国农业银行'])}</table>
    <table>${rows(['卡号 Card No', '622800******9876'])}</table>
    <table>${rows(['账单周期 Statement Cycle', '2026/07/15-2026/08/14'])}</table>
    <table>${rows(['到期还款日 Payment Due Date', '2026/09/08'])}</table>
    <table>${rows(['本期应还款额(欠款为-) New Balance'])}</table>
    <table>${rows(['人民币(CNY)', '2300.00'])}</table>
    <table>${rows(['信用额度 Credit Limit', '20000.00'])}</table>
    <table>
      ${rows(['币种 Curr', '本期应还金额 New Balance', '-', '本期账户 溢缴款 Deposit', '=', '上期账单 应还金额 Previous Balance', '-', '上期账户 溢缴款 Previous Deposit', '+', '本期账单金额 New Charge', '-', '本期还款、退货金额 Payments', '-', '本期调整金额 Adjustment'])}
    </table>
    <table>
      ${rows(['CNY', '2300.00', '-', '0.00', '=', '3000.00', '-', '0.00', '+', '6500.00', '-', '7200.00', '-', '0.00'])}
    </table>
    <table>${rows(['交易明细', ''])}</table>
    <table>
      ${rows(['交易日期 T Date', '入账日期 P Date', '卡号 后四位 Card No.', '交易描述 Description', '交易金额/币种 Tran Amt/Curr', '入账金额/币种 (支出为-) Sett Amt/Curr'])}
    </table>
    <table>${rows(['', '●', '还款'])}</table>
    <table>
      ${rows(['0717', '0717', '9876', '还款 卡卡转账', '3000.00/CNY', '3000.00/CNY'])}
    </table>
    <table>${rows(['', '●', '消费'])}</table>
    <table>
      ${rows(['0716', '0716', '9876', '商户分期-示例通讯-分3期', '900.00/CNY', '-900.00/CNY'])}
      ${rows(['0716', '0716', '9876', '分期扣款 1/3期-商户分期-示例通讯', '300.00/CNY', '-300.00/CNY'])}
      ${rows(['0720', '0720', '9876', '网上消费 示例餐厅', '68.00/CNY', '-68.00/CNY'])}
      ${rows(['0722', '0722', '9876', '网上消费 示例商城', '1200.00/CNY', '-1200.00/CNY'])}
      ${rows(['0725', '0725', '9876', '网上消费 示例生鲜', '86.50/CNY', '-86.50/CNY'])}
      ${rows(['0802', '0802', '9876', '网上消费 示例电商有限公司', '2400.00/CNY', '-2400.00/CNY'])}
      ${rows(['0802', '0802', '9876', '网上消费 示例电商有限公司', '1800.00/CNY', '-1800.00/CNY'])}
      ${rows(['0806', '0806', '9876', '网上消费 示例出行', '34.20/CNY', '-34.20/CNY'])}
      ${rows(['0809', '0809', '9876', '网上消费 示例超市', '411.30/CNY', '-411.30/CNY'])}
      ${rows(['0809', '0809', '9876', '网上消费 示例超市', '100.00/CNY', '-100.00/CNY'])}
      ${rows(['0809', '0809', '9876', '网上消费 示例超市', '100.00/CNY', '-100.00/CNY'])}
    </table>
    <table>${rows(['', '●', '退货'])}</table>
    <table>
      ${rows(['0814', '0814', '9876', '网上消费退货 示例电商', '2400.00/CNY', '2400.00/CNY'])}
      ${rows(['0814', '0814', '9876', '网上消费退货 示例电商', '1800.00/CNY', '1800.00/CNY'])}
    </table>
    <table>${rows(['可用刷卡金余额', '0.00'])}</table>
  </body>
</html>
`

export const SYNTHETIC_ABC = {
  cardLast4: '9876',
  cycleStart: '2026-07-15',
  cycleEnd: '2026-08-14',
  dueDate: '2026-09-08',
  previousBalanceMinor: 300000,
  newCreditMinor: 720000,
  newDebitMinor: 650000,
  currentBalanceMinor: 230000,
  creditTransactionCount: 3,
  debitTransactionCount: 11,
  installmentOriginalMinor: 90000,
  installmentPaymentMinor: 30000,
  totalDebitRowsMinor: 740000,
}

/** Synthetic year-boundary statement in the same six-column ABC layout. */
export const CROSS_YEAR_ABC_HTML = `<html><body>
<table>${rows(['中国农业银行金穗信用卡', '622800******9876'])}</table>
<table>${rows(['账单周期 Statement Cycle', '2025/12/15-2026/01/14'])}</table>
<table>${rows(['本期应还金额', '上期账单 应还金额', '本期账单金额', '本期还款'])}</table>
<table>${rows(['300.00', '0.00', '300.00', '0.00'])}</table>
<table>${rows(['交易日期', '入账日期', '卡号', '交易描述', '交易金额', '入账金额'])}
${rows(['● 消费'])}
${rows(['12/20', '1221', '9876', '网上消费 December', '100.00/CNY', '-100.00/CNY'])}
${rows(['0105', '01/06', '9876', '网上消费 January', '200.00/CNY', '-200.00/CNY'])}
</table></body></html>`
