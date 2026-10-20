# EML 账单结构分析（脱敏）

> 本报告仅记录 HTML 表格结构、字段名称与解析策略，不包含任何真实卡号、金额、商户、日期与客户信息。
> 真实 EML 仅在本地解析验证，未提交、未复制为 fixture、未上传。

## 1. 通用 MIME 与编码

| 银行 | Subject（银行标识） | From | MIME 结构 | HTML 编码 |
| --- | --- | --- | --- | --- |
| 工商银行 ICBC | `中国工商银行客户对账单(ICBC Peony Card Bank Statement)` | `webmaster@icbc.com.cn` | `multipart/mixed` / `text/html` + `quoted-printable` | GBK 解码（`gbk`/`gb18030` 回退 `utf-8`） |
| 建设银行 CCB | `中国建设银行信用卡电子账单` | `service@vip.ccb.com` | `multipart/mixed` / `text/html` + `base64` | UTF-8 |
| 农业银行 ABC | `中国农业银行金穗信用卡电子对账单` | `e-statement@creditcard.abchina.com.cn` | 单体 `text/html` + `base64` | UTF-8 |

解析链路复用现有 `extract.ts` → `postal-mime` → `sanitizeHtml` → `extractTables` → `extractText`。
`sanitizeHtml` 移除 `script/style/img/iframe` 与事件属性后，`extractTables` 按 innermost-table 归属输出 document-order 行流。

## 2. 银行识别（`match`）

三家均使用 Subject + From + 正文关键词三元组，不使用万能 regex：

- ICBC：`工商银行|ICBC|Peony Card` ＋ `客户对账单|Bank Statement` ＋ `账单周期|交易明细`
- CCB：`建设银行|China Construction Bank|CCB` ＋ `龙卡信用卡|信用卡电子账单` ＋ `账单周期Statement Cycle`
- ABC：`农业银行|Agricultural Bank|ABChina` ＋ `金穗信用卡` ＋ `账单周期Statement Cycle`

`match` 返回 `1`（三元全中）或 `0.8`（银行＋周期），否则 `0`。`sourceTypes` 均为 `['eml','html']`。

## 3. 工商银行 ICBC

### 3.1 周期与到期日

- 周期行：`账单周期 YYYY年MM月DD日—YYYY年MM月DD日`，另有 `对账单生成日 YYYY年MM月DD日`。
- 到期日：`贷记卡到期还款日 YYYY年MM月DD日`（正文文本，非表格值单元格）。
- 策略：优先中文 `年/月/日＋—` 正则，回退 `YYYY/MM/DD-YYYY/MM/DD`。

### 3.2 卡尾号

- 汇总表首列形如 `NNNN(牡丹贷记卡)`，交易表首列为独立 `NNNN` 四位单元格。
- 策略：汇总表提取 `(\d{4})`，交易行按列位置回退到语句级卡号。

### 3.3 汇总表

- 还款明细表（5 列）：`卡号后四位 | 币种 | 应还款额 | 最低还款额 | 信用额度`，数据行按币种（人民币本位币）取值，`/` 或 `-` 视为空。
- 余额表（5 列）：`卡号后四位 | 上期余额 | 本期收入 | 本期支出 | 本期余额`，含 `---人民币(本位币)---` 分组行需跳过。
- 映射：`previousBalance=上期余额`，`newCredit=本期收入`，`newDebit=本期支出`，`currentBalance=本期余额`，`minimumPayment/creditLimit` 取自还款明细表。
- 对账方程：`本期余额 = 上期余额 + 本期支出 - 本期收入`，与 `reconcile.ts balance_equation` 一致。

### 3.4 交易表

- 定位：含 `卡号后四位＋交易日＋记账日＋交易类型＋商户名称＋交易金额＋记账金额`（≥5 中）即为交易表。
- 表头（7 列）：`卡号后四位 | 交易日 | 记账日 | 交易类型 | 商户名称/城市 | 交易金额/币种 | 记账金额/币种`。
- 分组行：单列 `---主卡明细---` / `---副卡明细---`，仅切换上下文，不产生交易。
- 数据行（7 列）：`CARD4 | ISO-DATE | ISO-DATE | 交易类型 | 商户原文 | AMT/CURR | AMT/CURR(存入/支出)`。
- 金额形如 `123.45/RMB`，记账列带方向后缀 `(...(存入))` / `(...(支出))`。
- 方向：严格使用记账金额后缀（`存入→credit`，`支出→debit`），缺失时回退到交易类型列（银行结构化 token），绝不使用商户文本。
- 类型 token 取自交易类型列首词（消费/转账/退款/刷卡金/取现/利息/手续费等），经 `inferTransactionType(token, remainder, direction)` 分类。`刷卡金→cashback`，`退款/退货→refund`，裸 `转账` 在 credit 下回退为 `payment`。
- 金额：`parseAmountToMinor` 得 magnitude，`signForDirection(mag, direction)` 得 signed minor units，全程整数分，无 float。
- 清洗：`rawDescription` 保留商户原文；`description` 折叠空白、去尾部 ` /`；`merchant` 截断 40 字。`rawDescription` 永不覆盖。

