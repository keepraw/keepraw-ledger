# 全仓审计：解析可靠性、代码严谨性与运行效率

**日期：** 2026-11-22（Asia/Shanghai）
**基线：** `main` @ `003d25b`（PR #51 合并后）
**范围：** `web/src` 全部 parser、核心账务（ingest / dedupe / identity / reconcile / direction）、持久化（`db/repository.ts`）、备份校验、UI 状态管理（`app/AppStore.tsx`）、构建产物与测试。
**前序审计：** [2026-10-17 全仓审计](2026-10-17-full-repository-audit.md)、[2026-10-21 关闭复核](2026-10-21-audit-closure.md)。本报告不重复其已关闭的 AUD-001–014。

## 1. 结论

- **交易明细层可靠。** 在 18 份真实账单（6 家银行、24 个文件，其中 6 个为重复副本）上，逐笔交易的笔数、金额、币种和借贷方向与账单汇总交叉核对，未发现漏行、多行、金额错误或方向错误。
- **汇总 / 对账层有 4 个已确认缺陷（AUD-101–104）**，导致 18 份中有 10 份对账失败并被排除出看板统计（看板默认不统计未对账账单）。这些都是“误报失败”，没有出现“错误数据被当作已对账”的情况——系统的失败方向是安全的。四项均在本 PR 修复并配有虚构数据回归测试。
- **代码严谨性高。** TypeScript `strict` + `noUncheckedIndexedAccess`；金额全程整数最小单位；解析失败时整份账单失败而非丢行；方向冲突保留原值并进入复核；源码中无 `as any` / `@ts-ignore`；无任何网络请求代码，生产 CSP 限制 `connect-src 'self'`，满足“不依赖网络”。
- **效率：单文件解析足够快；瓶颈在大账本下的导入与刷新**（AUD-107、AUD-108），对个人账本规模（数千到数万笔）无实际影响，十万笔级别会有可感知卡顿。

## 2. 方法

1. 静态阅读上述模块及其测试。
2. 在仓库外临时目录用 Vite SSR 加载真实的 `buildSourceDocument → detectParser → parseDocument → ingestParsedStatement` 流程，批量处理用户提供的真实账单。**真实账单及其解析输出从未进入仓库**；本报告只记录状态、计数和耗时，不包含任何金额、商户、姓名或卡号。
3. 失败账单逐份把银行原始汇总表与逐笔交易合计手工比对，区分“解析器读错汇总”与“对账规则不适用”。
4. 性能使用同一 harness 计时（Node 22，本机 VM），大账本场景用合成交易复制到 1 万 / 5 万 / 10 万笔。

## 3. 真实账单结果（修复前）

| 银行 / parser | 唯一账单 | 对账通过 | 失败原因 |
| --- | --- | --- | --- |
| 中国银行 `boc_pdf` | 3 | 3 | — |
| 建设银行 `ccb_eml` | 2 | 2 | — |
| 交通银行 `bocom_eml` | 2 | 2 | 分期计划 warning，费用/利息细分为 skipped |
| 农业银行 `abc_eml` | 7 | 1 | AUD-102（5 份）、AUD-103（1 份） |
| 工商银行 `icbc_eml` | 2 | 0 | AUD-101 |
| 中信银行 `citic_eml` | 2 | 0 | AUD-104 |
| **合计** | **18** | **8** | |

6 个“副本”文件均按 SHA-256 识别为重复并跳过，未产生重复交易。

## 4. 已确认缺陷（本 PR 修复）

### AUD-101（P1）工商银行汇总金额格式 `金额/RMB` 无法解析
- **现象：** 真实工行模板的汇总单元格为 `174.87/RMB`、`-69.82/RMB` 形式。`parseAmountToMinor` 的币种后缀正则不允许 `/` 分隔，返回 null，导致上期余额、本期收入、本期支出、本期余额、应还款额全部缺失，对账状态 `insufficient`。
- **次生问题：** 工行“本期交易汇总”表的余额采用账户余额符号（负数 = 欠款），而应还款额为正数。现有合成 fixture 使用了正数余额且无 `/RMB` 后缀，与真实模板不符，所以测试一直通过。
- **影响：** 所有工行账单都无法对账，交易被排除出看板。
- **修复：** 金额解析允许 `/` 分隔的币种后缀；工行 parser 对余额列取反；应还款额与 −本期余额不一致时给出 `icbc_balance_disagreement` 警告；fixture 改为真实模板格式。

