# AUD-003 加固与 AUD-001–014 关闭复核

日期：2026-10-21，UTC。本报告对应 `security/aud003-csp-hardening`，以原始 [全仓审计](2026-10-17-full-repository-audit.md) 为依据；原报告的基线、严重级别和历史证据保留。

## 结论与基线

13 项已确认缺陷均已有合并修复，本轮通过当前代码和完整回归复核其对应控制，无需重复实现。AUD-003 仍按**安全建议**交付：生产 HTML 的 meta CSP 已在真实生产构建和 Chromium 中验证生效，没有证明或宣称存在 XSS 漏洞。线上仍是合并前版本，本 PR 不自动合并或部署，因此不能把本地验证表述为线上已完成加固。

- 开始时获取并复核的远程 main：`df796f5571bc6830ccc7e98b564f284d90d5e9d3`。
- 会话预置分支为 `security/aud003-csp-hardening`；工作区干净，HEAD 与新获取的 main 完全相同，没有已有分支提交或用户修改需要覆盖。沿用该分支，不重写历史。
- Pages API：`build_type=workflow`，`cname=ledger.keepraw.com`；部署 `7200243985` 为该 main，状态 `success`。对应 [历史 main Validation](https://github.com/keepraw/keepraw-ledger/actions/runs/39425656151) 成功，仅作部署来源证明，不计作本 PR 测试。
- 2026-10-21 03:32:02 UTC，`https://ledger.keepraw.com/` 返回 HTTP 200，`server: GitHub.com`，既无 HTTP CSP 头也无 HTML meta CSP。Pages API 还返回 `https_enforced=false`；HTTPS 请求成功，不据此推断实际 HTTP 利用或新增已确认缺陷。
- 当前构建入口 JS 与线上同名入口 SHA-256 都是 `382f0d992effdc32f0e1f3acdcab85ad5ddbc5afdb0aa1001ce23c6d51459ba3`。本次生产行为变更集中在 HTML 策略，不改财务业务代码。

## 修复前证据与复现

先加入生产 Playwright 配置及回归，再实现 CSP。测试使用真实构建、独立本地 preview 端口和全新浏览器上下文。外部探针由 Playwright 对 `https://csp-probe.invalid/**` 返回无害合成内容，不需要外部服务。

在原 main 的 Vite 配置下执行：

```sh
cd web
npx playwright test --config playwright.production.config.ts --grep 'blocks unnecessary'
```

行为断言失败：`ran=true`，`evalBlocked=false`，三个外部/Blob/data 脚本均加载，`connectBlocked=false`、`workerBlocked=false`、`styleBlocked=false`、`baseUnchanged=false`。修复后相同探针全部得到相反的预期保护结果；浏览器产生对应 CSP 违规事件，外部请求未到达测试路由。

这里注入脚本是控制验证，未证明应用输入能够到达可执行脚本位置。eval 探针由浏览器真正加载的同源脚本触发，不能用会绕过该限制的 DevTools `page.evaluate` 本身代替。首轮测试发现这一工具行为后已修正并重新取得修复前失败结果。

## 实现、实际文件与托管边界

- `web/vite.config.ts`：仅生产构建在 head 开头注入 enforcing meta CSP，先于脚本、modulepreload 和 CSS；默认拒绝来源，脚本/连接/Worker 仅同源，禁止对象、base 修改与表单提交，不放行 `unsafe-eval`、外部域名或 Blob Worker。React 图表、进度和布局所需的内联样式属性仅通过 `style-src-attr 'unsafe-inline'` 保留；内联 style 元素与脚本仍被拒绝。
- `web/e2e/csp.spec.ts`、`web/playwright.production.config.ts`：真实构建的策略执行、实际 PDF Worker、合成 PDF/HTML/EML/XLSX、主题、CSV/XLSX/JSON/ZIP/原件下载、独立浏览器恢复及数据逐项比较。
- `web/playwright.config.ts`、`web/package.json`、`web/tsconfig.node.json`：开发测试与生产测试分别选择用例；`npm run test:e2e` 必须连续执行两组，生产组自行重建且不复用服务器，新配置纳入类型检查。没有新增跳过。
- `docs/csp.md`、本报告及机器可读证据：记录策略、托管边界与复核；原审计仅增加本报告链接，不重写历史发现。
- 已检查 `.github/workflows/ci.yml`：PR 仅验证，main 部署使用同一运行内验证过的 `web/dist`；现有 `npm run test:e2e` 步骤自动覆盖新增生产组，无需改动工作流或部署权限。

[策略及标准来源](../csp.md) 详述以下未覆盖边界：GitHub Pages 当前发布接口不提供自定义响应头设置，未添加无效的 `_headers`；meta 解析前内容不受该策略保护，不能施加 `frame-ancestors`、`sandbox`、`report-uri` 或 Report-Only 响应头。禁止子 frame 不等于防止被其他页面嵌入。同源外部 Worker 的内部网络/执行策略需要 Worker 自己的响应头；文档的 `worker-src` 只限制创建来源，不为 Worker 安装内部 CSP。PDF.js 的 `isEvalSupported:false` 是单独保留的应用控制。HTTPS 强制、HSTS 等响应头能力也不由本 PR补齐。

## 本轮实际验证

环境：Linux arm64，Node `v24.21.0`，npm `11.19.0`，锁定 Vite `6.4.4`、Vitest `4.1.11`、Playwright `1.64.0`、Chromium `156.0.8078.4`。最初 `bwrap` 失败后通过受控提权运行；Chromium 缺系统库、sudo 密码不可用，最终用下载并解包在 `/tmp/keepraw-browser-libs` 的库运行，无需修改仓库依赖或系统安装。

| 命令（均在 web） | 本轮结果 |
| --- | --- |
| `npm ci` | 成功；330 个包安装，锁文件未变 |
| `npm run typecheck` | 通过 |
| `npm run lint` | 通过，0 错误；Golden 生成器两条原有 console 警告 |
| `npm test` | 54 个文件通过、1 个原有私有验收文件跳过；851 项通过、6 项原有私有样本测试跳过 |
| `npm run build` | 通过，产物包含早期 meta CSP 和独立本地 PDF Worker |
| `npm audit --audit-level=high` | 通过，0 漏洞 |
| `npm run test:e2e` | 原有组 47 通过、2 个原有私有验收跳过；生产 CSP 组 3 通过；合计 50 通过、2 跳过 |

本轮完整单元及 E2E 已包含持久化、备注、JSON/ZIP 备份、恢复回滚、附件恢复、并发导入等专项文件。生产组还逐项比较恢复前后的 transactions/statements/imports/reviewNotes，并验证 ZIP 原件字节与恢复后原件下载一致，不能只凭页面成功提示认定备份正确。

初次浏览器启动缺库、初次生产探针对 DevTools eval 行为的错误假设，以及空账本刷新后 Demo 模式导致的 PDF 测试前置问题均已解决并重新验证；不把这些失败计作通过，也不把它们误报为产品缺陷。测试详情与产物摘要见 [机器可读证据](2026-10-21-aud003-evidence.json)。最终提交 SHA、GitHub 账户归属、PR 链接和针对该 SHA 的远程 Web/Verify commit metadata 结果由 PR 交付记录提供；本地测试不替代远程 CI。

## 逐项关闭复核

下表“回归”均指本轮执行的文件；合并 PR 是修复来源，而非本轮结果。财务正确性只在相应断言与合成输入边界内得到支持。

| 条目 | 修复来源与当前代码证据 | 本轮回归与结论 |
| --- | --- | --- |
| AUD-001 | [#37](https://github.com/keepraw/keepraw-ledger/pull/37)；`AppStore.tsx` 独立 demoNotes，真实备注读写受模式约束 | `demoModeFlow`、`demoNotes`、`backupV2`：Demo 不显示真实备注、不污染真实备份；关闭 |
| AUD-002 | [#44](https://github.com/keepraw/keepraw-ledger/pull/44)；`TransactionsPage.tsx` 按少量重复文本分组排序，保留唯一值/等价字符串回退 | `transactionsPerformance`、`transactionsSort`：18k 排序结果与独立 oracle 一致，32 个不同描述的比较次数 <512；关闭已证实的重复文本瓶颈，保留规模边界 |
| AUD-003 | 本 PR；生产早期 meta CSP，真实浏览器违规事件与正常业务路径验证 | 3 个生产用例通过；建议在现有托管能力内完成，线上部署和响应头级控制仍有条件 |
| AUD-004 | [#33](https://github.com/keepraw/keepraw-ledger/pull/33)；`repository.ts` 在相关写入事务内重建 statement 状态 | `statementState`、`ledgerState`、`financialReview`：复核、历史导入和汇总一致；关闭 |
| AUD-005 | [#36](https://github.com/keepraw/keepraw-ledger/pull/36)；`ledgerRevision.ts`/repository 修订校验，AppStore 冲突重规划、跨页刷新、generation 校验 | `concurrentImports`、`attachmentRecovery`：并发导入与清理后旧写入保护；关闭 |
| AUD-006 | [#45](https://github.com/keepraw/keepraw-ledger/pull/45)；`demoStore.ts`/AppStore 独立可编辑 Demo 快照 | `demoTransactions` 单元及浏览器：确认/排除/分类有效，真实存储不变；关闭 |
| AUD-007 | [#40](https://github.com/keepraw/keepraw-ledger/pull/40)；`TransactionsPage.tsx` 同币种数值比较、null 保持末尾 | `transactionsSort`、`transactionsPerformance`：数值/币种/方向排序回归；关闭 |
| AUD-008 | [#34](https://github.com/keepraw/keepraw-ledger/pull/34)；六银行 parser 优先识别交易候选行，候选解析失败显式报错 | `parserCompleteness`、各银行 parser、`financialIntegrity`：页脚词商户不截断、异常行不静默丢失；关闭 |
| AUD-009 | [#41](https://github.com/keepraw/keepraw-ledger/pull/41)；`abc.ts` 基于周期约束唯一解析短日期年份 | `abcCrossYear` 单元及浏览器：跨年日期和歧义处理；关闭 |
| AUD-010 | [#42](https://github.com/keepraw/keepraw-ledger/pull/42)；CCB/ICBC/CITIC parser 保留汇总余额符号 | `signedCreditBalances`、`financialIntegrity`：负期初余额不变正债务；关闭 |
| AUD-011 | [#35](https://github.com/keepraw/keepraw-ledger/pull/35)；`classify.ts` 精确业务 token/受界定前缀及方向校验 | `classificationIntegrity` 单元及三适配器浏览器：商户促销词不误当返现，歧义显式复核；关闭 |
| AUD-012 | [#43](https://github.com/keepraw/keepraw-ledger/pull/43)；`boc.ts` 按币种/账户限定汇总与明细 | `bocCurrencySummary` 单元及四组真实 PDF 提取浏览器：外币不冒充人民币汇总；关闭 |
| AUD-013 | [#39](https://github.com/keepraw/keepraw-ledger/pull/39)；`web/src/golden` 与生成脚本的安全输出、格式化卡号及 metadata 处理 | `goldenPrivacy`、`goldenGenerator`、`committedGolden`：商户/姓名/卡号泄漏回归；关闭，未改 Golden 基准掩盖错误 |
| AUD-014 | [#38](https://github.com/keepraw/keepraw-ledger/pull/38)；AppStore/extract 提前文件与批次预算、repository/archive 显式原件外存选择 | `attachmentBudget`、`backupSafety`、`attachmentRecovery`：超大新输入不留附件、旧原件有明确恢复路径；关闭 |

AUD-002 的 18k/100k 延迟测量来自 [2026-10-20 独立修复报告](../benchmarks/large-ledger/aud002-20261020.md)，本轮未重跑完整 100k 性能/恢复 campaign，不能把它称为今天的测量。当前代码和算法预算回归支持该修复仍在；唯一文本、高基数、低内存及其他设备上仍无通用 SLA。

## 真实数据影响、剩余验证与合并建议

本轮只使用合成文件、独立本地 origin 和新浏览器上下文，不读取用户真实账本、备注、附件或备份，不操作生产浏览器配置。未修改 `web/src`、数据库 schema、持久化/恢复业务、依赖或锁文件；没有重算或迁移既有账本。没有推送 main、合并、Release 或线上配置变更。

保留原审计 S-01–S-05 的未验证边界：对抗 XLSX/PDF 的时间/解压资源上限、极端聚合安全整数边界、用户编辑备份的语义信任契约、不同表格软件对公式控制字符的解释，均未在本轮穷尽验证。当前私有账单、Firefox/WebKit/Safari、移动端/隐私模式、真实配额耗尽与驱逐、崩溃断电恢复、低内存设备及全面格式 fuzzing 也未验证。这些风险没有被自动升级为新增已确认缺陷。

建议在**本 PR 最新 SHA 的 Web CI 与 Verify commit metadata 均通过、GitHub Author/Committer 均为 keepraw**后进行人工合并。合并后的正常 Pages 部署还需检查线上 HTML 的早期 meta、实际页面启动与 PDF Worker，不能将本次本地结果代替部署后验收。若要求防嵌入、Worker 内部 CSP、强制 HTTPS/HSTS 或完整响应头保护，需另行批准并验证支持响应头的托管/边缘方案。