## 4. 建设银行 CCB

### 4.1 周期与到期日

- `账单周期Statement Cycle YYYY/MM/DD-YYYY/MM/DD`，`本期到期还款日Payment Due Date YYYY/MM/DD`。
- 策略：中英双语标签正则，`parseDateInput` 直接解析 ISO。

### 4.2 卡尾号

- 应还款明细表首列为掩码卡号（含 `***`＋后四位），交易表第三列为独立 `NNNN`。
- 策略：掩码正则 `\*+(\d{4})` 优先，交易行按列回退。

### 4.3 汇总表

- 方程块（8 列头）：`账户币种 | 上期全部应还款额 | + | 消费/取现/其它费用 | - | 还款/退货/费用返还 | = | 本期全部应还款额`，值行按币种（人民币CNY）为 5 列 `币种 | 上期 | 新增支出 | 还款返还 | 本期`。
- 账单信息表（4 列）：`账单周期 | DATE | 到期还款日 | DATE` 与 `账户币种 | 本期全部应还款额 | 最低还款额 | 争议款`，提供 `minimumPayment` 与交叉校验。
- 应还款明细表（7 列）：`信用卡卡号 | 账户币种 | 应还款额/溢缴款 | 最低还款额 | …`，用于卡号与余额复核。
- 说明：`应还款额/溢缴款为负数表示溢缴款；金额前带-的交易表示还款/调整`，即交易金额 `-` 前缀即方向。
- 映射：`previous=上期全部`，`newDebit=消费/取现/其它费用`，`newCredit=还款/退货/费用返还`，`current=本期全部`。

### 4.4 交易表

- 定位：`交易日＋银行记账日＋卡号后四位＋交易描述＋交易币/金额＋结算币/金额`（≥5 中）。
- 结构：标题行 `【交易明细】`（1 列）→ 中文头（6 列）→ 英文头 `T-Date|P-Date|…`（6 列）→ 账户分组行 `[人民币账户] RMB Account | 上期账单余额 | AMT`（3 列）→ 数据行（8 列）→ 结束行 `*** 结束 The End ***`（1 列）。
- 数据行（8 列）：`ISO-DATE | ISO-DATE | CARD4 | 描述原文 | CURR | AMT(signed) | CURR | AMT(signed)`，货币与金额分列，金额 `-` 前缀即 credit。
- 方向：金额 `-` 前缀（结构化金额字段），绝不使用商户文本。结算列符号为准，交易列应一致。
- 类型：描述无统一前缀，`bankToken` 仅取行首结构化词（若有），否则空，经 `inferTransactionType` 回退到方向（`debit→purchase`，`credit→payment`）。`payment/refund/cashback` 均计入 `credit_detail`，误分不影响对账。
- 金额：`parseAmountToMinor` 解析 signed 金额，`signForDirection` 归一化，整数分。
- 分期：`专项分期剩余总金额` 仅作提示（`warnings: installment_plans` 风格），交易侧以 `分期` token 识别 `installment_payment`，原购若出现则标 `installment_original` 且不计入 `newDebit`（`reconcile` 已排除）。

## 5. 农业银行 ABC

### 5.1 周期与到期日

- `账单周期 Statement Cycle YYYY/MM/DD-YYYY/MM/DD`，`到期还款日 Payment Due Date YYYY/MM/DD`，均为两列表（标签＋日期）。
- 策略：双语标签＋ISO 正则。

### 5.2 卡尾号

- `卡号 Card No NNNNNN******NNNN` 掩码，交易表第三列独立 `NNNN`。
- 策略：掩码取后四位，交易行按列回退。

### 5.3 汇总表

- 方程头（14 列）：`币种 | 本期应还金额 | - | 本期账户溢缴款 | = | 上期账单应还金额 | - | 上期账户溢缴款 | + | 本期账单金额 | - | 本期还款、退货金额 | - | 本期调整金额`，值行在紧随的同形表中（金额＋`-/=/+` 运算符交替）。
- 映射：`current=本期应还金额`，`previous=上期账单应还金额`，`newDebit=本期账单金额`，`newCredit=本期还款、退货金额`，`adjustment` 计入备注（`reconcile` 的 `adjustment` 类型在借贷两侧均可计入，视方向而定）。
- 辅助：`本期应还款额(欠款为-) New Balance`（标签＋金额两列表）与 `信用额度 Credit Limit` 用于交叉校验与 `minimumPayment`（若缺失则置空并告警）。
- 注意：ABC 账单以 `支出为-` 标注结算列，即结算金额负数表支出，与本项目 `debit正/credit负` 相反，解析时经 `signForDirection` 归一化后再对账。

### 5.4 交易表

