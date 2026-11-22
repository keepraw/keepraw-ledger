/**
 * Synthetic ICBC e-mail statement (HTML).
 *
 * Mirrors the real template (GBK HTML, per-currency summary, balance table,
 * 7-column transaction table with 存入/支出 suffix) with invented data.
 *
 * Reconciliation: 5000.00 (previous) + 4100.00 (spending) - 3250.00 (income) = 5850.00
 * where 4100.00 = all debit rows minus the original installment purchase (900.00);
 * 分期扣款 300.00 counts as new spending.
 */

const rows = (cells: string[]): string => `<tr>${cells.map((cell) => `<td>${cell}</td>`).join('')}</tr>`

const TXN_HEADER = ['卡号后四位', '交易日', '记账日', '交易类型', '商户名称/城市', '交易金额/币种', '记账金额/币种']

export const SYNTHETIC_ICBC_HTML = `
<html>
  <body>
    <table>${rows(['工商银行信用卡 ICBC Peony Card 客户对账单'])}</table>
    <table>${rows(['账单周期 2026年07月15日—2026年08月14日', '对账单生成日 2026年08月15日'])}</table>
    <table>${rows(['贷记卡到期还款日 2026年09月08日'])}</table>
    <table>
      ${rows(['卡号后四位', '币种', '应还款额', '最低还款额', '信用额度'])}
      ${rows(['4321(牡丹贷记卡)', '人民币(本位币)', '5850.00/RMB', '585.00/RMB', '50000.00/RMB'])}
      ${rows(['合计', '人民币(本位币)', '5850.00/RMB', '585.00/RMB', '/'])}
    </table>
    <table>
      ${rows(['卡号后四位', '上期余额', '本期收入', '本期支出', '本期余额'])}
      ${rows(['---人民币(本位币)---'])}
      ${rows(['4321', '-5000.00/RMB', '3250.00/RMB', '4100.00/RMB', '-5850.00/RMB'])}
      ${rows(['合计', '-5000.00/RMB', '3250.00/RMB', '4100.00/RMB', '-5850.00/RMB'])}
    </table>
    <table>${rows(['人民币(本位币) 交 易 明 细'])}</table>
    <table>
      ${rows(TXN_HEADER)}
      ${rows(['---主卡明细---'])}
      ${rows(['4321', '2026-07-17', '2026-07-17', '转账', '手机银行还款转入', '3000.00/RMB', '3000.00/RMB(存入)'])}
      ${rows(['4321', '2026-08-14', '2026-08-14', '退款', '示例电商退款', '200.00/RMB', '200.00/RMB(存入)'])}
      ${rows(['4321', '2026-07-16', '2026-07-16', '商户分期', '商户分期-示例通讯-分3期', '900.00/RMB', '900.00/RMB(支出)'])}
      ${rows(['4321', '2026-07-16', '2026-07-16', '分期扣款', '1/3期-商户分期-示例通讯-分3期', '300.00/RMB', '300.00/RMB(支出)'])}
      ${rows(['4321', '2026-07-20', '2026-07-20', '消费', '示例餐厅-还款机具测试店', '68.00/RMB', '68.00/RMB(支出)'])}
      ${rows(['4321', '2026-07-22', '2026-07-22', '消费', '示例商城', '1200.00/RMB', '1200.00/RMB(支出)'])}
      ${rows(['4321', '2026-07-25', '2026-07-25', '消费', '示例生鲜', '86.50/RMB', '86.50/RMB(支出)'])}
      ${rows(['4321', '2026-08-02', '2026-08-02', '消费', '示例电商有限公司', '2200.00/RMB', '2200.00/RMB(支出)'])}
      ${rows(['4321', '2026-08-06', '2026-08-06', '消费', '示例出行', '34.20/RMB', '34.20/RMB(支出)'])}
      ${rows(['4321', '2026-08-09', '2026-08-09', '消费', '示例超市', '11.30/RMB', '11.30/RMB(支出)'])}
      ${rows(['4321', '2026-08-09', '2026-08-09', '消费', '示例超市', '100.00/RMB', '100.00/RMB(支出)'])}
      ${rows(['4321', '2026-08-09', '2026-08-09', '消费', '示例超市', '100.00/RMB', '100.00/RMB(支出)'])}
      ${rows(['4321', '2026-08-10', '2026-08-10', '刷卡金', '刷卡金入账-消费返现示例', '50.00/RMB', '50.00/RMB(存入)'])}
    </table>
    <table>${rows(['温馨提示：到期还款日（含）前未能全额偿还当期应还款项将按约定收取利息。'])}</table>
  </body>
</html>
`

export const SYNTHETIC_ICBC = {
  cardLast4: '4321',
  cycleStart: '2026-07-15',
  cycleEnd: '2026-08-14',
  dueDate: '2026-09-08',
  previousBalanceMinor: 500000,
  newCreditMinor: 325000,
  newDebitMinor: 410000,
  currentBalanceMinor: 585000,
  minimumPaymentMinor: 58500,
  creditTransactionCount: 3,
  debitTransactionCount: 10,
  installmentOriginalMinor: 90000,
  installmentPaymentMinor: 30000,
}