### AUD-102（P1）农业银行“本期调整金额”未进入余额公式
- **现象：** ABC parser 读取了调整金额，却只写进 `components` 展示，`reconcile.ts` 的余额公式没有该项，导致含调整的账单差额恰好等于调整金额。逐笔借贷合计与银行汇总一致。
- **修复：** `StatementSummary` 增加可选字段 `adjustmentMinor`（带符号，正数减少欠款），余额公式减去该项；ABC 保留调整金额的原始符号。旧数据没有该字段时按 0 处理，备份校验兼容新旧两种格式。

### AUD-103（P2）农业银行汇总币种写死为 CNY
- **现象：** 美元账户账单的汇总行明确写着 `美元(USD)`，但所有 summary component 都标为 CNY。`reconcile` 按 `components[0].currency` 选择对账币种，于是用“CNY 汇总”去比对 USD 交易，导致失败。
- **修复：** 从汇总行解析账户币种，并应用到所有 component。

### AUD-104（P2）中信银行退款 / 返现导致明细核对必然失败
- **现象：** 中信把退款和返现净额并入“本期新增金额”，不计入“已还款额”（parser 顶部注释已说明）。通用的借记 / 贷记分项核对因此只要当期有退款或返现就失败，即使余额公式成立、所有交易都正确。
- **修复：** `StatementSummary` 增加可选字段 `detailBasis: 'gross' | 'net'`。中信使用 `net`：用一项 `net_detail`（明细借记 − 明细贷记 = 新增 + 费用 + 利息 − 贷记）替代两项分项核对。漏行或方向错误仍会被检出（回归测试覆盖了删除一笔交易的情况）。

## 5. 未修复的发现与建议

| ID | 级别 | 发现 | 建议 |
| --- | --- | --- | --- |
| AUD-105 | P3 | `reconcileStatement` 返回的 `computedBalanceMinor` 取的是余额公式检查的 `actualMinor`，即账单上的本期余额，而不是计算值；字段名与语义不符。目前 UI 未读取该字段。 | 改为返回 `expectedMinor`，或改名。 |
| AUD-106 | P3 | `detectParser` 吞掉 `parser.match()` 抛出的异常并按 0 分处理。parser 自身 bug 会表现为“无法识别格式”，难以排查。 | 记录异常到 import 记录的诊断信息。 |
| AUD-107 | P2（效率） | 每导入一个文件，`ingestParsedStatement` 都对现有全部交易做线性扫描（建 Map、occurrence 分配）。实测已有 1 万 / 5 万 / 10 万笔时，每个文件分别需 41 / 206 / 456 ms，在主线程执行。10 万笔账本一次批量导入 20 个文件约需 9 秒，期间 UI 无响应。 | 按 `bank + cardLast4` 预先索引并在批次内增量更新；或把 ingest 放进 Web Worker。 |
| AUD-108 | P3（效率） | `AppStore.reload` 每次刷新（包括窗口获得焦点、任何账本变更）都读取 statements / transactions / imports 全表。大账本下切换窗口会触发全量 IndexedDB 读取。 | 用 ledger revision 判断是否需要重读，revision 未变化时跳过。 |
| AUD-109 | P3 | `statementKey` 只由银行、卡号后四位和账期构成，不包含币种。如果同一张卡同一账期分别出具人民币和外币账单（双币卡），两份账单会落到同一个 statement id。本次样本未出现该情况，属于推断风险。 | 为 statement key 加入账户币种，并配套迁移已有数据。 |
| AUD-110 | P3 | 交易指纹包含 `type`（分类结果）。今后 parser 升级若改变分类（例如退款从 payment 改为 refund），同一交易通过不同文件再次导入时会被视为新交易，产生疑似重复，只会被标记、不会被删除。 | 指纹改用银行原始 token / 方向，而非推导出的 type；需要迁移。 |
| AUD-111 | P3 | 中信、建行的部分退款被归类为 `payment`。不影响金额和对账，但影响“还款 / 退款”统计口径。 | 用银行交易类型 token 区分退款与还款。 |
| AUD-112 | P3 | 中行 PDF 识别出了到期还款日，但没有写入 `summary.dueDate`。 | 同步写入。 |
| AUD-113 | 测试 | 合成 fixture 的格式与真实模板不一致是 AUD-101 长期未被发现的根因。 | 每个 parser 至少保留一份“格式忠实于真实模板”的脱敏 fixture，可通过 `web/scripts/generate-golden.ts` 从本地真实账单生成后人工脱敏。 |
| AUD-114 | 测试 | `tests/nativeLedgerImport.test.ts` 的 RSS < 1 GiB 断言在完整并行 Vitest 下实测 1.06 GiB 失败，单独运行该文件通过。 | 将该测试串行运行或放宽阈值，避免 CI 抖动。 |