- 定位：`交易日期＋入账日期＋卡号后四位＋交易描述＋交易金额/币种＋入账金额/币种(支出为-)`（6 列）。
- 结构：标题 `交易明细`（1-2 列）→ 列头（6 列）→ 分节标记行（3 列，形如 `● 还款 / ● 消费 / ● 退货 / ● 取现 / ● 费用 / ● 利息`）→ 各节数据表（每节一表，每行 6 列）。
- 数据行（6 列）：`DATE | DATE | CARD4 | 描述原文 | AMT/CURR | AMT/CURR(signed)`，日期为 `YYMMDD` 或 `MMDD` 紧凑格式（无分隔符），金额为 `金额/币种`（如 `123.45/CNY`），结算列 `支出为-`（负数＝支出）。
- 日期：`YYMMDD` 直接展开为 `20YY-MM-DD`；`MMDD` 经周期年份消解（优先落入周期内的年份，跨年周期正确处理），兼容 `MM/DD` 与 ISO 回退。
- 方向：分节标记行（银行结构）优先，结算列符号佐证，绝不使用商户文本。`还款/退货→credit`，`消费/取现→debit`，费用/利息按节归属。
- 类型：描述首词作 `bankToken`（如网上消费/退货/转账/取现/手续费/利息），经 `inferTransactionType` 分类；节标记与方向一致时优先节语义。
- 金额：交易列 magnitude＋结算列 signed magnitude 分别解析，`signForDirection` 归一化为项目符号约定后，双列分别存 `transactionAmountMinor / settlementAmountMinor`，对账以结算列为准。
- 刷卡金：`可用刷卡金余额/上期可用/本期新增/本期使用` 仅作提示，不计交易；若交易描述以 `刷卡金` 开头则按 `cashback` 计入 credit。
- 方程值行存在两种压缩形态：14 列完整行（含 `-`/`=`/`+` 运算符）与 8 列压缩行（`币种/应还/溢缴/上期/上期溢缴/账单/还款/调整`）；解析器按列数分别映射。净余额按 `应还-溢缴` 计算后交共享对账器。

## 6. 特殊账务与去重

- 消费/还款/退款/返现/手续费/利息/分期原购/分期入账均经 `TransactionType` 区分，符号经方向归一化，不经商户名猜测。
- 同一周期内若同时出现分期原购与本期扣款，仅 `installment_payment` 计入 `newDebit`（`reconcile.ts: SPENDING_DETAIL_TYPES` 与 `detailCheck` 已排除 `installment_original`；`summarizeTransactions` 同）。
- 去重沿用 `ingest.ts`：文件 `SHA-256` 短路＋`statementKey(bank,card,cycle)`＋`transactionFingerprint＋occurrence`，同日同商户同金额多笔保留多行，仅 `suspected_duplicate` 标记复核。

## 7. 清洗三层结构

- `rawDescription`：表格原文（仅空白折叠），永久保留。
- `description`：去 HTML 换行、多余空格、尾部 ` /` 与无意义符号（如 `财付通 /→财付通`），保留内部 `/`。
- `merchant`：`description` 截断 40 字（`extractMerchant` 风格），不含卡号与金额。

## 8. 已知限制

- ICBC 副卡分组行仅切换上下文，不分卡对账；多币种时仅人民币参与 `reconcile`，外币行保留交易但不计入 CNY 汇总。
- CCB 美元/欧元方程行已解析但 `reconcile` 以首币种（CNY）为准；英文头与账户分组行跳过，若银行新增列需更新列索引断言。
- ABC 紧凑日期依赖周期年份消解；无周期时日期置空并告警，不猜年份。
- ABC `本期调整金额` 在明细表中无对应行：明细合计（`debit_detail` / `credit_detail`）仍通过，但余额方程差额恰为调整金额时语句进入 `needs_review`（验收用例对此断言，不视为解析失败）。
- 三家分期计划表均不如 BOCOM 结构化，原购标记依赖交易类型 token；若银行仅展示扣款而无原购，不产生 `installment_original`，对账仍通过。

## 9. AUD-010：有符号账户余额

- 建行：既有模板明确写明「应还款额/溢缴款为负数，表示账户有溢缴款」。方程中的 Last Statement Balance / New Balance 以及账单信息回退表的 New Balance 保留原始正负号。
- 工行：第 3.3 节记录的「上期余额 + 本期支出 − 本期收入 = 本期余额」区分余额与收入/支出；余额表和人民币应还款额表中明确打印的负号均保留，不把负余额改成债务。
- 中信：现有动卡空间模板的「上期应还款额 − 上期已还款额 + 本期新增金额 = 账户账单金额」区分余额与收支总额。上期、账户账单金额和总账应还款总额保留明确符号；不据此推断其他未识别模板或无符号「溢缴款」字段的含义。
- 三家银行的消费、还款、费用、最低还款额及额度仍沿用现有金额语义。回归分别基于各银行自身的合成布局；没有用一家的负余额案例推断另一家的列结构。缺少汇总仍为信息不足，方程不平衡仍为差异，禁止通过反转符号配平。
