import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const r = JSON.parse(await readFile(path.join(root, 'docs/benchmarks/storage-results.json'), 'utf8'))
const m = JSON.parse(await readFile(path.join(root, 'docs/benchmarks/storage-maintenance-results.json'), 'utf8'))
const median = values => { const a = [...values].sort((x, y) => x - y); return a.length % 2 ? a[Math.floor(a.length / 2)] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2 }
const num = value => value.toLocaleString('en-US', { maximumFractionDigits: 0 })
const mib = value => (value / 1048576).toFixed(3)
const range = values => `${median(values).toFixed(1)} [${Math.min(...values).toFixed(1)}, ${Math.max(...values).toFixed(1)}]`
const byteRange = values => `${mib(Math.min(...values))}–${mib(Math.max(...values))}`
const table = (headers, rows) => `| ${headers.join(' | ')} |\n| ${headers.map(() => '---').join(' | ')} |\n${rows.map(row => `| ${row.join(' | ')} |`).join('\n')}`
const primary = r.runs.filter(run => run.format === 'python' && !run.options.longRaw)
const run = count => primary.find(row => row.count === count && row.replicate === 0)
const p18 = run(18000), p100 = run(100000)
const sizes = [0, 18000, 36000, 100000]
const distribution = p18.metrics.distribution
const controlCycle = (indexed, replicate) => m.cycles.find(row => row.name === `index-control-${indexed}-${replicate}`).checkpoints.at(-1)
const indexDifferences = [0, 1, 2].map(replicate => {
  const indexed = r.controls.find(row => row.indexed && row.replicate === replicate)
  const plain = r.controls.find(row => !row.indexed && row.replicate === replicate)
  return (controlCycle(true, replicate).usage - indexed.baseline.usage) - (controlCycle(false, replicate).usage - plain.baseline.usage)
})
const oldBefore = m.legacyDemo.before.databases['credit-bill-manager']
const oldAfter = m.legacyDemo.after.databases['credit-bill-manager']
const points = sizes.map(count => ({ x: count, y: count ? median(primary.filter(row => row.count === count).map(row => row.initialUsage.usage - row.baseline.usage)) : 0 }))
const meanX = points.reduce((sum, point) => sum + point.x, 0) / points.length, meanY = points.reduce((sum, point) => sum + point.y, 0) / points.length
const slope = points.reduce((sum, point) => sum + (point.x - meanX) * (point.y - meanY), 0) / points.reduce((sum, point) => sum + (point.x - meanX) ** 2, 0)
const intercept = meanY - slope * meanX
const rSquared = 1 - points.reduce((sum, point) => sum + (point.y - slope * point.x - intercept) ** 2, 0) / points.reduce((sum, point) => sum + (point.y - meanY) ** 2, 0)
const metrics = [
  ['正常 XLSX 导入至页面刷新', 'import.totalMs', 3],
  ['AppStore 哈希／预览阶段', 'import.previewMs', 3],
  ['AppStore 确认／写入／刷新阶段', 'import.confirmMs', 3],
  ['单独 persistLegacyImport', 'persistenceMs', 3],
  ['数据库 open，仅打开连接', 'databaseOpenMs', 5],
  ['实际应用导航至交易页就绪', 'startups.firstReadyMs', 3],
  ['readSnapshot()', 'readMs', 5],
  ['全部交易 applyFilters', 'filterAllMs', 5],
  ['日期排序，完整列表', 'dateSortMs', 5],
  ['银行／日期／商户联合筛选', 'filteredSearchMs', 5],
  ['中文／英文描述排序，完整列表', 'descriptionSortMs', 5],
  ['JSON Backup 数据读取', 'backupReadMs', 5],
  ['JSON pretty stringify + Blob', 'backupEncodeBlobMs', 5],
  ['JSON Backup 总耗时', 'backupTotalMs', 5],
  ['refresh() Promise 返回', 'refreshResolvedMs', 5],
  ['refresh 至 React layout 提交', 'refreshCommitMs', 5],
  ['refresh 至两个动画帧后', 'refreshPaintMs', 5],
  ['实际 UI 搜索至两个动画帧后', 'ui.searchMs', 5],
  ['实际 UI 日期排序至两个动画帧后', 'ui.dateSortMs', 5],
  ['实际 UI 描述排序至两个动画帧后', 'ui.descriptionSortMs', 5],
]
function samples(count, key) {
  const row = run(count)
  if (key.startsWith('import.')) return primary.filter(row => row.count === count).map(row => row.import[key.split('.')[1]])
  if (key === 'persistenceMs' || key === 'databaseOpenMs') return row[key]
  if (key.startsWith('startups.')) return row.startups.map(sample => sample.firstReadyMs)
  if (key.startsWith('ui.')) return row.ui.map(sample => sample[key.split('.')[1]])
  return row.performance.map(sample => sample[key])
}