## 6. 效率测量

单文件处理耗时（ms，本机 Node 22，各 parser 取多个样本的范围）：

| parser | 文件大小 | 提取（MIME / HTML / PDF 文本） | 解析 | ingest（空账本） |
| --- | --- | --- | --- | --- |
| `citic_eml` | ~93 KiB | 105–225 | 0.3–3.4 | 0.4–2.9 |
| `abc_eml` | 63–88 KiB | 74–108 | 0.2–1.8 | 0.1–0.4 |
| `icbc_eml` | ~94 KiB | 25–31 | 0.4–4.1 | 0.2–0.3 |
| `ccb_eml` | ~55 KiB | 56–63 | 0.3–1.5 | 0.2 |
| `boc_pdf` | ~620 KiB | 16–88 | 2.0–6.4 | 0.2–0.4 |
| `bocom_eml` | 67–75 KiB | 72–97 | 0.5–3.7 | 0.2–0.3 |

- 耗时主要花在 MIME 解码和 HTML 清洗 / 建表，parser 本身可以忽略；每个文件的第一次处理包含模块预热。
- 生产构建中 PDF.js（约 1.3 MiB worker）、SheetJS（约 490 KiB）、postal-mime 都是按需动态加载；主包约 580 KiB（未压缩）。
- 大账本导入和刷新见 AUD-107 / AUD-108。

## 7. 严谨性评估（正面控制）

- 金额以整数最小单位存储；未知币种拒绝猜测精度。
- `requireTransactionRow` / `requireTransactionAmount` 保证结构化交易行不能静默消失；金额无法解析时整份账单失败。
- `resolveBankAmounts` 在交易金额与结算金额符号冲突、或方向与符号冲突时保留原值，并标记 `amount_direction_unclear`。
- 对账不通过时交易仍会写入，但带 `statement_mismatch` 标记，账单进入 `needs_review`，不会混进看板统计。
- 没有通用兜底 parser：无法识别的格式直接失败，不会产生半解析结果。
- PDF.js 关闭 eval 和字体加载；输入受 25 MiB / 单批 100 MiB / 60 页的资源上限保护。
- 无网络代码；CSP 只允许同源连接。

## 8. 修复后复核

- `npm run typecheck`、`npm run lint` 通过（lint 仅有 `web/scripts/generate-golden.ts` 中 2 条既有的 `no-console` warning）。
- 完整 Vitest：1152 通过，6 跳过（跳过项是需要本地真实账单的 acceptance 用例）。
- 在仓库外对同一批真实账单重新运行：18 份唯一账单全部对账通过（中行 3、建行 2、交行 2、农行 7、工行 2、中信 2），6 个重复文件仍被跳过。
- 未运行浏览器 e2e，也未在其他浏览器或设备上验证。
