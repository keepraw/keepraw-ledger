# Keepraw-Ledger Comprehensive Repository Audit

**Audit and independent revision date:** 2026-10-17 (Asia/Shanghai; execution timestamps below are UTC)
**Repository:** [keepraw/keepraw-ledger](https://github.com/keepraw/keepraw-ledger)
**Audited application SHA:** `98d6ead1852b0134c560b39db04b33e8ae10d7a2`
**PR:** [#32](https://github.com/keepraw/keepraw-ledger/pull/32), `audit/full-repository-2026-10` → `main`
**Original report/PR head:** `164210edf359d8d002c8bf8fda2281912de865f5`
**Change boundary:** This Markdown report only. No application, formal test, dependency declaration, lockfile, schema, CI, deployment, or main-branch changes.

> Follow-up closure review: [2026-10-21 AUD-003 and all-findings verification](2026-10-21-audit-closure.md). This original report retains its historical baseline and findings.

## 1. Executive Summary

The independent audit confirms material correctness and isolation defects in the specified baseline. **The revised distribution is 0 P0, 4 P1, 8 P2, 1 P3, and 1 Recommendation.** Thirteen defects are Confirmed; the CSP recommendation is not a vulnerability. The original AUD-001–003 identifiers are retained. Findings are grouped by risk below, with new identifiers AUD-004–014.

The highest-priority problems are stale statement reconciliation after review/history changes, conflicting derived state after concurrent imports, omitted transactions when merchant text matches parser footer rules, and debit purchases classified as cashback from merchant keywords. These are demonstrated paths to incorrect trusted totals or incomplete imported records, despite the existing tests passing. Demo isolation also fails in both directions: demonstration notes enter real backups, and real notes remain visible in the purportedly fictional view.

The strongest existing controls remain valid: integer-minor-unit parsing, conservative exact-field/occurrence matching, transactional database upgrades and restore, bounded JSON/ZIP validation, original-file hash checks, and deployment from the artifact validated in the same workflow. Those controls do not repair the confirmed cross-module defects. No P0, remote code execution, demonstrated external exfiltration, or irreversible loss of the original uploaded evidence was established.

The independent revision preserves Manus's supported findings and positive observations, but **withdraws the original blanket statement that no incorrect financial total or silently omitted real transaction was found**. Six bank parser families, three history adapters, all 56 tracked files under `web/src`, persistence, exports, tooling, tests, configuration, and deployment workflow were inspected by dependency/data flow. This is a repository-wide engineering review, not a claim that every format, execution path, browser, or adversarial input has been dynamically exhausted.

## 2. Baseline, Independence, and Evidence Provenance

### Baseline checks

Before reading Manus's Findings, GitHub and Git were queried independently:

| Item | Observed value |
| --- | --- |
| `main`, PR base | `98d6ead1852b0134c560b39db04b33e8ae10d7a2` |
| PR head | `164210edf359d8d002c8bf8fda2281912de865f5` |
| PR state | Open; mergeable; no merge or auto-merge requested |
| Changed files | Only `docs/audits/2026-10-17-full-repository-audit.md`, originally 223 added lines |
| Initial PR CI | [Validation #39008207333](https://github.com/keepraw/keepraw-ledger/actions/runs/39008207333): web success; deploy skipped |
| Baseline inventory | 191 tracked files; PR head adds this report, with no application difference |

No newer application revision was substituted. The baseline worktree was clean. A second remote-ref check immediately before preparing publication returned the same main and original PR-head SHAs. The revision is appended to that PR head without rebasing or changing the application baseline.

The first pass mapped architecture and read implementation/tests without opening the original report or consulting its finding list. A preliminary independent finding ledger and 16 synthetic experiments were completed before the original 223-line report was read. The four supplied prior suspicions were treated as leads, not a complete list or an oracle. The expanded parser, classification, concurrency, resource, and tooling findings arose from tracing implementation and composing modules.

### Evidence labels

- **I — Independent:** source review, newly designed experiments, fresh execution of the locked baseline, browser verification, and current scale measurements in this revision.
- **M — Manus:** original report claims, retained only with attribution or independent corroboration. Identical test counts corroborate the baseline, not the existence of Manus's unretained local logs.
- **H — Historical:** checked-in benchmark/retirement/golden evidence from earlier commits. Historical results are not current performance measurements or current private-statement acceptance.
- **Confirmed:** dynamically reproduced, or equivalent direct observation proves the claim. Each finding states what was actually exercised.
- **Source-verified:** an explicit defect path is proven in implementation but not executed. Related unexecuted bank variants are labeled this way within findings and are not counted again.
- **Suspected:** plausible but not confirmed; excluded from defect totals.

### Environment and remote snapshot

Independent runs used Linux, Node `v24.19.0`, npm `11.9.0`, locked Vitest `4.1.11`, Vite `6.4.4`, SheetJS `0.20.3`, Playwright `1.64.0`, and Chromium `156.0.8078.4`. The container's CPU quota was four cores and memory limit 16 GiB; benchmark metadata reports five visible CPUs on an AMD EPYC 9V74 host. CI uses Node 22. Browser contexts/profiles and fixtures were newly generated; no existing private browser profile, personal statement, production ledger, or credential value was opened.

The preinstalled `node_modules` initially contained Vitest 3.2.7 and SheetJS 0.18.5 despite the lockfile. Those preliminary runs are **not** the release-validation evidence. `npm ci` installed the locked dependencies without changing either manifest or lockfile, followed by complete reruns. An initial sandbox subprocess denial and initially absent Chromium binary were environmental failures; they were resolved before the accepted results.

Independent read-only checks corroborated [baseline Validation #39007313053](https://github.com/keepraw/keepraw-ledger/actions/runs/39007313053), its successful web/deploy jobs, its non-expired 870,447-byte `github-pages` artifact, and successful deployment `7135457084` of the same SHA. A 2026-10-17 06:21:59 UTC request to [the public site](https://ledger.keepraw.com/) returned HTTP 200 without a CSP header. These are timestamped observations, not continuing availability or security guarantees. No deployment was performed.

## 3. Architecture and Audit Coverage

### Module inventory and dependencies

| Area | Inventory and responsibility | Interfaces examined |
| --- | --- | --- |
| Core | 12 files: types, money, dates, classify, identity, dedupe, ingest, migrationAudit, reconcile, reconciliation, analytics, dataQuality | Currency/sign/type → identity → trust → aggregate invariants; duplicate versus review semantics |
| Parsers | 11 files: six banks, extract, html, pdfLayout, registry, types | PDF coordinates, MIME decoding, inert HTML tables, bank selection, row recognition, summaries, dates, directions, parse failures |
| Historical import | 6 files: three adapters, legacyImport, workbook, types | XLSX decode → strict sheet/header detection → row anomalies/preview → fresh planning → persistence |
| Persistence/state | `db.ts`, `repository.ts`, `AppStore.tsx` | Six-store schema; upgrade; import/edit/note/clear/restore transaction scopes; queue; React snapshots; cross-tab behavior |
| Backup/export | 4 backup files and 2 export files | JSON V1/V2, ZIP manifest V1 with database V1/V2, attachment hashes, conflict handling, bounds, CSV/XLSX formulas and monetary text |
| Demo/UI/entry | 2 demo files, 11 UI files, `main.tsx` | All seven routes; theme/router; dashboard, list, review, quality, reconciliation, import and settings; visible versus persisted state |
| Golden/tooling | 4 golden files; 13 scripts/readmes | Normalization/redaction, comparison oracle, CLI generation/migration audit, synthetic benchmark fixture/probe/runner methodology |
| Tests/config/docs | 53 files under tests, 7 E2E files, one workflow, build/test/TS/lint/lock configuration; 23 baseline docs and 25 golden files | Business assertions versus implementation mirrors; fixture scope; skipped private acceptance; build provenance and historical evidence |

The counts describe an inventory, not a line-coverage percentage. All runtime module implementations and important callers were examined. Test suites were executed and risk-relevant assertions/fixtures reviewed; no new branch/statement coverage percentage is claimed. Existing desensitized golden artifacts are regression references, not newly supplied private financial evidence. The retired Python runtime and historical SQLite artifacts are not in this application's active tree; no unavailable historical database was fabricated or certified.

### Data flow, persistence boundaries, and state transitions

1. **Bank import:** File → complete buffer/hash/evidence copy → extraction → explicit parser → typed rows/summary → occurrence assignment/exact matching → reconciliation → atomic financial-row/import commit → separate best-effort attachment writes → React reload. Parsing failures retain readable bytes too. The late size check matters in AUD-014.
2. **History import:** XLSX → one of three fixed adapters → preview/anomalies → replan against a new snapshot → atomic statement/import/new-row commit → reload. Existing statement summaries and trust are copied, creating AUD-004; the snapshot and commit are not one cross-tab atomic planning operation, creating AUD-005.
3. **Review:** `ok/pending` → `confirmed/rejected`; confirmation clears flags, rejection changes inclusion. `patchTransaction` changes only the row. Dashboard/quality consume stored statement status, whereas the reconciliation page recomputes a different net-total check. The Review recompute button discards its result. Thus row, persisted statement, and UI trust can disagree.
4. **Storage:** `statements(id)`, `transactions(id, statementId)`, `imports(id)`, `settings(key)`, `reviewNotes(transactionId)`, `attachments(fileHash)`. V1 creates the first five stores; V2 adds evidence; V3 removes unused secondary indexes without rewriting business objects. Transaction ownership, independent notes, and the lack of database foreign keys require application invariants.
5. **Backup:** one read transaction captures financial rows/settings/notes; ZIP then reads evidence, validates hashes, and derives the manifest from the captured imports. Restore validates/decompresses before one write transaction (including attachments for ZIP). V1 preserves local notes; V2 merges notes and rejects conflicting content. Complete new statements preserve recorded decisions; partial/existing statements receiving rows are recalculated.
6. **Demo:** a preference selects a cached memory snapshot for visible financial rows while the real snapshot and notes remain loaded. Imports check committed preferences. Edit and note APIs do not select an independent demo state. Backup/restore/clear operate on real storage even when the demo view is active; XLSX uses the visible snapshot. Settings clearly identifies real-data deletion, so that explicit deletion is not mislabeled as an unauthorized operation.
7. **Concurrency:** the promise queue serializes operations within one `AppProvider`. Dexie serializes individual write transactions. Neither is a lock across read/plan/write operations in different tabs, and no live-query/BroadcastChannel refresh synchronizes their React snapshots.

### Risk coverage and limits

| Domain | Independent verification | Remaining boundary |
| --- | --- | --- |
| Money/business | Six-bank regressions, 6,000 deterministic money roundtrips, merchant classification mutation, negative balances, trust-state transitions | All issuer fee/refund/netting/installment variations not proven; extreme aggregate overflow not stress-tested |
| Identity/integrity | Exact-match/collision regressions, repeated import/restore, delete/reimport, 100k overlap scenario, concurrent disjoint import plans | Same fields on disjoint sources cannot establish real-world identity; card-tail ambiguity remains |
| Parsing/import | All six implementations and three adapters; synthetic malformed amounts/currencies/dates and footer mutation; BOC layout currency experiment | Current private issuer files, OCR, arbitrary MIME/PDF/XLSX fuzzing excluded |
| Database/lifecycle | Real Chromium v1/v2→v3 and abort E2E, note-write fault injection, independent cross-tab experiments | Physical storage failure, actual quota exhaustion, crash/power-loss recovery and eviction not tested |
| Backup/recovery | V1/V2 JSON/ZIP tests, conflicts, invalid schema, late rollback, repeated restore, 100k campaign below | No full differential ZIP fuzzer or low-memory browser guarantee |
| Demo/privacy/security | Real notes shown in demo, demo notes exported, no-op review, inert malicious HTML/network observation, dependency/sink scan | No remote exploit established; extensions, device compromise and a genuine sharing incident not tested |
| Performance/architecture | Current production-build 18k/100k campaign; source complexity and state-ownership review; bounded oversized-input failure | One host/browser; no latency SLA, mobile/low-memory certification or rewrite recommendation |
| Tests/CI/deployment | Locked clean install, types/lint/tests/build/E2E, CI/artifact/deployment APIs | Main deployment and rollback were inspected, not executed; required branch protection not certified |

## 4. Severity Standards and Finding Register

- **P0 — Critical:** broadly reachable catastrophic integrity loss, unrecoverable destruction, or active severe compromise requiring emergency containment. None established.
- **P1 — High:** a concrete supported workflow silently produces materially wrong trusted financial data or omits transaction records, warranting a priority correctness fix. Frequency and recoverability are stated; P1 does not imply irreversible loss.
- **P2 — Medium:** bounded privacy/isolation, backup availability, parsing/financial-display or scale defects with narrower preconditions, visible review/failure signals, or a viable alternative recovery path.
- **P3 — Low:** broken demonstration behavior/usability without demonstrated real financial modification.
- **Recommendation:** defense in depth or an improvement without an established current exploit/defect of that severity.

| ID | Severity | Status | Finding | Origin |
| --- | --- | --- | --- | --- |
| AUD-004 | P1 | Confirmed | Review/history changes leave persisted reconciliation and trust stale | I |
| AUD-005 | P1 | Confirmed | Concurrent import plans overwrite statement metadata with stale counts/trust | I |
| AUD-008 | P1 | Confirmed | Footer recognition inspects transaction text and silently truncates records | I |
| AUD-011 | P1 | Confirmed | Merchant keywords classify a debit purchase as cashback in trusted history | I |
| AUD-001 | P2 | Confirmed | Demo and real notes share storage and display, contaminating backups and exposing real notes | M + I, expanded |
| AUD-002 | P2 | Confirmed | Whole-list main-thread work remains a measured large-ledger interaction bottleneck | M + H + I |
| AUD-007 | P2 | Confirmed | Amount sorting uses lexical comparison; regression oracle preserves the bug | I |
| AUD-009 | P2 | Confirmed | ABC slash-form short dates select the wrong year across New Year | I |
| AUD-010 | P2 | Confirmed | Negative opening balances are converted to positive debt | I |
| AUD-012 | P2 | Confirmed | BOC foreign-currency summary rows are labeled and reconciled as CNY | I |
| AUD-013 | P2 | Confirmed | Golden “desensitization” retains identifying text and formatted card numbers | I |
| AUD-014 | P2 | Confirmed | Rejected oversized input is archived and makes full backups fail | I |
| AUD-006 | P3 | Confirmed | Demo confirmation, exclusion and categorization have no effective target | I |
| AUD-003 | Recommendation | Observed missing control | Hosting response lacks CSP; no current XSS demonstrated | M + I |

Counts are **13 Confirmed defects: P1=4, P2=8, P3=1**, plus **1 Recommendation**. Related variants, test gaps, and suspected risks are not counted separately.

## 5. Findings

### AUD-004 — Review/history changes leave persisted reconciliation and trust stale

**P1; Confirmed; high confidence.** Locations: [repository patch](https://github.com/keepraw/keepraw-ledger/blob/98d6ead1852b0134c560b39db04b33e8ae10d7a2/web/src/db/repository.ts#L76-L85), [Review recompute](https://github.com/keepraw/keepraw-ledger/blob/98d6ead1852b0134c560b39db04b33e8ae10d7a2/web/src/ui/pages/ReviewPage.tsx#L47-L62), [history statement reuse](https://github.com/keepraw/keepraw-ledger/blob/98d6ead1852b0134c560b39db04b33e8ae10d7a2/web/src/importers/legacyImport.ts#L229-L242), [dashboard trust](https://github.com/keepraw/keepraw-ledger/blob/98d6ead1852b0134c560b39db04b33e8ae10d7a2/web/src/ui/pages/DashboardPage.tsx#L21-L29).

**Trigger and reproduction (I-A01/A02):** Create a synthetic statement with two debit rows of 12,880 minor units but bank debit/current balance 12,880. Import yields `needs_review`. Reject one duplicate and click “重新计算对账结果”. The pure detailed reconciler now returns `passed`; IndexedDB still says `needs_review`, and default trusted spending remains **0 instead of 12,880**. Conversely, import a balanced one-row statement, then a valid `标准字段` workbook with a different description but the same bank/card/cycle and another 12,880 debit. The two-row statement retains `reconciled`; trusted spending becomes **25,760**, although a fresh reconcile reports `mismatch` against bank debit 12,880.

**Expected/actual:** Changes affecting financial inclusion must atomically update or invalidate derived reconciliation. Instead, the patch transaction excludes statements; the button calculates a result then executes `void result`; the legacy plan copies prior reconciliation/status and only changes count. Reloading reads the stale persisted result. The independent React/Dexie test used the actual provider and Review button, not a mocked store.

**Impact/severity:** Legitimate corrections can remain excluded, and inconsistent additions can enter default trusted totals. Backup preserves this state too. This is high-priority financial correctness, not proof that money rows themselves were erased.

**Fix/regression:** Give statement derivation one repository-owned transaction/API; recompute after rejection/restoration and appended rows, retaining the intentional historical `imported` semantics without forging bank reconciliation. Test both directions, page navigation, reload, backup roundtrip, and concurrent edits. Do not “fix” it by merely setting every reviewed statement to passed. Unexecuted type/amount edits are not needed for this reproduction.

### AUD-005 — Concurrent import plans overwrite statement metadata with stale counts/trust

**P1; Confirmed; high confidence.** Locations: [per-provider queue and snapshot planning](https://github.com/keepraw/keepraw-ledger/blob/98d6ead1852b0134c560b39db04b33e8ae10d7a2/web/src/app/AppStore.tsx#L96-L105), [import planning](https://github.com/keepraw/keepraw-ledger/blob/98d6ead1852b0134c560b39db04b33e8ae10d7a2/web/src/app/AppStore.tsx#L145-L190), [financial commit](https://github.com/keepraw/keepraw-ledger/blob/98d6ead1852b0134c560b39db04b33e8ae10d7a2/web/src/db/repository.ts#L41-L54), [history commit](https://github.com/keepraw/keepraw-ledger/blob/98d6ead1852b0134c560b39db04b33e8ae10d7a2/web/src/db/repository.ts#L57-L72).

**Trigger/reproduction (I-A03):** Two contexts read an empty ledger and plan imports for the same bank/card/cycle, each with a distinct 12,880 purchase and a balanced one-row summary. Commit both plans. Different IDs avoid the `bulkAdd` collision protection. The database contains **two transactions**, but the last statement write records **count 1, status `reconciled`**; recomputation yields `mismatch`. The controlled interleaving proves the read/plan/write race without needing timing luck. The same interleaving was independently repeated in two actual Chromium tabs sharing native IndexedDB, using the production planner/repository imports: `{rows: 2, storedCount: 1, storedStatus: "reconciled", recomputed: "mismatch"}`. This was a deterministic API-level browser experiment, not an automated simultaneous file-picker gesture. Separate Chromium tabs also demonstrate stale UI: after one tab changes a category, the other keeps the previous category until reload.

**Expected/actual:** Concurrent imports must reconcile against all committed rows or reject stale plans. Existing transactions are preserved, but `statements.put` unconditionally replaces derived metadata calculated from the earlier snapshot. A provider-local queue is not cross-tab serialization; transaction atomicity does not make pretransaction reads current.

**Impact/severity:** Trusted statistics and counts can disagree with committed data, with no primary-key exception or mismatch warning. This merits P1 despite requiring overlapping operations. No overwrite of an unrelated transaction was demonstrated; same-ID collision abort remains a positive control.

**Fix/regression:** Revalidate/rebuild the plan under a cross-context lock or a suitable atomic read/modify/write transaction; publish committed snapshot changes to other tabs. Exercise disjoint and overlapping IDs, simultaneous import/clear, failed commits, and independently mounted providers. Keep expensive extraction outside the write transaction, but verify its planning preconditions inside the consistency boundary.

### AUD-008 — Footer recognition inspects transaction text and silently truncates records

**P1; Confirmed for CCB; high confidence.** Locations: [CCB footer pattern](https://github.com/keepraw/keepraw-ledger/blob/98d6ead1852b0134c560b39db04b33e8ae10d7a2/web/src/parsers/ccb.ts#L18-L19), [CCB row loop](https://github.com/keepraw/keepraw-ledger/blob/98d6ead1852b0134c560b39db04b33e8ae10d7a2/web/src/parsers/ccb.ts#L267-L286), [currency-scoped reconcile](https://github.com/keepraw/keepraw-ledger/blob/98d6ead1852b0134c560b39db04b33e8ae10d7a2/web/src/core/reconcile.ts#L26-L40). Similar transaction-text footer paths exist in [ABC](https://github.com/keepraw/keepraw-ledger/blob/98d6ead1852b0134c560b39db04b33e8ae10d7a2/web/src/parsers/abc.ts#L342-L370), [BOCOM](https://github.com/keepraw/keepraw-ledger/blob/98d6ead1852b0134c560b39db04b33e8ae10d7a2/web/src/parsers/bocom.ts#L215-L242), [ICBC](https://github.com/keepraw/keepraw-ledger/blob/98d6ead1852b0134c560b39db04b33e8ae10d7a2/web/src/parsers/icbc.ts#L309-L320), and [CITIC](https://github.com/keepraw/keepraw-ledger/blob/98d6ead1852b0134c560b39db04b33e8ae10d7a2/web/src/parsers/citic.ts#L313-L327); these variants are Source-verified, not separately reproduced incidents.

**Trigger/reproduction (I-A06):** In `SYNTHETIC_CCB_HTML` (14 valid rows), insert three valid eight-cell USD/USD debit rows before the true footer, dated `2026-08-10`, card `5678`, amount `10.00` on both legs. Use descriptions `消费 audit before`, `消费 The End Store`, `消费 audit after`. Expected: 17 records, with the USD rows retained outside CNY totals. Actual: **15 records**; the marker-containing row and subsequent row vanish, and ingest reports **`reconciled`**. Existing CNY totals are unchanged, so reconciliation cannot detect those omissions. CCB's footer vocabulary even includes `违约金`, also a legitimate transaction type token.

**Expected/actual:** Footer detection should require structural/footer-row evidence, not a substring in a date-bearing transaction description. The loop tests all joined cell text before row parsing and executes `break`. No omitted-row anomaly is emitted.

**Impact/severity:** A successful import can silently omit legitimate records and its file hash then blocks ordinary repeat import from recovering them. Raw evidence remains archived if retention succeeds; this is not claimed as irreversible source loss. Financial data completeness justifies P1.

**Fix/regression:** Recognize valid transaction shape first; constrain footer rules to structural rows/sections and account for every candidate row. Test marker words in merchants, fee/credit rows, repeated headers, multiple tables, and foreign/zero-net/installment rows that bank totals cannot expose.

### AUD-011 — Merchant keywords classify a debit purchase as cashback in trusted history

**P1; Confirmed; high confidence.** Locations: [type regexes and fallback](https://github.com/keepraw/keepraw-ledger/blob/98d6ead1852b0134c560b39db04b33e8ae10d7a2/web/src/core/classify.ts#L16-L39), [history classifier call/flags](https://github.com/keepraw/keepraw-ledger/blob/98d6ead1852b0134c560b39db04b33e8ae10d7a2/web/src/importers/legacyKeeprawExportV1.ts#L120-L131), [imported trust](https://github.com/keepraw/keepraw-ledger/blob/98d6ead1852b0134c560b39db04b33e8ae10d7a2/web/src/importers/legacyImport.ts#L237-L255), [financial aggregation](https://github.com/keepraw/keepraw-ledger/blob/98d6ead1852b0134c560b39db04b33e8ae10d7a2/web/src/core/reconcile.ts#L268-L295).

**Trigger/reproduction (I-A09):** Create a fixed-schema `交易明细` workbook with bank 中国银行, card `1234`, valid dates, description `示例优惠超市`, CNY/CNY, and **positive 100.00** in both amount columns. Preview, plan, and persist through the real adapter. The row becomes `{type: 'cashback', direction: 'debit', reviewStatus: 'ok', flags: []}`. Its historical statement is `imported`, so default analytics trusts it. Result: **actual spending 0, displayed cashback -100.00, billing debit 100.00**.

**Expected/actual:** An ordinary merchant name must not override signed debit evidence into an incompatible credit business type without review. The regex alternatives such as `优惠`, `还款`, `服务费` are not uniformly anchored, and `inferTransactionType('', description, direction)` scans merchant text before direction fallback. The source comment saying “never merchant-name guessing” is not the implemented behavior.

**Impact/severity:** Valid everyday history can silently understate spending and misstate refund/cashback/payment breakdowns. This is P1 even though the signed stored amount remains intact. Net billing and spending are distinct metrics; preserving one does not make the other correct.

**Fix/regression:** Separate structured bank tokens from arbitrary descriptions; require compatible sign/type semantics or mark ambiguous rows for review. Test merchant strings containing each keyword in the middle, genuine cashback/refund tokens, debit fee cases, and trusted history/dashboard results. The same helper is shared by other adapters/parsers, but this finding's dynamic proof is the Keepraw history path.

### AUD-001 — Demo and real notes share storage and display

**P2; Confirmed; high confidence.** Manus's original finding is retained and expanded. Locations: [real note loading](https://github.com/keepraw/keepraw-ledger/blob/98d6ead1852b0134c560b39db04b33e8ae10d7a2/web/src/app/AppStore.tsx#L105-L113), [unconditional note save](https://github.com/keepraw/keepraw-ledger/blob/98d6ead1852b0134c560b39db04b33e8ae10d7a2/web/src/app/AppStore.tsx#L319-L327), [note display](https://github.com/keepraw/keepraw-ledger/blob/98d6ead1852b0134c560b39db04b33e8ae10d7a2/web/src/ui/pages/ReviewPage.tsx#L286-L333), [all-note export](https://github.com/keepraw/keepraw-ledger/blob/98d6ead1852b0134c560b39db04b33e8ae10d7a2/web/src/db/repository.ts#L147-L164), [provenance-based purge](https://github.com/keepraw/keepraw-ledger/blob/98d6ead1852b0134c560b39db04b33e8ae10d7a2/web/src/db/repository.ts#L290-L307).

**Trigger/reproduction (M; independently I-A04/browser):** Store a real synthetic statement with note `SYNTHETIC REAL NOTE`, enable Demo, and open Review. The **real note remains visible** while the shell says current pages are fictional and real bills are hidden. Save `SYNTHETIC DEMO NOTE` against a flagged demo row. It enters real `reviewNotes`, appears in V2 JSON, and survives demo regeneration/purge because no persisted demo transaction proves its provenance. Independent Chromium observed both note markers in the backup with **zero demo transaction rows**. Manus's earlier empty-ledger reproduction (0 stored transactions/1 note) is consistent with this behavior.

**Expected/actual:** Both reads and writes of demonstration notes should use isolated state. Instead, `state.notes` is real storage in either mode; the component enumerates every note and merely says “transaction no longer exists” when its real transaction is hidden. The panel appears only when flagged visible transactions exist, which is true for the demo fixture.

**Impact/severity:** Sensitive user text can be exposed during a demonstration; demo text contaminates real backups and becomes hard to identify. P2 reflects the local demonstration precondition and no demonstrated network disclosure, rather than denying the privacy impact. No transaction amount was changed.

**Fix/regression:** Isolate note read/write ownership at the state/persistence boundary, including queued mode switches. Preserve legitimate orphan notes and existing V2 recovery; do not delete arbitrary orphans based only on an ID pattern. Test real-note invisibility in Demo, demo-note exclusion from JSON/ZIP, exit/regeneration/reload, and real-note persistence/conflicts.

### AUD-002 — Whole-list work remains a large-ledger interaction bottleneck

**P2; Confirmed; high confidence in the path, host-dependent impact.** Locations: [filter/sort before page slice](https://github.com/keepraw/keepraw-ledger/blob/98d6ead1852b0134c560b39db04b33e8ae10d7a2/web/src/ui/pages/TransactionsPage.tsx#L17-L57), [filter scan](https://github.com/keepraw/keepraw-ledger/blob/98d6ead1852b0134c560b39db04b33e8ae10d7a2/web/src/core/analytics.ts#L26-L36), [snapshot loading](https://github.com/keepraw/keepraw-ledger/blob/98d6ead1852b0134c560b39db04b33e8ae10d7a2/web/src/db/repository.ts#L27-L34), [current benchmark runner](https://github.com/keepraw/keepraw-ledger/blob/98d6ead1852b0134c560b39db04b33e8ae10d7a2/web/scripts/large-ledger/run.mjs#L275-L294).

**Trigger/expected/actual:** Search or change sort order with 100,000 records. A 50-row rendered page should not be interpreted as a 50-row query: the application retains the complete snapshot, scans it, clones and sorts all matching rows, then slices. Main-thread work is O(N) plus O(N log N), with multiple full-array allocations. Independent current-build measurements are in §8; the original historical 486.5 ms description-sort result is retained only as H evidence.

**Impact/severity:** Noticeable input delay at the supported stress scale, with higher resource pressure on weaker devices. This is P2 responsiveness, not a claim of data corruption or proof that 100k records always fail. The independent oversized-input backup failure is separately AUD-014; it is not inferred from latency alone.

**Fix/regression:** Profile complete visible interactions, then consider worker-based comparison, indexed queries, or narrower state subscriptions. Preserve numeric correctness (AUD-007), stable ties, filters, exact identities and full-history semantics. Keep bounded multi-profile 18k/100k benchmarks and a declared device/latency budget. No rewrite is justified solely by a large component or this single host. Low-memory/mobile limits remain unverified.

### AUD-007 — Amount sorting uses strings; the existing test preserves the error

**P2; Confirmed; high confidence.** Locations: [comparator](https://github.com/keepraw/keepraw-ledger/blob/98d6ead1852b0134c560b39db04b33e8ae10d7a2/web/src/ui/pages/TransactionsPage.tsx#L17-L27), [existing oracle](https://github.com/keepraw/keepraw-ledger/blob/98d6ead1852b0134c560b39db04b33e8ae10d7a2/web/tests/ledgerState.test.tsx#L113-L130).

**Trigger/reproduction (I-A05):** Sort same-currency minor amounts `[-10000, -200, 200, 10000, 3000]` ascending. Actual: `[-10000, -200, 10000, 200, 3000]`; **100.00 appears before 2.00**. Expected: numeric monotonic order. The comparator uses `collator.compare(String(left), String(right))` for money. The regression test constructs the same historical string comparator, so all supported-key assertions pass while financial ordering is wrong.

**Impact/severity:** Users selecting largest/smallest transactions or exported sorted rows can be misled. This changes order, not sums, hence P2. Cross-currency ordering needs a declared policy but is not required to reproduce the defect.

**Fix/regression:** Numeric comparison for amounts, explicit date/text comparators, retained null placement/stability. Assert numeric monotonicity independently using negative, zero, different-width, equal and boundary values; do not freeze a defective comparator as the expected result.

### AUD-009 — ABC slash-form dates choose the wrong year

**P2; Confirmed; high confidence.** Location: [ABC date resolution](https://github.com/keepraw/keepraw-ledger/blob/98d6ead1852b0134c560b39db04b33e8ae10d7a2/web/src/parsers/abc.ts#L276-L320), used by [row parsing](https://github.com/keepraw/keepraw-ledger/blob/98d6ead1852b0134c560b39db04b33e8ae10d7a2/web/src/parsers/abc.ts#L378-L389).

**Trigger/reproduction (I-A07):** Cycle `2025-12-15`–`2026-01-14`: `resolveAbcDate('1220', cycle)` gives `2025-12-20`, but `resolveAbcDate('12/20', cycle)` gives **`2026-12-20`**. Both denote the same short date in the supported resolver. The slash branch always chooses the cycle-end year, unlike the compact branch's cycle search.

**Expected/actual and impact:** Preserve the cycle-consistent date or flag ambiguity. Instead a valid date eleven months after cycle close can enter the transaction, fingerprint and monthly/yearly statistics. Monetary reconciliation does not validate the year. P2 reflects a narrow representation/year-boundary precondition; no actual private statement was tested.

**Fix/regression:** Share the existing cycle-aware short-date resolution, including adjacent posting dates and leap days. Test MMDD/MM/DD/MM.DD equivalence across December/January, end-of-month, missing-cycle and invalid-date cases through parser→ingest, not only the helper.

### AUD-010 — Credit opening balances become positive debt

**P2; Confirmed for CCB; high confidence.** Locations: [CCB absolute previous balance](https://github.com/keepraw/keepraw-ledger/blob/98d6ead1852b0134c560b39db04b33e8ae10d7a2/web/src/parsers/ccb.ts#L165-L185); analogous [ICBC opening/current balance](https://github.com/keepraw/keepraw-ledger/blob/98d6ead1852b0134c560b39db04b33e8ae10d7a2/web/src/parsers/icbc.ts#L211-L236) and [CITIC opening balance](https://github.com/keepraw/keepraw-ledger/blob/98d6ead1852b0134c560b39db04b33e8ae10d7a2/web/src/parsers/citic.ts#L195-L214) are Source-verified variants.

**Trigger/reproduction (I-A08):** In the synthetic CCB summary use previous **-3000.00**, debit 6500.00, credit 7200.00, current **-3700.00**; retain the matching transaction details. The correct equation is -3000 + 6500 - 7200 = -3700. Parser output changes previous to **+3000.00** via `Math.abs`, retains current -3700.00, and reports mismatch.

**Expected/actual and impact:** A balance is signed debt/credit, unlike a magnitude-only charge subtotal. The parser discards explicit credit-balance sign, producing misleading balance details and excluding an otherwise valid statement. P2 rather than P1 because this tested path fails reconciliation visibly; no false passed total was demonstrated here.

**Fix/regression:** Model signed balances separately from positive debit/credit aggregates. Test overpayments/credit balances and negative carry-forward across consecutive statements for each bank, including qualifiers and fallback summary tables. Confirm the actual bank template semantics before changing all `abs` calls indiscriminately.

### AUD-012 — BOC foreign summaries are relabeled CNY

**P2; Confirmed in a synthetic PDF-layout experiment; high confidence in implementation, limited format prevalence evidence.** Location: [summary row selection and currency assignment](https://github.com/keepraw/keepraw-ledger/blob/98d6ead1852b0134c560b39db04b33e8ae10d7a2/web/src/parsers/boc.ts#L204-L251); BOC transaction output is [fixed CNY](https://github.com/keepraw/keepraw-ledger/blob/98d6ead1852b0134c560b39db04b33e8ae10d7a2/web/src/parsers/boc.ts#L437-L445).

**Trigger/reproduction (I-A10):** Build `buildSyntheticBocPdf()`, change the summary account label `人民币/RMB` to `美元/USD`, retain the RMB detail section and numeric layout, and parse. Every resulting summary component is labeled **CNY** and the statement still **reconciles**. The selector explicitly accepts RMB/USD/HKD rows, takes the first suitable one in layout order, then writes `currency: 'CNY'` regardless of the matched account label.

**Expected/actual and impact:** Currency-scoped reconciliation must compare RMB details with an RMB summary, or mark the required summary unavailable. The current path can compare unrelated currency-account numbers and display a mislabeled balance. P2 reflects the specific altered/multi-account-layout precondition and absence of current private-format evidence; this experiment proves the unsafe acceptance, not its frequency among bank PDFs.

**Fix/regression:** Bind summary and detail sections to explicit account/currency scope; unsupported non-RMB sections must not be coerced. Test USD/HKD/RMB summary order permutations, identical numeric totals across accounts, and missing RMB summaries through extracted PDF layouts.

### AUD-013 — Golden desensitization retains identifying source text

**P2; Confirmed with synthetic text; high confidence.** Locations: [raw-text masker](https://github.com/keepraw/keepraw-ledger/blob/98d6ead1852b0134c560b39db04b33e8ae10d7a2/web/src/golden/normalize.ts#L110-L150), [generator's default redaction/output](https://github.com/keepraw/keepraw-ledger/blob/98d6ead1852b0134c560b39db04b33e8ae10d7a2/web/scripts/generate-golden.ts#L17-L30), [normalization and JSON write](https://github.com/keepraw/keepraw-ledger/blob/98d6ead1852b0134c560b39db04b33e8ae10d7a2/web/scripts/generate-golden.ts#L78-L92).

**Trigger/reproduction (I-A11):** `desensitizeRawText('消费合成姓名测试商户 4111-1111-1111-1111')` retains the synthetic identifying phrase and grouped test card number. A CJK run containing any structural keyword is returned verbatim; the digit regex masks only contiguous runs of at least 16 digits. `normalizeWebStatement` stores this raw text while setting `desensitized: true` by default.

**Expected/actual and impact:** Generated material advertised as desensitized and intended for golden fixtures should not keep an entire identifying phrase just because it contains `消费`, or a formatted full card number. Publication could disclose sensitive source content. No actual private data was inspected and no existing published leak is asserted. P2 is conditional tooling/privacy risk, not remote compromise of the ledger app.

**Fix/regression:** Prefer an allowlist of structural output fields; remove raw text from shareable fixtures or tokenize/mask nonstructural content robustly. Treat dates/amounts/tails/hash pseudonyms as potentially identifying too. Test synthetic names embedded beside every allowed keyword, Chinese/Latin names and spaced/hyphenated card formats, and require human review before publishing fixtures. Do not claim irreversible anonymization from simple hashing.

### AUD-014 — Rejected oversized files still enter evidence storage and block full backup

**P2; Confirmed; high confidence.** Locations: [read/hash/copy before extraction](https://github.com/keepraw/keepraw-ledger/blob/98d6ead1852b0134c560b39db04b33e8ae10d7a2/web/src/app/AppStore.tsx#L156-L169), [failed-result evidence retention](https://github.com/keepraw/keepraw-ledger/blob/98d6ead1852b0134c560b39db04b33e8ae10d7a2/web/src/app/AppStore.tsx#L199-L240), [25 MiB extraction check](https://github.com/keepraw/keepraw-ledger/blob/98d6ead1852b0134c560b39db04b33e8ae10d7a2/web/src/parsers/extract.ts#L48-L57), [64 MiB ZIP entry rejection](https://github.com/keepraw/keepraw-ledger/blob/98d6ead1852b0134c560b39db04b33e8ae10d7a2/web/src/backup/archive.ts#L72-L80), [uncaught full-backup UI rejection](https://github.com/keepraw/keepraw-ledger/blob/98d6ead1852b0134c560b39db04b33e8ae10d7a2/web/src/ui/pages/SettingsPage.tsx#L214-L233).

**Trigger/reproduction (I-A15):** Supply a synthetic 65 MiB `application/pdf` file backed by an `ArrayBuffer` to the real AppProvider import API. Parsing correctly reports failed/over 25 MiB, but the file is read, hashed, copied and **all 65 MiB are archived**. Subsequent `buildFullBackupZip()` rejects with `原始文件过大，无法生成可恢复备份` because originals are capped at 64 MiB. The experiment used bounded synthetic memory, not a malicious decompression bomb.

**Expected/actual and impact:** Reject oversized input before allocating/retaining it, or explicitly use a retention policy compatible with backup budgets. The failed import currently makes every full ZIP export fail; there is no per-attachment removal UI, and the Settings handler lacks a rejection message. JSON data-only backup remains available and financial rows are preserved, so this is P2 availability/recovery risk, not total unrecoverability. The observed failure is stronger evidence than a speculative “large files may be slow” claim.

**Fix/regression:** Enforce file size before `arrayBuffer`, bound aggregate batch retention, harmonize import/evidence/export limits, and surface backup failures. Test limits at 25/64 MiB, oversized failed/unsupported inputs, multi-file budgets, missing-evidence manifests and quota failures without discarding valid financial data.

### AUD-006 — Demo transaction controls have no effective mutation target

**P3; Confirmed; high confidence.** Locations: [patch API](https://github.com/keepraw/keepraw-ledger/blob/98d6ead1852b0134c560b39db04b33e8ae10d7a2/web/src/app/AppStore.tsx#L307-L317), [missing-row return](https://github.com/keepraw/keepraw-ledger/blob/98d6ead1852b0134c560b39db04b33e8ae10d7a2/web/src/db/repository.ts#L76-L85), [memory-only demo](https://github.com/keepraw/keepraw-ledger/blob/98d6ead1852b0134c560b39db04b33e8ae10d7a2/web/src/demo/demoStore.ts#L14-L24), [active demo review controls](https://github.com/keepraw/keepraw-ledger/blob/98d6ead1852b0134c560b39db04b33e8ae10d7a2/web/src/ui/pages/ReviewPage.tsx#L254-L281).

**Trigger/reproduction (I-A04/browser):** On a fresh demo view, select Confirm on the first review row. Independent Chromium observed **13 rows before and 13 after**; the transaction/flags were unchanged. Exclude and category controls use the same missing-database-row path. Expected: edit the demo snapshot or clearly disable editing. Actual: the API looks only in real Dexie transactions, finds no demo row, and silently returns. The notice nevertheless promises locally persisted review results.

**Impact/fix/regression:** Broken demonstration and misleading interaction, with no demonstrated real financial edit; hence P3. Use isolated mutable demo state or honest disabled controls, and test confirmation/exclusion/category changes, regeneration, mode transitions, and the invariant of zero real writes. A real-record editing E2E test is not coverage for this path.

### AUD-003 — Add a compatible hosting CSP as defense in depth

**Recommendation; independently observed missing control; no exploit established.** Surface: [HTML entry](https://github.com/keepraw/keepraw-ledger/blob/98d6ead1852b0134c560b39db04b33e8ae10d7a2/web/index.html#L1-L19) and [public hosting response](https://ledger.keepraw.com/).

The independent HTTP 200 response lacked `Content-Security-Policy`; HTML contains `no-referrer` but no CSP meta policy. Source review found no application fetch/telemetry upload, untrusted HTML rendering sink, `eval`, or `dangerouslySetInnerHTML`. The independent malicious HTML probe (script, event handler, external image/iframe, JavaScript link) executed no marker and produced zero external requests in Chromium. These are bounded negative observations, not an XSS proof.

A future injection or compromised static dependency would have fewer browser-enforced constraints. Add the narrowest compatible hosting policy, including legitimate PDF worker needs, then verify real headers and browser functionality. Test external script/connect rejection and local worker loading. CSP absence alone is not P1/P2 and does not establish current exfiltration.

## 6. Challenge to Manus's Original Report

| Original claim/finding | Independent disposition |
| --- | --- |
| AUD-001 demo note persistence, P2 | **Retained and reproduced.** Expanded to real-note display in Demo, failed cleanup provenance, and populated-ledger/browser proof. P2 remains appropriate; no financial-row mutation was observed. |
| AUD-002 whole-list filtering/sorting, P2 | **Retained.** Current measurements supplement historical timing. “Unbounded” means proportional to the full dataset, not infinite execution. Correct numeric order must replace the suggested preservation of all historical sort behavior. |
| AUD-003 absent CSP, Recommendation | **Retained and independently sampled.** No current XSS demonstrated; no severity inflation. |
| P0=0 | **Retained as an evidence-limited finding**, not a safety certificate. |
| P1=0; no incorrect total or silent transaction omission | **Overturned** by AUD-004/005/008/011. Passing financial tests did not cover these transitions/input mutations. |
| Complete Demo isolation for financial views | **Qualified.** Memory-only transaction generation works, but notes cross both display/storage boundaries and controls are ineffective. |
| Typed parser/error boundaries mean malformed inputs do not look successful | **Narrowed.** Unknown/recognized malformed money fail as tested; row-recognition omissions can still yield a reconciled subset. |
| Exact-field dedupe protects against hash-only merging | **Retained.** Exact tuple and occurrence allocation are real controls; the concurrency failure is statement metadata, not a fabricated FNV collision exploit. |
| Restore atomicity, conflict checks, migrations/deletion | **Retained with expanded tests and current scale evidence.** Does not imply recovery availability after every import; AUD-014 is a different failure. |
| Historical source-hash/timing distinction | **Retained as accurate.** Sorter hash matches `after.json`; other source hashes differ. Historical 2.815 GiB RSS and restore times are not relabeled current. |
| Local 608/6 and 24/2 test results | **Independently corroborated after `npm ci`.** Original machine timings/npm version remain attributed to Manus; this report uses the independent environment for new evidence. |
| No remote frontend injection found | **Retained only for examined paths/probes.** Does not cover demo note disclosure or golden output redaction. |
| Generally separated modules, no rewrite warranted | **Retained, but state ownership is materially incomplete.** Derived trust, notes, and cross-tab state require coordinated fixes. File length/language choice is not itself a defect. |

The four prior leads are all supported, with scope clarified: review reconciliation is stale; numeric sorting is lexical; demo confirm/exclude have no in-memory mutation; demo notes persist/export. They were not used as an upper bound on investigation.

## 7. Validation Evidence and Reproduction Ledger

### Accepted baseline executions (I)

| Command/experiment | Result | Interpretation |
| --- | --- | --- |
| `cd web && npm ci` | 331 packages installed; declaration/lockfile unchanged | Replaced stale preinstalled dependencies; deprecation notices are not suppressed |
| `npm run verify` | Types pass; lint 0 errors/2 existing `no-console` warnings; tests **608 passed/6 skipped**, 42 files passed/1 skipped; production build pass | Six opt-in private-statement unit cases skipped, as required by data boundary |
| `npm audit --json` | 0 known reported vulnerabilities | Lockfile/advisory snapshot; no `audit fix`; not a guarantee against unknown supply-chain flaws |
| `npm run test:e2e` | **24 passed/2 skipped, 42.2 s** | Chromium real IndexedDB; two private-statement E2E cases skipped |
| Existing 100k identity/IndexedDB E2E | Plan 475.2 ms; write 4,489.5 ms; read 1,644.5 ms; overlap plan 661.9 ms; total measured 8,959.1 ms | 100,001 distinct IDs, one new occurrence, total minor units 1,288,012,880; test duration 11.1 s is a different metric |
| Temporary independent Vitest suite | **16/16 passed under Vitest 4.1.11** | Diagnostic assertions prove actual defects plus controls; “pass” does not mean fixed behavior |
| Temporary independent Chromium UI/security and two-tab persistence probes | Passed their assertions | Real/demo note crossing, 13→13 no-op confirm, stale peer category until reload, inert HTML and 0 external requests; AUD-005 repeated on native IndexedDB in two tabs |
| New scale campaigns | See §8 | Production-built baseline, isolated generated profiles, real IndexedDB, local-only browser requests |

All temporary tests/probes/downloads/logs are outside the committed report diff. Reproductions below and in each finding are the durable evidence description; private data or inaccessible local logs are not prerequisites for understanding a finding.

### Independent synthetic experiment ledger

| Test | Inputs and assertions | Finding/control |
| --- | --- | --- |
| I-A01 | Two 12,880 debits; summary 12,880; reject one using actual provider; click actual recompute button; compare fresh calculation/DB/trusted totals | AUD-004: passed calculation, stale needs_review, trusted 0 |
| I-A02 | Balanced native one-row ledger; `workbookBytes('标准字段', LEGACY_UNIFIED_COLUMNS, [historyRow({description:'消费 appended'})])`; preview→plan→persist | AUD-004: trusted 25,760 versus bank 12,880 |
| I-A03 | Two distinct-description balanced plans from the same empty snapshot; commit via `Promise.all` | AUD-005: 2 rows, stored count 1, reconciled versus fresh mismatch |
| I-A04 | Real fixture/note, enable demo, actual Review, confirm and save demo note, export and purge | AUD-001/006: real text displayed, demo no-op and note survives/exported |
| I-A05 | Same-currency amounts `[-10000,-200,200,10000,3000]`; production `sortTransactions` | AUD-007: lexical order differs from numeric oracle |
| I-A06 | Three valid USD rows inserted into synthetic CCB before true footer; middle merchant contains `The End` | AUD-008: 17 expected, 15 actual, reconciled |
| I-A07 | ABC cycle 2025-12-15–2026-01-14, `1220` versus `12/20` | AUD-009: one-year divergence |
| I-A08 | CCB summary -3000 + 6500 - 7200 = -3700 | AUD-010: previous sign lost, mismatch |
| I-A09 | Keepraw fixed-schema XLSX, positive CNY100, merchant `示例优惠超市` | AUD-011: trusted debit cashback; spending 0 |
| I-A10 | Synthetic BOC layout summary label RMB→USD with RMB detail retained | AUD-012: summary relabeled CNY and passed |
| I-A11 | Synthetic CJK identity text adjoining `消费`, grouped test card digits | AUD-013: both survive masker |
| I-A12 | CNY/USD/JPY, integer `i*997` for -1000≤i<1000; minor→decimal→parse | Control: 6,000 exact roundtrips |
| I-A13 | Backup mutations: fractional minor, February 30, orphan transaction, duplicate ID, blank note | Control: validation/restore rejects; no row written |
| I-A14 | Valid V2 payload; inject `reviewNotes.bulkAdd` rejection during restore | Control: all six tables remain empty after rollback |
| I-A15 | Real provider imports a synthetic 65 MiB buffer/file; full ZIP export attempted | AUD-014: failed import retains attachment; full backup rejects |
| I-A16 | Import→data backup→clear real→reimport→restore same backup twice | Control: exact original transaction IDs/count retained |

To reconstruct the function/provider experiments without modifying formal tests, put a temporary `.test.tsx` outside the repository, import the named `web/src` modules and synthetic `web/tests/fixtures` helpers by absolute path, use a temporary Vitest configuration rooted at `web` with `environment: 'jsdom'`, JSX automatic mode, and `web/tests/setup.ts`, and clear all six fake-indexeddb stores between cases. I-A01/A04/A15 use `AppProvider`/`useApp` with React Testing Library `act` and await `state.ready`; real records are seeded before mounting, and settings select the required mode. I-A06/A08 feed UTF-8 HTML through `buildSourceDocument` and `ccbParser.parse`; I-A10 feeds the provided synthetic PDF-layout object through `bocParser.parse`. The findings give exact mutations and expected/actual values, so a regression should invert the defective assertions, not copy them as desired behavior.

### Test and CI blind spots

- `ledgerState.test.tsx:113–130` compares sorting to an implementation-equivalent string oracle; it is a demonstrated false assurance for numeric business semantics.
- `financialReview.test.tsx` mocks the store and primarily verifies display; `e2e/app.spec.ts:125–147` verifies removal/persistence of a confirmed row, not statement reconciliation/trusted totals afterward.
- Demo isolation tests inspect financial tables and mode visibility but did not exercise real-note visibility, demo note writes, or effective demo mutations.
- Collision abort tests protect transaction keys; they do not cover different-ID concurrent plans writing the same statement. Serial provider tests do not cover multiple providers/tabs.
- Financial parser tests catch invalid recognized amount rows; they do not ensure every date-bearing source row survives footer/header recognition. Matching totals cannot expose omitted foreign, net-zero, or informational installment rows.
- CI's build and artifact/deploy gating are meaningful. Action tags are not immutable commit pins, SheetJS installation depends on its upstream CDN/integrity, and branch/hosting settings are external controls. These are maintenance/supply-chain residuals, not newly alleged compromises.

## 8. Performance and Resource Assessment

### Current baseline measurements (I)

Both campaigns completed successfully on the exact audited application SHA: performance at **2026-10-17 06:23:45 UTC**, backup at **06:26:39 UTC**. Timings below are milliseconds; operation/UI medians use five samples, import/startup/download medians use three. Different columns measure different scopes and must not be added as if independently timed stages.

| Current metric | 18,000 rows | 100,000 rows |
| --- | ---: | ---: |
| History preview | 1,382.3 | 7,651.4 |
| Import confirmation | 1,282.0 | 8,719.2 |
| Entire preview/confirm workflow | 2,682.3 | 16,655.5 |
| Median longest main-thread task per import | 1,346 | 7,570 |
| Startup | 334.4 | 1,301.0 |
| Full snapshot read | 174.3 | 961.8 |
| Pure description sort | 30.0 | 272.9 |
| UI search completion | 31.6 | 73.9 |
| UI date sort completion | 40.5 | 176.9 |
| UI description sort completion | 54.5 | 287.1 |
| Single edit to paint | 33.0 | 195.3 |
| Full refresh to paint | 192.7 | 1,144.7 |
| Actual data-only JSON download | 357.8 | 1,988.2 |

All six import profiles produced exactly the intended valid row count with zero reported anomalies. Single-edit samples incurred **zero full database reads**, preserving the existing incremental-state optimization; rendering still scales with the snapshot. The 100k import's longest tasks ranged **7,445–7,759 ms**, showing a significant UI freeze in this workload even though imports completed. Pure sort, UI completion, database write and full workflow timings are distinct observations.

The separate 100k backup campaign included **576 statements, 5,000 review notes and one original attachment**. V2 JSON was **94,556,798 bytes**, exported in **2,016.9 ms**; ZIP was **125,806,977 bytes**, exported in **3,049.4 ms**. One fresh profile per format gave initial JSON/ZIP restore times **11,008.6 / 12,731.4 ms**. Two subsequent restores in each profile took JSON **4,399.8 / 4,414.6 ms**, ZIP **4,799.6 / 5,198.2 ms**. These initial restore values are single samples, not medians or population estimates.

Existing-ledger restore, export→clear→restore, JSON/ZIP V1 compatibility and repeated V2 restore succeeded. **Eleven final snapshot comparisons reported zero mismatches** across counts, IDs, amounts, currencies, duplicate relationships, statements, imports, review states, notes, attachments and settings. A nonempty note conflict was rejected with destination state preserved. A native IndexedDB late attachment-write fault (`synthetic late quota error`) rolled back all imported stores: zero statements/transactions/imports/notes/attachments, with the two pre-existing settings preserved. This is injected failure evidence, not actual disk-quota exhaustion. JSON intentionally omits attachment bytes; ZIP restored them, reconstructing the documented timestamp rather than claiming byte-for-byte timestamp identity.

Peak summed Chromium-process RSS was **3.066 GiB** in the source campaign, **3.041 GiB** in fresh JSON, and **2.535 GiB** in fresh ZIP; the Node benchmark harness separately peaked at **2.110 GiB** across the campaign. These measurements include browser/process overhead and potentially shared-page double counting; they do not establish a minimum RAM requirement or prove behavior under a 2 GiB limit. No OOM, partial committed restore, or record mismatch occurred in these bounded runs.

The current campaign uses the existing deterministic fixture seed `1263684657`, unmodified production modules, locally compiled Vite assets, fresh generated Chromium profiles, and browser request blocking outside the temporary local origin. Both phases have a 600-second process deadline. Performance runs use 18,000 and 100,000 rows, three import profiles per size, five operation samples and three actual JSON downloads on the first profile. Backup runs use 100,000 rows and one fresh profile per format with three restores each, plus existing-ledger and V1 compatibility cases. These are scoped repeatable experiments, not independent samples of every user device.

Reproduce from the locked baseline, with `CHROMIUM_PATH` pointing to the installed Chromium binary and all outputs in temporary directories:

```sh
LEDGER_MODE=performance LEDGER_SIZES=18000,100000 \
LEDGER_OUTPUT=/tmp/keepraw-performance.json \
CHROMIUM_PATH=/path/to/chromium timeout 600 node web/scripts/large-ledger/run.mjs

LEDGER_MODE=backup LEDGER_SIZES=100000 LEDGER_FRESH_PROFILES=1 \
LEDGER_OUTPUT=/tmp/keepraw-backup.json \
CHROMIUM_PATH=/path/to/chromium timeout 600 node web/scripts/large-ledger/run.mjs
```

The runner creates and removes temporary probe sources; none belong in the PR. Its backup-mode RSS samples sum browser-process RSS and can double-count shared pages; they are not a measured JS heap limit. Repeated large imports, full snapshots, workbook parsing and backup serialization retain substantial object graphs. Workbook detection may decode the same file for successive adapter checks, and PDF row grouping repeatedly scans row arrays. These source costs motivate bounded worker/budget investigation; they are not additional performance defects without a representative failure or timing case.

### Historical measurements (H; retained, not rerun labels)

[Archived `after.json`](https://github.com/keepraw/keepraw-ledger/blob/98d6ead1852b0134c560b39db04b33e8ae10d7a2/docs/benchmarks/large-ledger/after.json) identifies `06800f20039bab2ebbc3cdb301d53645e8d1b699`, 2026-10-14, Xeon host, with 100k UI search median **134.5 ms**, description sort **486.5 ms**. Its `TransactionsPage.tsx` SHA-256 `401841575c0dbd079803d259777b9838450ff22948f002547eb7f5e7dea1a81e` matches this baseline; other relevant source hashes differ. Historical JSON/ZIP restore around **22.8/27.9 s** and aggregate Chromium RSS **2.815 GiB** remain historical observations with the original measurement caveats. They are not the new campaign's numbers or a current SLA.

Manus correctly disclosed those historical limits; the independent revision strengthens evidence rather than pretending the old numbers were wrongly labeled. AUD-014 additionally demonstrates a concrete persistent backup-availability failure at a bounded input size, which aggregate performance timings alone would miss.

## 9. Positive Findings Retained and Qualified

1. **Minor-unit parsing is a real control.** Safe-integer input and currency precision checks, malformed-amount rejection and exact decimal export are implemented and tested; 6,000 independent roundtrips passed. This does not prove every aggregate is overflow-checked or every type/date/currency is semantically correct.
2. **Explicit financial categories and CNY aggregation prevent basic mixing.** Refund/payment/fee/installment types exist; rejected rows and installment originals are excluded where intended; foreign settlement rows are disclosed instead of FX-converted. AUD-004/011/012 identify upstream truth/assignment failures, not a reason to remove these distinctions.
3. **Deduplication uses exact fields and occurrence counts.** Lossy normalized descriptions/hash equality alone cannot consume mismatched business rows. `bulkAdd` prevents silent primary-key overwrites. Delete/reimport and repeated restore controls preserved IDs. Disjoint identical real-world transactions remain fundamentally ambiguous without better source identifiers.
4. **Input HTML is handled inertly, not displayed as executable markup.** The tested Chromium payload did not execute or request external resources. PDF extraction disables eval and uses a local worker. This evidence is narrower than a claim that all malicious PDFs/HTML are safe.
5. **Restore atomicity/conflict handling is substantial.** V1/V2 compatibility, independent notes/orphans, financial conflicts, hash/path/decompression budgets and failure rollback have meaningful tests. The independent note-failure control and current scale campaign add evidence; complete recovery still depends on having an export within supported limits.
6. **Schema/deletion behavior preserves deliberate boundaries.** V3 removes indexes rather than rewriting identities; related-store deletion is transactional; explicit real/demo shared evidence is protected. Orphan preservation is intentional and should not be weakened to erase the symptoms of AUD-001.
7. **Deployment provenance is sound in the reviewed workflow.** PRs validate without deploying; main deployment consumes the same run's validated artifact, is serialized, and checks current main. This was inspected and observed, not exercised by a new production deployment.
8. **Local-first and backup limitations are documented.** No application ledger backend/upload path was found; exported backups are unencrypted and browser storage is not a vault. These architectural facts do not guarantee demo display isolation, safe golden publication, or protection against compromised same-origin code.

## 10. Remediation Roadmap

**First three priorities:**

1. **AUD-004 — establish repository-owned reconciliation/trust updates.** It affects ordinary review and history workflows in both undercount and overtrust directions. Fixing only the Review button would leave the migration path broken.
2. **AUD-008 — make parser completeness a checked invariant.** Prevent successful truncated imports; bank totals cannot independently validate foreign or net-zero/informational rows. Preserve original evidence and provide a deliberate recovery/reparse plan for already-imported hashes.
3. **AUD-011 — separate merchant text from authoritative business type.** A positive purchase currently disappears from trusted spending without a review flag. Add actual adapter→persist→dashboard tests before changing the classifier.

Address **AUD-005** in the same priority integrity workstream with cross-context stale-plan detection and notification, while keeping it a separately reviewed product fix. No P0 emergency action is justified by current evidence.

Next address P2 **AUD-001** (both note reads and writes), **AUD-014** (early/batch resource budgets and export-error feedback), and **AUD-013** (safe shareable golden output) to protect privacy and recovery availability. Fix **AUD-007/009/010/012** with representation-specific tests. Profile **AUD-002** against a declared device budget, without preserving incorrect numeric sorting. Resolve the P3 demo controls **AUD-006** through isolated state or explicit disabling. Add CSP **AUD-003** as a tested defense in depth, alongside considered dependency/action maintenance.

All product changes, data repair/migration decisions, schema changes and new committed regression tests belong in subsequent independent PRs. This audit makes none of those changes and authorizes no automatic merge or deployment.

## 11. Rejected Claims, Suspicions, and Residual Risks

### Not established / deliberately not counted

- **Hash-only silent merge:** rejected as a finding for the examined current path; full-field equality and occurrence consumption protect mismatched rows. No practical stable-hash collision exploit was demonstrated.
- **Partial committed V2 restore on injected late write failure:** not reproduced; transaction rollback controls passed. Input validation and atomicity should be retained.
- **Raw HTML XSS/external tracking during the tested extraction:** not reproduced. Unsafe elements/attributes were removed and no request/execution occurred in the tested Chromium case. Lack of CSP is not itself evidence of XSS.
- **Permanent loss of original bank files:** not established by the parser omission case; readable source evidence is retained best effort. Transaction omissions are nevertheless real, and same-file deduplication can obstruct a routine retry.
- **Every Demo operation must target only fictional data:** rejected as a blanket claim. The explicitly labeled real backup/restore/clear tools intentionally access real storage; the proven note/display/control inconsistencies are narrower.
- **Historical performance equals current performance:** rejected. Source identity, hardware, dependency, browser and workload provenance are explicitly separated.

### Suspected/unquantified risks requiring further work

| ID | Evidence and uncertainty | Required verification |
| --- | --- | --- |
| S-01 | XLSX path reads the full buffer and calls `XLSX.read` without application file/expanded-cell/time budgets (`legacyImport.ts:300`, `workbook.ts:16–26`). Resource exhaustion is plausible beyond AUD-014, but no hostile workbook crash was induced. | Bounded sparse-range/shared-string/compression corpus, worker timeout/cancellation, measured memory and no partial writes |
| S-02 | PDF text/page budgets do not bound every decompressed object or processing time; open-failure cleanup is weaker than the successful `finally` path (`extract.ts:139–187`). No accumulating worker leak or malicious PDF exploit was demonstrated. | Repeated failed-open and pathological small-PDF profiling, worker lifecycle/memory instrumentation |
| S-03 | Most aggregation/reconciliation additions use JS numbers directly, whereas `sumMinor` is checked. Individual safe integers do not prove safe totals. Typical consumer-ledger bounds make exploitability/likelihood uncertain. | Explicit aggregate range policy and positive/negative cancellation cases near `MAX_SAFE_INTEGER` |
| S-04 | V2 restore validates shapes/references but preserves complete new statements' recorded trust; it does not authenticate financial JSON against an issuer. Stronger semantic consistency checks may help, but arbitrary user-edited backups are not automatically a remote security vulnerability. | Specify backup trust contract, then mutate sign/type/status/count relationships and assess false-success handling |
| S-05 | CSV leading-control/whitespace formula interpretation varies across spreadsheet applications. Direct formula-like text has existing protections; no Excel/LibreOffice exploit was reproduced. | Actual supported spreadsheet application/version tests, including leading newlines/tabs/whitespace |

These are not included in the thirteen Confirmed defects. Unknown future bank layouts, full multilingual/encoding variants, BOC geometry variations and refund/fee/netting semantics still require independent issuer-format evidence. Synthetic tests establish the demonstrated paths, not their prevalence in all real statements.

No Firefox, WebKit/Safari, mobile/private-mode storage, real quota exhaustion, browser eviction, power-loss/process-kill durability, low-memory-device stress, or exhaustive PDF/EML/XLSX/ZIP fuzzing was completed. The 100k campaign is one machine/browser, not a universal capacity guarantee. No current private statements or historical personal SQLite database were used; six unit/two browser private acceptance cases remain skipped. Existing golden agreement can preserve a shared error and is not an independent financial oracle.

Dependency advisory checks are snapshots, and static/finite dynamic review cannot exclude unknown vulnerabilities. Browser extensions, shared OS accounts, device malware, same-origin asset compromise, downloaded copies and physical-media erasure are beyond this app's isolation mechanisms. GitHub/Pages status can change after this snapshot. The report supports merging **the corrected audit document**, not declaring the product fully safe or merging product fixes without review.