const report = `# Storage Benchmark Report — Keepraw-Ledger

测试日期：2026-10-14。被测 main：\`${r.metadata.commit}\`（Python retirement 后）。仅新增独立基准脚本及本报告；Transaction／IndexedDB schema、ID、fingerprint、importer、备份格式、XLSX export、UI 和生产逻辑均未修改。所有数据为合成数据，未读取真实用户账本、私人银行账单或既有用户浏览器 profile。

## 核心结论

**A. 18,000 条约 19 MB 符合当前实现可合理出现的存储成本；本轮没有证据将其归因为重复交易或正常导入泄漏。** 设置页实际使用 1024² 换算，显示的“19 MB”是约 19 MiB，即 19,922,944 字节／约 1,107 字节每交易。本合成历史导入写入后中位数为 **21.281 MiB**，一个正常重启样本为 **19.392 MiB**；只读重启后另两个样本为约 **15.6 MiB**。估计用量随 LevelDB 文件布局和整理时机变化。19 MiB 落在实际测出的范围内。没有读取用户数据库，因此这不能证明该用户数据库中每个字节的来源。

**B. 100,000 条仍可存储，但现有全量读取和交互路径已有明显瓶颈，备份恢复还有已验证的阻断问题。** 写入后估计用量中位数 **102.775 MiB**，在本环境容量充足；\`readSnapshot()\` 中位数 **1.422 秒**，刷新到 React 提交约 **1.922 秒**，交易页首次就绪约 **6.687 秒**，完整描述排序的 UI 延迟约 **0.669 秒**。一次大规模 XLSX 导入约 **44.7 秒**。100,000 条导出的 JSON 为 **${mib(p100.backupRoundTrip.bytes)} MiB**，实际恢复被现有 **32 MiB** 限制拒绝。不能把“存得下”作为整体可接受的充分条件。

## 方法与数据分布

固定种子 \`0x4b524c31\`（${r.metadata.seed}），2018–2025 年，六家银行、六个虚构卡尾号，中文及英文商户，消费／退款／还款／手续费／利息／返现，CNY／USD／HKD／JPY／EUR，JPY 使用整数最小单位，其他货币使用精确小数字符串。交易日随机分布、入账延迟 0–3 天，每 100 行保留一次合法重复，ID 和 occurrence 完全交给生产 importer 生成。

18,000 条主样本：银行 ${JSON.stringify(distribution.banks)}；类型 ${JSON.stringify(distribution.types)}；原币 ${JSON.stringify(distribution.currencies)}。负数 ${num(distribution.negative)} 条、多币种结算 ${num(distribution.crossCurrency)} 条、合法重复 occurrence>1 共 ${num(distribution.repeatedOccurrences)} 条；${num(distribution.uniqueIds)} 个不同 ID，${num(distribution.flags)} 条含 flags。三个主规模均解析全部行，异常行 0；所有记录检测样本均通过生产 \`validateBackup\`。

**三个规模都从真实合成 XLSX 开始**，经过现有 \`hashLegacyFile → previewLegacyWorkbook → AppStore.confirmLegacyImport → persistLegacyImport → refresh\`。主要采用“标准字段”历史 Python 导出适配器，**不运行 Python**。18,000／36,000／100,000 条 XLSX 分别为 ${num(r.fixtures['python-18000.xlsx'].byteLength)}／${num(r.fixtures['python-36000.xlsx'].byteLength)}／${num(r.fixtures['python-100000.xlsx'].byteLength)} 字节；文件 SHA-256 见原始结果。交易里的 sourceFileHash 是实际上传 XLSX 原始字节的 SHA-256，sourceRow 与工作表行一致。另测“交易明细”“统一账单”适配器；全部 18,000 条也走同一正常导入路径。仅索引对照和持久化分项重写使用直接写入；其完整对象由现有 importer 生成，并明确标为独立实验。

生产 Vite 构建；Playwright + Chromium **${r.metadata.chromium}**；Node **${r.metadata.node}**；Linux 容器，${r.metadata.cpus} CPU，${r.metadata.cpu}，约 ${(r.metadata.memoryBytes / 1073741824).toFixed(1)} GiB RAM。每轮全新隔离 persistent profile，浏览器只允许本地测试 origin 的请求。18,000 和 100,000 各 3 个全新 profile；36,000 和各适配器／长 rawText 场景各 1 个。读取、筛选、排序、备份和刷新各 5 次；实际应用新 tab 加载各 3 次。

JSON 体积采用 \`TextEncoder().encode(JSON.stringify(...)).byteLength\`，是 **UTF-8 字节**，不使用字符串 length。表 JSON 包含数组括号和逗号；空表为 2 字节。对象均值排除数组分隔符。附件元数据 JSON 与 ArrayBuffer 二进制字节分开。\`navigator.storage.estimate().usage\` 是 **整个 origin 的估计**，不是 IndexedDB 精确磁盘大小；本隔离场景 usageDetails 仅显示 indexedDB。HTTP 资源缓存／下载文件不被当作交易 JSON 或附件。

## 现有存储实现检查

${table(['main 文件', '检查结果'], [
  ['[db.ts](../../web/src/db/db.ts)', 'Dexie v2，6个store；v2只增加attachments，没有第二套交易数据库。附件按原字节SHA-256主键，ArrayBuffer保存。'],
  ['[repository.ts](../../web/src/db/repository.ts)', '历史导入在单个rw事务中写imports／statements，并以2000条批量bulkAdd新增交易。更新用put，备注用transactionId主键；备份只读，不持久化额外账本。'],
  ['[types.ts](../../web/src/core/types.ts)', 'Transaction完整保留原文、展示描述、来源、指纹、flags等字段；Statement保留summary／reconciliation，ImportRecord含来源审计。'],
  ['[legacyImport.ts](../../web/src/importers/legacyImport.ts)', '预览只读，确认基于新快照重新判重；同文件哈希跳过插入，同金融行跨文件按既有occurrence匹配，合法重复保留各自ID。'],
  ['[AppStore.tsx](../../web/src/app/AppStore.tsx)', '历史导入不保存XLSX原附件；银行文件路径保存evidence。React snapshot／visible数组是内存状态；初始化两次refresh，每次单条分类编辑也refresh全量。'],
  ['[SettingsPage.tsx](../../web/src/ui/pages/SettingsPage.tsx)', '直接显示整个origin estimate，除以1024²却标MB；估计读取effect仅依赖账单／交易数量，不能将显示值当作持续实时测量。'],
])}

本轮直接调用 storage.estimate 取新样本，不依赖设置页可能尚未刷新的显示值。完整序列化、二级索引对照与附件实验用于验证上述成本，未仅按字段数量猜测体积。

## 主存储结果

下表使用统一时点：正常导入和 AppStore 刷新结束后、额外扫描／重启／操作实验之前，连续 5 次 estimate、间隔 100 ms；多 profile 取中位数。每个 profile 扣除自己的空 schema + settings 基线。0 行基线为 13,342 字节，其余基线为 13,350–13,354 字节。

${table(['Transactions', 'Records JSON Size (MiB)', 'Browser Estimated Usage (MiB)', 'Baseline-subtracted (MiB)', 'Estimated Bytes/Transaction', 'Declared secondary indexes'], sizes.map(count => {
  const rows = primary.filter(row => row.count === count), first = run(count)
  const usage = median(rows.map(row => row.initialUsage.usage)), delta = median(rows.map(row => row.initialUsage.usage - row.baseline.usage))
  return [num(count), count ? mib(first.metrics.totalRecordsJsonBytes) : '0.000082 (86 B)', mib(usage), count ? mib(delta) : '0', count ? (delta / count).toFixed(1) : '—', 21]
}))}

Transactions 本身的平均 compact JSON 对象大小：18,000 条 **${(p18.metrics.transactionObjectJsonBytes / 18000).toFixed(2)} B**；36,000 条 **${(run(36000).metrics.transactionObjectJsonBytes / 36000).toFixed(2)} B**；100,000 条 **${(p100.metrics.transactionObjectJsonBytes / 100000).toFixed(2)} B**。每交易 origin 增量还分摊了账单、索引、数据库文件等，不能与这些对象字节等同。

### 各表记录数与体积

表格每格为“记录数 / UTF-8 JSON 字节”。附件栏另列二进制。Settings 单独保留，避免空数据库基线被误认为 0。

${table(['表', '0', '18,000', '36,000', '100,000'], ['transactions', 'statements', 'imports', 'reviewNotes', 'attachments', 'settings'].map(name => [name, ...sizes.map(count => { const t = run(count).metrics.tables[name]; return `${num(t.count)} / ${num(t.jsonBytes)}` })]))}

四个主规模附件二进制均 **0 B**。主适配器有 576 个“银行／卡／月份”账单，跨 8 年保持相同期间数；无余额汇总，保留完整 summary/reconciliation，status=imported，而非伪造对账通过。18,000 条 Statements 共 **0.956 MiB**，其 summary/reconciliation 是可测量的次要成本。Imports 仅 1 条，Review Notes 0 条，均不能解释数十 MB 占用。“交易明细”和“统一账单”没有周期列，生产实现各分成 6 个账单。

### 字段贡献与冗余（18,000 条）

“文本字节”是不含 JSON 引号／转义的 UTF-8 原值。“JSON 边际”包括字段名、值、冒号及一个分隔逗号，等于在**内存副本的序列化中**排除该字段可省的字节；它不是 IndexedDB 中该字段的物理尺寸。

${table(['字段', '文本 UTF-8 B', 'JSON 值 B', 'JSON 边际 B', 'JSON 边际 MiB', '不同值数'], ['description', 'rawDescription', 'rawText', 'sourceFileName', 'sourceFileHash', 'fingerprint', 'flags', 'sourceId', 'origin', 'statementId'].map(key => { const f = p18.metrics.fields[key]; return [key, num(f.utf8TextBytes), num(f.jsonValueBytes), num(f.marginalBytes), mib(f.marginalBytes), num(f.uniqueValues)] }))}

- description 与 rawDescription **18,000 / 18,000 完全相同**。这是所有历史适配器的实际归一化结果，后者仍按模型保存以供追溯。
- rawText 与 description 相同 **${num(p18.metrics.equalities.descriptionRawText)} / 18,000（${(p18.metrics.equalities.descriptionRawText / 18000 * 100).toFixed(1)}%）**；其余保存日期、卡尾号、币种、金额或原始行上下文。不能将 rawText 全部判为无用副本。
- 当前 v4 结构没有独立 merchant 字段；交易详情及支付渠道由 description 展示，原始描述继续保留。旧版测量中的退役字段指标仅是历史证据。
- sourceFileName 和 sourceFileHash 各只有 **1 个不同值**，被重复写到所有交易中，也出现在 Statement／ImportRecord。正常历史适配器会采用上传 workbook 的文件名／哈希，不把“标准字段”内原 source_file_name／source_file_hash 拷进 Transaction；这属于既有来源语义，本轮未改变。
- origin、sourceId、sourcePage、isDemo 也是文件／路径级常量；statementId 按 576 个账单重复。fingerprint 有 17,820 个不同值，180 个合法重复需要 occurrence 区分，不能据此删掉金融身份信息。flags 只有 0.197 MiB JSON 边际，不是主要膨胀源。
- 平均 Transaction 中 JSON 值约 **500.86 B**，字段名与标点净贡献约 **425 B**（约 **45.9%**）；这解释了短描述对象仍接近 1 KB 的 JSON 表象。Chromium 使用结构化克隆／LevelDB，不直接存这些 JSON 文本，不能据此声称 IndexedDB 也承担同一比例。

${table(['纯序列化反事实：排除字段', '理论 JSON 节省 B', '理论 JSON 节省 MiB'], Object.entries(p18.metrics.counterfactuals).map(([key, value]) => [key, num(value.savedBytes), mib(value.savedBytes)]))}

反事实字段组合仅描述给定输入的序列化大小，不代表 IndexedDB 的实际物理收益。旧版结果可能包含已经退役的字段；不得将历史数字当作当前 v4 测量。

### 不同历史格式与长 rawText 敏感性

${table(['18,000 条路径', 'Tx JSON B/对象', '全表 JSON MiB', '写入后估计 MiB', '重启后估计 MiB', 'Statements'], r.runs.filter(row => row.count === 18000 && row.replicate === 0).map(row => [row.options.longRaw ? '标准字段，rawText 行重复 ×5' : row.format, (row.metrics.transactionObjectJsonBytes / 18000).toFixed(2), mib(row.metrics.totalRecordsJsonBytes), mib(row.initialUsage.usage), mib(row.reopenedUsage.usage), row.metrics.tables.statements.count]))}

“交易明细”把 rawText=description；“统一账单”保存九列原始行 JSON；“标准字段”保留 raw_text 单元格。长文本实验把每条合成原始行重复五次，测试易压缩的上界场景，**不代表高熵真实长文本**。序列化体积显著变大，但估计用量不能按相同比例相加；表内短期估计差异还包含 compaction。各格式只测 1 个 profile，不据此给出格式间精确物理排名。

## 索引、附件与其他开销

${table(['Store', '主键', '二级索引数', '二级索引'], p18.metrics.indexes.map(row => [row.table, Array.isArray(row.primaryKey) ? row.primaryKey.join('+') : row.primaryKey, row.indexes.length, row.indexes.map(index => index.name).join(', ')]))}

共有 **6 个 store 主键 + 21 个声明的二级索引**。transactions 为 10 个，其中复合 [bank+transactionDate] 也算 1 个。IndexedDB 不接受 boolean 作为索引 key；三张表的 isDemo 索引实际均为 **0 entry**。18,000 条主样本交易二级索引合计 **162,000 entries**（9 个有效索引 ×18,000），不包含主键；这只是条目数，不是字节大小。源代码搜索表明生产 \`where/orderBy\` 查询仅有备份恢复使用的 statementId，其余列表查询走全量数组，索引并未为当前筛选／排序直接提速。

**独立索引对照：** 在另外的 scratch database 中直接写入 importer 产生的完整同样对象；主键和表不变，一组复制全部二级索引，另一组只有主键。每组 3 个 profile。写入后的估计受整理影响，进一步复制这些合成 profile，进行三轮纯只读 getAll + 浏览器关闭／重启，保持所有记录数和 JSON 字节一致。

${table(['scratch 对照（18,000）', '写入后增量 MiB 中位数', '三轮只读重启后增量 MiB 中位数', '三轮后逻辑文件 B 中位数', '写入 ms 中位数 [min,max]'], [true, false].map(indexed => {
  const rows = r.controls.filter(row => row.indexed === indexed)
  return [indexed ? '全部二级索引' : '仅主键', mib(median(rows.map(row => row.after.usage - row.baseline.usage))), mib(median(rows.map(row => controlCycle(indexed, row.replicate).usage - row.baseline.usage))), num(median(rows.map(row => controlCycle(indexed, row.replicate).disk.fileBytes))), range(rows.map(row => row.persistenceMs))]
}))}

扣除各自空 scratch 基线后，三组成对差值为 **${indexDifferences.map(num).join(' / ')} B**，中位数 **${mib(median(indexDifferences))} MiB**（约 ${(median(indexDifferences) / 18000).toFixed(1)} B/交易）。这证明二级索引及其与底层格式的相互作用是显著成本，也增加写入耗时。该差值是**本负载／本 Chromium 的总体实验效果**，不是生产 21 个索引的精确磁盘大小，不能拆成某个索引的“准确成本”，不能保证删索引就总能回收同样字节。

正常历史 XLSX 导入不调用 saveOriginalFile，附件为 0。另一个独立实验对同一合成 XLSX 调用 saveOriginalFile 5 次：仍只有 **${p18.attachments.after.tables.attachments.count} 个附件**，二进制 **${num(p18.attachments.inputBytes)} B（${mib(p18.attachments.inputBytes)} MiB）**，元数据 JSON ${p18.attachments.after.tables.attachments.jsonBytes} B；估计增量 **${mib(p18.attachments.after.usage.usage - p18.attachments.before.usage)} MiB**。该差值含底层编码／压缩和文件布局，不等于二进制逻辑大小。ArrayBuffer 只有一个持久副本，按原字节 SHA-256 去重；生产银行文件导入会保留 evidence，即使解析失败。附件对银行文件历史可能显著，本轮纯历史导入的主成本由交易与索引组成。

readSnapshot 只读取 Statements／Transactions／Imports；Review Notes 在 refresh 单独读取，Attachments 不进入这个全量快照。JSON Backup 读取这些三表和 settings，不含附件或单独 review notes。完整 ZIP 的 database.json 仍是同样数据备份，加 manifest 和已有原始文件，生成及下载使用内存 Blob；没有发现为了备份而向 IndexedDB 再写一份完整数据库。Demo 数据当前只存在内存中。

## Chromium 文件体积与用量波动

关闭浏览器后，仅递归统计新建 profile 的 \`Default/IndexedDB\`：文件内容体积 \`Σ stat.size\`，文件分配量 \`Σ stat.blocks ×512\`；包含 .log／.ldb／MANIFEST／LOG／Chromium external-value 文件。**不包含目录 inode、文件系统元数据、overlay 下层成本或硬件写放大**，不代表桌面 SSD 占用／I/O。实验位于 overlay 文件系统。本表“关闭后”晚于主表 estimate 时点；不能直接相减推出索引成本。

${table(['规模', '首次关闭后逻辑文件 B（rep 0）', '分配 B（rep 0）', '写入后 estimate 范围 MiB', '重启后 estimate 范围 MiB'], sizes.map(count => { const rows = primary.filter(row => row.count === count), first = run(count); return [num(count), num(first.initialDisk.fileBytes), num(first.initialDisk.allocatedBytes), byteRange(rows.map(row => row.initialUsage.usage)), byteRange(rows.map(row => row.reopenedUsage.usage))] }))}

LevelDB LOG 直接记录了重启后的 “Compacting … / Generated table … / Compacted …” 操作。补充实验只复制**本轮合成 profile**，不打开用户 profile，不写 settings／记录、不强制 compact；每轮 native readonly getAll 后关闭浏览器。其结果如下，完整轨迹见 maintenance 原始结果：

${table(['合成 profile 副本', '复制前逻辑文件 MiB', '只读第 1 轮后 MiB', '第 3 轮后 MiB', '三轮交易数'], m.cycles.filter(row => row.name.startsWith('python-')).map(row => [row.name, mib(row.originalDisk.fileBytes), mib(row.checkpoints[0].disk.fileBytes), mib(row.checkpoints[2].disk.fileBytes), row.checkpoints.map(point => point.databases['credit-bill-manager'].transactions.count).join(' / ')]))}

18,000 条的两个副本从约 37 MiB 降为约 15.6 MiB，JSON 字节及记录数完全不变；100,000 条副本约 102.6–114.0 MiB，三次只读重启也未保证相同底层布局。**重新打开不保证达到唯一“最终压实大小”**。这是本实验中实际发生的物理文件整理／布局波动，不能归为新的交易副本，也不能用瞬时 origin estimate 判定泄漏。

## 重复导入、日常操作及孤立记录

${table(['18,000 条生命周期阶段', 'Tx', 'Statements', 'Imports', 'Notes', 'Attachments', 'Estimate MiB'], p18.lifecycle.stages.map(stage => [stage.label, stage.counts.transactions, stage.counts.statements, stage.counts.imports, stage.counts.reviewNotes, stage.counts.attachments, mib(stage.usage.usage)]))}

同一文件重复 5 次，交易／账单／导入记录数不变；导入记录用相同主键 put，status/message/importedAt 会更新。估计增加 **${num(p18.lifecycle.stages[5].usage.usage - p18.lifecycle.stages[0].usage.usage)} B**，属于观察到的小量写入文件增量，不能把它称为永久泄漏。不同 XLSX 容器的同样金融行，SHA-256 不同，新增 **1 个导入审计记录**，新增交易 0；存储估计反而因整理下降。合法重复的 180 个 occurrence 保持。

十次分类编辑／备注更新／JSON 下载后仍是 18,000 交易、576 账单、2 imports、1 note；备注为空时 note 删除，attachments 0。估计短期增加约 ${num(p18.lifecycle.stages[7].usage.usage - p18.lifecycle.stages[6].usage.usage)} B，没有持久完整备份副本。18,000 条自己的 JSON 备份实际成功恢复，未增加交易数量。各主规模及其他正常适配器的孤立交易、无对应来源 import 的交易、孤立 notes／attachments 都为 **0**。有限重复实验支持“未发现正常路径持续异常增长”，不能证明无限次使用或其他旧版本永不产生问题。

**另一个已验证的旧版迁移问题：** 在单独全新 profile 中模拟 1 条旧版 isDemo=true 交易、其匹配账单／导入记录、1 note、1 hash-valid 合成附件，再加载实际应用。现有 purgeDemoRows 只清三张表，留下 notes 和 attachments：

${table(['模拟旧版演示数据', 'Transactions', 'Statements', 'Imports', 'Review Notes', 'Attachments', '附件逻辑 B'], [['启动清理前', oldBefore.transactions.count, oldBefore.statements.count, oldBefore.imports.count, oldBefore.reviewNotes.count, oldBefore.attachments.count, oldBefore.attachments.binaryBytes], ['启动清理后', oldAfter.transactions.count, oldAfter.statements.count, oldAfter.imports.count, oldAfter.reviewNotes.count, oldAfter.attachments.count, oldAfter.attachments.binaryBytes]])}

此时 note 没有交易引用、附件没有 import 引用，确为孤立数据。它是**旧持久化 demo 的特定迁移条件**，当前正常导入不会写 isDemo=true。小型用例附件只有 ${oldAfter.attachments.binaryBytes} B；没有依据把用户的 19 MiB 归因于它。本轮未修复，也没有触碰真实用户记录。

## 性能结果

单位 ms，格式为 **中位数 [最小, 最大]**。多 profile 导入 3 次；持久化分项 3 次；startup 3 次；其余各 5 次。导入排除合成生成、HTTP 读取 fixture 和 Playwright 文件传输，包含实际 File 哈希、预览／确认流程、全量快照、正常写入、React 刷新和两个动画帧。分项使用不同测量轮次，不应把各中位数相加。

${table(['测量', '次数', '18,000', '100,000'], metrics.map(([label, key, repeats]) => [label, repeats, range(samples(18000, key)), range(samples(100000, key))]))}

现有 importer 分项（温热模块、空 existing snapshot、每规模 3 次）：

${table(['分项 ms', '18,000 中位数 [min,max]', '100,000 中位数 [min,max]'], ['hashMs', 'previewMs', 'planMs'].map(key => [key, range(p18.components.map(sample => sample[key])), range(p100.components.map(sample => sample[key]))]))}

数据库 open 只需约 2 ms；应用初始化慢在 **purgeDemoRows 的全表过滤扫描、两次 refresh/readSnapshot，以及客户端数组筛选／排序／渲染**，并非连接本身。空库实际应用首次就绪中位数 ${median(run(0).startups.map(sample => sample.firstReadyMs)).toFixed(1)} ms；首次访问默认展示内存 Demo，数据库金融表仍空。

100,000 / 18,000 的行数比为 5.56，readSnapshot 中位数比约 ${(median(p100.performance.map(sample => sample.readMs)) / median(p18.performance.map(sample => sample.readMs))).toFixed(2)}，但每次编辑一个分类也会重新读取全表并重算列表。refresh Promise 返回到 layout 提交的**成对额外延迟**中位数由 ${median(p18.performance.map(sample => sample.refreshCommitMs - sample.refreshResolvedMs)).toFixed(1)} ms 增至 ${median(p100.performance.map(sample => sample.refreshCommitMs - sample.refreshResolvedMs)).toFixed(1)} ms；包含 React 调度、可见数组生成和当前页排序，**不是纯 React CPU 时间**。交易页只渲染 50 行，分页没有消除全量读取和全量排序成本。普通联合筛选本身约 20 ms，完整排序约 0.4–0.5 秒，已是更显著的交互成本。

首轮 100,000 条导入记录到最长主线程 long task **${(Math.max(...p100.import.longTasks.map(task => task.duration)) / 1000).toFixed(3)} 秒**；XLSX 读取／解析及预览仍在主线程。冷启动测的是同一 profile 中 3 个新 tab 的真实应用入口，资源由本地 HTTP 提供、未做网络／CPU 限速；不得据此承诺低端设备或远程部署加载时间。完整 ZIP 和 XLSX 导出不在性能测量要求内，本轮未扩展测试或改变格式。

### 备份恢复上限

${table(['记录数', '实际 JSON Backup B', 'MiB', '现有 AppStore.restore 结果'], [p18, p100].map(row => [num(row.count), num(row.backupRoundTrip.bytes), mib(row.backupRoundTrip.bytes), row.backupRoundTrip.result.ok ? '成功，已有 ID 合并，无重复' : row.backupRoundTrip.result.message]))}

生产 \`MAX_JSON_BYTES=32×1024×1024\`，AppStore.restore 在读取 JSON 前拒绝超限；完整 ZIP 的 database.json 也使用同一 MAX_JSON_BYTES guard。100,000 条的实际拒绝是实测结果；ZIP 上限结论来自代码，未另做 ZIP 性能实验。本分布在约 2.7 万条就可能跨过 32 MiB（根据两个导出体积插值，**不是通用行数限制**）。这是数据可恢复性问题，不能靠删字段或假称“导出成功”解决。

## 增长规律与对 19 MB 的归因

Transaction 对象均值 925.86→927.47 B，基本稳定；账单期间数固定。记录 JSON 随 N 近似线性。统一写入时点的 origin 增量对四个规模做描述性线性拟合：**${slope.toFixed(1)} B/交易**，截距 **${mib(intercept)} MiB**，R²=**${rSquared.toFixed(6)}**。仅四个规模、100,000 条仍有明显 profile 波动，不能把截距解释成精确固定开销，也不能作为未来容量保证。

可合理归因的部分分别是：交易对象完整字段及重复来源／原文信息；约 0.96 MiB 的账单 JSON；显著的二级索引维护；结构化克隆、压缩、主键、LevelDB SST/log/manifest 与旧文件整理；附件只在独立 evidence 路径有贡献。不能用“origin 用量 − JSON”算精确索引大小，二者编码和采样时点不同。

因此，**19 MiB 不是本次实验发现的异常膨胀证据**。当前实现确有可讨论的重复信息与索引成本，但当前正常导入／备份操作未制造额外完整账本或重复交易。100,000 条容量仍能满足本环境；全量读取、排序、初始化、备份恢复需要独立改进。

## 优化建议与独立 PR 方案（本轮均未实施）

${table(['优先级', '独立 PR 范围', '数据依据与验证目标'], [
  ['P0', '修复大账本导出与恢复边界不一致', '100k 自导出 113.056 MiB JSON 被 32 MiB guard 拒绝。保持备份格式，定义导出／恢复一致的安全资源边界；评估有界读取／解析或提高上限并测内存预算，保留 ZIP bomb 防护。验收自导出 100k 可恢复、重复恢复不增行、冲突拒绝、恶意超限仍拒绝。'],
  ['P1', '减少单条编辑的全量读取和 React 重算；优化初始化', '100k readSnapshot 1.42s、刷新约1.92s、加载6.69s。评估按变更更新状态、分页查询／排序、初始化合并读取及一次性 demo 迁移标记。保持 ID／fingerprint／金融判重与来源语义；用本基准及现有完整性测试验证。'],
  ['P1', '主线程 XLSX 解析／历史预览性能单独优化', '100k 导入约44.7s，预览有9.581s long task。评估 worker／可中断进度与批量边界，保持 importer 金融结果和备份格式；重复测导入耗时和最长 long task。'],
  ['P2', '审计二级索引是否实际需要，再单独做迁移', `21个声明索引，3个boolean索引无entry；当前显式索引查询仅statementId。整体索引对照约${mib(median(indexDifferences))} MiB及写入代价。逐个保留必要查询能力；任何索引调整都在另外PR，需升级／回滚和浏览器基准。`],
  ['P2', '修复旧持久化 demo 启动清理留下孤立 notes／attachments', '孤立条件已在独立旧版 fixture 复现。只清有明确 demo 来源且不被真实 import／交易引用的记录，保留共享 hash 的真实证据。验收旧库迁移、共享引用与真实 notes 不误删。'],
  ['P3', '重复来源信息的编码／引用评估', '当前 v4 已删除冗余 merchant 字段。保留历史测量作为旧结构证据；如需量化物理收益，须重新运行浏览器基准，不推算收益。'],
])}

存储优化与性能优化分开：减少 JSON 字段并不自动消除全量快照／排序；删索引也不会自动加速当前 React 查询。优先处理已实测的恢复失败和可感知交互延迟，再评估存储改进。

## 交付与复现

- [完整原始结果](storage-results.json)：每次 estimate 样本、各表大小、字段分布、索引条目数、文件清单、性能样本、导入哈希、重复操作与附件实验。
- [只读重启与旧 demo 迁移原始结果](storage-maintenance-results.json)：复制 profile 的三轮读取轨迹和旧版清理前后表计数。
- [独立脚本说明](../../web/scripts/storage-benchmark/README.md)：环境、计时口径、隔离和限制。

在 web 中使用现有依赖和 Chromium：

\`\`\`sh
CHROMIUM_PATH=/usr/bin/chromium node scripts/storage-benchmark/run.mjs
node scripts/storage-benchmark/maintenance.mjs
node scripts/storage-benchmark/summarize.mjs
node scripts/storage-benchmark/report.mjs
\`\`\`

已完成生产模式构建、完整 Chromium 批次、独立 probe TypeScript 严格检查和脚本 ESLint。未用 fake-indexeddb 代替浏览器存储测量；未引入生产依赖。本报告来自 Linux Chromium 的单一硬件／浏览器版本；低端设备、高熵商户文本、更多独立原始附件和更多账单期间可能产生不同数值。所有测试 profile 和下载文件都是本轮新建的合成 artifacts，并保留在原始结果所记录的 scratch 目录中。
`
await writeFile(path.join(root, 'docs/benchmarks/storage-benchmark-report.md'), report)
