# AUD-006：Demo 交易状态修复与验证

日期：2026-10-20（Asia/Shanghai）。本报告仅交付 AUD-006（P3）。原始依据为 [2026-10-17 全仓审计](2026-10-17-full-repository-audit.md#aud-006--demo-transaction-controls-have-no-effective-mutation-target)。AUD-003 尚未开始，原报告仍保留为历史审计证据。

## 一、基线与远程状态

- 开始工作及提交前核对的远程 main：`977646c3515e7c9d70616def2e3d6a0cdc8b4774`。
- PR #44 确已合并。合并后的 [Validation 39399900849](https://github.com/keepraw/keepraw-ledger/actions/runs/39399900849) 中，`web`、`deploy` 均为 success；Pages 部署 ID 为 `7196133107`。
- 合并后的 [Commit identity 39399900945](https://github.com/keepraw/keepraw-ledger/actions/runs/39399900945) 中，`Verify commit metadata` 为 success。
- 本地原 `work` 分支干净，停在 `2c6d42c45ceb2da3866af9cffe6bae1fc529cc41`。读取 AGENTS.md、检查配置与身份环境变量后，从更新后的 `origin/main` 创建 `fix/aud006-demo-transaction-state`，未覆盖用户改动。
- 本地 Author/Committer 均设置为 `keepraw <49091395+keepraw@users.noreply.github.com>`，`user.useConfigOnly=true`。远程最终 HEAD、逐提交 GitHub login 及本 PR CI 结果记录在 PR 描述中。

## 二、修复前复现

先添加测试、执行失败，再修改生产代码。针对 main 的首轮结果：

| 执行 | 修复前结果与证据 |
| --- | --- |
| `npm test -- --run tests/demoTransactions.test.tsx` | 首批 5 用例全部失败。确认与分类修改后仍为 `pending`、原 `flags` 和原分类；切换模式后也没有 Demo 编辑结果。 |
| `npx playwright test e2e/demoTransactions.spec.ts` | 2 用例均在真实 UI 确认操作后失败：目标复核行预期 0，实际始终 1，等待 15 秒仍未消失。Demo 行为 `消费 示例电器商城`、`159.00`。 |
| 队列与 ID 冲突的独立单元用例 | 刻意在真实 IndexedDB 测试库放入与 Demo 同 ID 的真实行，再先排队关闭 Demo、后排队修改 Demo。旧实现改动了真实行的分类/flags 和账本 revision。此为人工构造的隔离边界测试，不声称真实用户自然出现过该碰撞，不提高原 AUD-006 等级。 |
| 重新生成与过期请求 | 原实现复用缓存并执行数据库清理/重读，既不重建 Demo 交易，也不清空会话 Demo 备注；过期编辑/备注未被拒绝。 |

核心交易修复后，继续核查派生视图，新增导航断言又复现：空真实库中的 Demo 有 1 份待复核账单，但导航文字只有“人工复核”，而非“人工复核1”。修改 AppShell 前单独运行该 Chromium 用例，确认失败后才将导航计数改为当前可见账单。

最终单元文件新增第 6 个用例，验证不能把 Demo 行移入真实账单或改为真实身份，失败后队列仍可继续，初始缓存不被编辑污染。

## 三、修复机制与行为规则

`AppProvider` 为每次挂载创建独立 Demo 快照。交易更新在入队时复制 patch，并捕获请求所属模式与 Demo generation。Demo 分支只合并到自己的内存快照，使用已有 `deriveStatementState` 重算关联账单并发布 React 状态，不调用真实交易持久化接口；真实模式仍使用原有事务更新、对账重算、revision 与跨标签页广播路径。

队列通过内存引用读取前一次已完成的 Demo 更新，不依赖 React 是否已完成下一次渲染，因而同时排队的确认与分类不会相互覆盖。Demo 请求即使在关闭 Demo 后才执行，也只操作 Demo 内存；真实请求排在开启 Demo 之后时，读取已提交设置并拒绝写入。Demo 目标不存在时直接拒绝，不回退真实库查找。生成代次变化会拒绝旧代次排队的交易修改与备注，防止相同稳定 ID 将旧操作应用到新数据。

| 场景 | 明确定义的状态 |
| --- | --- |
| 确认、排除、分类 | 当前页面立即更新。确认清除复核 flags，排除退出复核队列，关联 Demo 对账结果、核验/总览等派生视图读取新快照。 |
| 页面内导航、焦点刷新或 `refresh()` | 保留本次挂载的 Demo 编辑与备注；真实快照重读不覆盖 Demo。 |
| Demo → 真实 → Demo | 隐藏状态相互隔离；本次页面会话的 Demo 编辑与备注保留。真实备注在 Demo 中不读取、不显示。 |
| 重新生成 | 创建初始 Demo 快照，清除全部 Demo 编辑和 Demo 备注，增加 generation。不清理、删除或重写任何真实记录。旧版 Demo 持久化残留仍由既有启动迁移处理。 |
| 浏览器完整刷新、关闭后重新打开、另开页面 | 创建新的独立 Demo 会话，恢复初始交易，Demo 备注为空。各标签页不共享 Demo 编辑。 |
| 模式设置 | 保持原有设置持久化规则；有真实导入记录时重开跟随保存的设置。现有“启动时真实导入为空则默认进入 Demo”规则未改动。 |
| JSON/ZIP 备份 | 继续备份真实 IndexedDB 的交易、账单、导入、备注与原件。设置中的 `demoMode` 可以被备份；它不是 Demo 金融数据或备注污染。 |
| CSV/XLSX 查看导出 | 仍导出当前可见账本，因此在 Demo 下可以导出虚构交易；这与用于恢复的 JSON/ZIP 备份保持原有区别。 |

保留 AUD-001 的双向备注隔离与长度校验；仅增加 generation 校验及重生成时清空 Demo 备注。没有清除真实备注、使用清空真实数据完成修复、永久禁用交易控件或修改真实数据库 schema。

## 四、实际修改文件

- `web/src/demo/demoStore.ts`：新建快照、纯内存 patch、Demo 所属账单检查、复用对账派生函数；初始缓存只用于数量/测试。
- `web/src/app/AppStore.tsx`：每个 Provider 的 Demo 状态、队列目标绑定、generation、真正重生成；保留真实持久化与备份路径。
- `web/src/ui/AppShell.tsx`：导航复核计数跟随可见账单，避免 Demo 读取真实账单计数。
- `web/src/ui/pages/ReviewPage.tsx`、`SettingsPage.tsx`：说明编辑/备注的内存生命周期和重置规则。
- `web/tests/demoTransactions.test.tsx`：6 个状态、隔离、排队、代次及失败恢复用例，使用 AppProvider 和 IndexedDB 测试实现。
- `web/e2e/demoTransactions.spec.ts`：2 个 Chromium 综合用例，真实 UI、原生 IndexedDB、实际 JSON/ZIP 下载与解包、附件字节比较、两方向模式切换、重生成/刷新/重开、真实交易编辑与跨标签页更新。
- 本报告及同目录 `2026-10-20-aud006-evidence.json`：执行结果摘要。

未修改 `TransactionsPage.tsx` 排序逻辑、`repository.ts`、任何 Golden、依赖声明、锁文件、CI 或部署配置；没有新增跳过或削弱已有测试。

## 五、验证结果

环境：Linux x64、Node v24.19.0、npm 11.9.0、Vitest 4.1.11、Playwright 1.64.0、Chromium 156.0.8078.4。以下命令均在 `web/` 执行，提交前对最终生产代码重新执行整套验证。

| 命令 | 最终结果 |
| --- | --- |
| `npm ci --cache /workspace/.npm-cache` | 通过，331 个锁定包；仅指定可写缓存位置，未修改依赖。 |
| `npm run typecheck` | 通过。 |
| `npm run lint` | 通过，0 error；`generate-golden.ts` 两个既有 no-console warning。 |
| `npm test` | 851 通过、6 个既有私有样本跳过；54 文件通过、1 文件跳过。 |
| `npm run build` | 通过，Vite 生产构建成功。 |
| `npm audit --audit-level=high` | 通过，0 已报告漏洞。 |
| `npm run test:e2e` | 47 通过、2 个既有私有样本跳过，Chromium。 |
| 存储/备注/备份/对账/并发专项 | 11 文件、117 用例全部通过，见下列复现命令。 |
| `git diff --check` | 通过。 |

专项命令：

```sh
npx vitest run tests/demoTransactions.test.tsx tests/ledgerState.test.tsx \
  tests/demoIsolation.test.ts tests/demoModeFlow.test.tsx tests/demoResidueCleanup.test.ts \
  tests/backupV2.test.ts tests/backupSafety.test.ts tests/statementState.test.ts \
  tests/concurrentImports.test.tsx tests/attachmentBudget.test.tsx tests/largeBackupSafety.test.ts
```

浏览器验证包含非零、已对账的真实合成账本（消费 ¥128.80）、真实交易备注、孤立备注与一份真实原始附件。Demo 确认、排除、分类、备注和重生成前后逐项比较：真实交易/账单/导入快照完全相同，真实备注（含时间戳）完全相同，附件元数据与字节完全相同，真实总览仍为 ¥128.80。实际 JSON 与 ZIP 内 database.json 也逐项等于真实基线；ZIP 内原件字节与原始合成文件相同，manifest 只有真实原件。关闭 Demo 后，真实确认与分类仍可保存、刷新后保留，并即时同步到第二个真实模式标签页。

全量套件保留并执行了此前审计修复的回归，包括真实对账状态、跨标签页并发/清空、备注迁移/隔离、附件预算、备份恢复及现有 100k 合成迁移检查。该现有检查不是重做 AUD-002 性能基准，不能用它覆盖 PR #44 已记录的性能边界。

## 六、剩余边界与合并建议

AUD-006 在本分支完成，建议人工审查上述生命周期与队列隔离后合并。最终 Web CI 和 `Verify commit metadata` 必须成功，逐提交 `author.login` / `committer.login` 必须为 keepraw；实际状态以 PR 描述与 Checks 为准。不自动合并，不直接推送 main，不发布 Release。

Demo 编辑是有意的临时体验：不跨完整页面会话保存，也不跨标签页同步；重生成清除演示备注。真实备份不会恢复 Demo 编辑。未重新验证私有账单样本、所有浏览器、设备崩溃/存储驱逐、低内存设备或全部金融输入组合；这些是未验证边界，不自动计为新缺陷。

AUD-003 仍是尚未处理的 CSP 纵深防御建议。本 PR 不声称现有 CSP 生效，也不声称发现 XSS。PR #44 已记录的全量读取、主线程计算、高基数排序和低内存表现限制不在本轮重新展开。待用户决定本 PR 是否合并后，才开展独立 AUD-003 分支；全部 AUD-001 至 AUD-014 的最终关闭核对留到那之后。
