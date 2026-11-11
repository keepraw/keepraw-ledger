# TypeScript historical migration

The browser can migrate three historical XLSX schemas and its native transaction export without
running Python, generating SQLite, or calling a parsing service. The retired
Python implementation has been removed; TypeScript is the only production path:
XLSX Import → TypeScript Importer → IndexedDB → JSON Backup → Browser Restore.

The audited production path is `AppStore.previewLegacyImport` →
`previewLegacyWorkbook` → `readSheetData` / SheetJS, followed by
`planLegacyImport` → `persistLegacyImport` / Dexie. JSON uses
`exportDataBackup` and `importBackup`; spreadsheet export uses `downloadXlsx`.
None of these paths launches Python or reads SQLite. The optional
`migration:audit` developer command also runs Node and loads the TypeScript
adapters directly. Frozen Golden files named `python.json` are test references,
not processes or migration prerequisites.

## User workflow

1. Open the web app, then disable Demo Mode in Settings.
2. In Import, choose **历史 Excel 导入** and select an existing supported workbook.
3. Check the preview's source-row count, importable count, date range and banks.
   Inspect every excluded row and date warning before confirming.
4. Confirm the import. TypeScript writes valid rows atomically to IndexedDB.
5. Review transactions, currencies and suspected duplicates. Historical XLSX
   has no balance summary, so an imported history is not presented as reconciled.
6. In Transactions, clear filters to include the whole ledger and export Excel
   for an ordinary spreadsheet archive. The export includes both monetary legs,
   bank, card suffix, dates, description, type, direction, transaction ID,
   fingerprint and occurrence number. Amounts and card suffixes are text cells
   so spreadsheet formatting cannot discard precision or leading zeros.
7. In Settings, export `credit-card-data-YYYY-MM-DD.json`. Save it outside browser storage.
8. In a fresh browser profile or installation, open Settings and restore that
   JSON file. No original XLSX, Python installation or SQLite database is needed.
9. Recheck counts and transactions. Repeating restore or importing the original
   workbook again does not create additional copies of existing occurrences.

JSON backup V2 retains statements, transactions, import records, settings and
independent review notes. V1 backups lack independent notes; restoring V1 leaves
local notes intact. Neither JSON version contains original source files. Keep
original statements separately, or use the existing ZIP backup for files actually
stored. XLSX is a readable archive with limited native transaction recovery; it
does not replace JSON application backup/restore.
No exchange-rate conversion is performed. Foreign settlement records remain
available in the ledger and exports, with existing CNY dashboard rules unchanged.

## Supported inputs and banks

| Sheet | Adapter | Banks verified in the full migration/recovery workflow |
| --- | --- | --- |
| `标准字段`, complete 15 snake_case columns | `legacy-python-export-v1` | BOC, ICBC, ABC, CCB, BOCOM, CITIC |
| `交易明细`, nine fixed Chinese columns | `legacy-keepraw-export-v1` | BOC, ICBC, ABC, CCB, BOCOM, CITIC |
| `统一账单`, nine full historical Chinese headers | `legacy-unified-bill-v1` | BOC, ICBC, ABC, CCB, BOCOM, CITIC |
| Native `交易明细`, exact 20/21 columns below | `legacy-keepraw-ledger-export-v1` | Same bank IDs, including explicitly exported unknown-bank rows |

These schemas can contain multiple banks in one workbook. The PDF/EML bank
parsers remain responsible for their registered statement formats; historical
structured XLSX uses the explicit TypeScript adapters. An arbitrary bank's XLSX
layout, renamed columns, unknown sheet or incomplete schema is not guessed.
An existing `标准字段` export may have been produced by an old tool, but importing
an already available file never requires that tool to run again. A history that
exists only in a SQLite database is outside this XLSX workflow; do not delete its
artifacts or claim those native IDs were migrated. The repository's SQLite
historical audit is **NOT APPLICABLE** because the legacy SQLite artifact is
unavailable. No empty database or SAFE report was created. The one-off Python
audit tooling was removed with the retired implementation; its preparation and
artifact check are recorded in the [readiness audit](python-retirement-readiness.md).

## Data and identity guarantees

- Both original and settlement currencies and amounts are parsed independently
  as integer minor units. Invalid money, unsupported currency precision and
  currency conflicts remain explicit source-row anomalies. Original money is
  never borrowed from settlement money.
- For the three historical adapters, bank, card suffix, dates and descriptions are retained under the existing
  documented normalization rules. Types use the existing classification rules;
  direction comes from the signed settlement amount. These historical schemas
  do not contain separate native type, direction or transaction-ID columns.
  Metadata absent from the input cannot be recovered by guessing.
- The existing TypeScript fingerprint/occurrence algorithm assigns IDs once.
  Identical repeated transactions retain separate occurrence IDs. Exact matches
  reuse existing ledger IDs, including after JSON recovery. No Python-native ID
  is substituted for a TypeScript ID, and the identity algorithm is unchanged.
- JSON recovery preserves every transaction field, including ID, fingerprint,
  occurrence, type, direction, provenance and review flags. Import-record
  `duplicateOf` references and reconstructed suspected-duplicate candidates
  survive recovery. Suspected duplicates remain separate transactions.
- Excel serial date handling, future-date review and rejection of the 1904 date
  system retain their existing safeguards. Backup validation and conflict checks
  remain active; database schema and backup format are unchanged.

## Native transaction export contract

The source of truth is `web/src/export/tabular.ts`: `EXPORT_COLUMNS` and
`transactionToRow`. Inspection found **21 columns** in the current exporter,
not 20. Its first 20 columns form the older supported schema, in exactly this order:

| Position | Header | Native mapping |
| --- | --- | --- |
| 1 | 银行 | Bank display name → exact BankId |
| 2 | 卡尾号 | Text, including leading zeros (`????` remains unknown) |
| 3 | 交易日 | ISO date or null; never filled from posting date |
| 4 | 入账日 | ISO date or null; never filled from transaction date |
| 5 | 交易描述 | Display description; identity requires verification below |
| 6 | 交易币种 | Explicit supported currency |
| 7 | 交易金额 | Signed original amount → integer minor units |
| 8 | 入账币种 | Explicit supported settlement currency |
| 9 | 入账金额 | Signed settlement amount → integer minor units |
| 10 | 交易类型 | Exact exported Chinese type label → native type |
| 11 | 借贷方向 | 借/贷 → debit/credit; settlement sign must agree |
| 12 | 分类 | Exact supported category, including user-selected category |
| 13 | 复核状态 | ok / pending / confirmed / rejected |
| 14 | 来源文件 | Original source filename, including empty values |
| 15 | 文件指纹 | Original source file hash, including empty values |
| 16 | 来源页 | Positive page number or null |
| 17 | 原始片段 | Exact raw text, including line breaks |
| 18 | 交易标识 | Validated original ID |
| 19 | 业务指纹 | Validated original fingerprint |
| 20 | 重复序号 | Positive safe integer occurrence, gaps allowed |
| 21 (current only) | 原始描述 | Exact raw description |

Both accepted schemas require exact spelling and order, with no missing,
renamed, duplicated or extra columns. A malformed native schema cannot fall
through to a permissive historical adapter. The three historical adapters retain
their existing column rules. Native money uses plain signed decimals or numeric
cells through the existing guarded minor-unit parser; blank money, unknown
currency precision, conflicting signs/direction, overprecision, overflow and
invalid dates are explicit row anomalies. At least one valid date is required;
a missing other date remains null. Invalid rows are excluded and identified by
Excel row number. No currency conversion or fallback between monetary legs occurs.

`交易描述` is produced by `transactionDisplayDescription`, which can remove action
and channel tokens from the persisted identity description. The 21-column format
allows known source cleanup candidates from `原始描述`; the adapter accepts a
candidate only when both its exported display and existing `transactionFingerprint`
match. The 20-column format can verify only the displayed description itself.
If no candidate validates, the row is excluded as an identity anomaly. Exact
identity text cannot always be reconstructed: stale fingerprints after edits,
lost display tokens without raw text, or text outside the known cleanup rules
require manual resolution or a JSON backup. Even a validated fingerprint is not
a cryptographic signature and does not prove every original text byte; text
normalization is lossy. XLSX carries no tamper-proof checksum for the original
monetary leg, which is outside the fingerprint; it is parsed independently and
compared against stored values when the ID already exists.

Native IDs must equal `transactionId(fingerprint, occurrence)` and the fingerprint
must be recomputed from recoverable identity fields. No replacement ID is assigned.
Repeated legitimate transactions preserve distinct occurrence IDs, including sparse
or reordered occurrences. Every row with an ID repeated inside the workbook is
excluded as ambiguous. Unlike the historical adapters, native rows bypass
`assignOccurrences` / `assignStoredOccurrences`: matching business fields with a
different ID never consume an occurrence or rename an existing record. The existing
`detectDuplicates` still supplies review observations, not authority to merge native
identities. Matching IDs and matching financial fields are skipped, preserving all
local edits and notes. Same ID with differing bank/card/dates/identity description,
either monetary leg, type/direction, fingerprint or occurrence blocks the whole
confirmation plan, even if the file hash was already imported. The fresh snapshot
is checked again at confirmation; Dexie's existing revision check and atomic
`bulkAdd` workflow handle concurrent writes and roll back collisions.

The preview shows format, source/valid/excluded rows, date range, bank/card suffixes,
already-stored rows, excluded-row reasons and identity/duplicate warnings. Source
filename/hash/page and raw text come from the exported row, while import history
records the uploaded XLSX filename/hash separately. The exported source row number
is absent: `sourceRow` records the XLSX row, not an invented original row.

Native XLSX **does not contain** confidence, review flags, original source-row
numbers, statement IDs/periods/summaries, original origin/sourceId/demo/synthetic
markers, import history, settings, independent review notes or source attachments.
Confidence defaults to 0 with `low_confidence`, explicitly disclosed in preview;
exported review status is preserved unless a suspected duplicate needs `pending`
review. Flags cannot be faithfully reconstructed. Statements are grouped by
bank/card with null periods and insufficient reconciliation, as in the existing
migration pipeline. New rows record `legacy_import` and the native adapter ID.
The 20-column format also cannot recover raw description; the displayed text is
used only when identity verifies. This is partial transaction recovery, not a
full application backup. The separate Settings XLSX archive has different human
and Technical Metadata schemas and is not accepted by this adapter. JSON V2
backup/restore remains the full data-recovery contract; database schema and JSON
format are unchanged.

## Executed validation

`web/tests/fixtures/historicalMigration.ts` creates independent invented XLSX
data in JavaScript. Each schema contains all six banks, all ten transaction
types, exact repeated purchases, a suspected duplicate, signed original and
settlement money, two-decimal and zero-decimal currencies, and text/numeric cells.
Expected amounts and classifications are literal references, not Python output.

`web/tests/historicalMigration.test.ts` exercises XLSX preview, atomic IndexedDB
persistence, duplicate import, serialized JSON export, empty-database restore,
repeat restore and an overlapping file import. It compares every financial field,
ID, occurrence and duplicate candidate relationship.

`web/tests/nativeLedgerImport.test.ts` independently freezes the 20/21-column
contract, checks actual exporter output, preserves sparse occurrences, covers
invalid financial/date/identity fields, repeated and repacked files, fresh database
restoration, existing-ID conflicts, concurrent writes and full atomic rollback.
Its 18,286-row synthetic XLSX test checks unique identities, persistence, idempotent
replanning, a generous 45-second regression bound and a 1 GiB RSS-growth budget.
It reports elapsed time, RSS growth and process peak RSS; these are environment-specific
regression checks, not a universal performance or peak-memory guarantee. `web/e2e/nativeLedgerImport.spec.ts` exercises actual UI preview,
excluded-row reporting, confirmation, repeat import, UI XLSX download, restoration
in a fresh browser profile and disabled confirmation on a financial ID conflict.

`web/e2e/historicalMigration.spec.ts` performs the actual UI flow in Chromium for
each schema. It downloads and reads the XLSX independently, downloads the JSON,
restores it into a separate empty browser profile, reloads, and checks all
transaction fields and duplicate relationships. Only static same-origin GETs
and the local development socket are allowed; backend requests, external traffic
and database/preprocessing downloads fail the test. No Python process or SQLite
input participates in this workflow.

Run from `web/`:

```bash
npx playwright install chromium   # once, for the browser check
npm run test:migration
```

This verification command runs only Node/TypeScript and Chromium. The existing
CI Web job also discovers both suites through its normal unit and browser runs.
The retired Python job has been removed.

Real statements and their backups remain private local validation inputs. They
must not be committed, uploaded to CI or used as public test fixtures. This
evidence covers the named schemas and tested layouts, not universal compatibility
with every bank statement.

## Native adapter validation — 2026-11-11

Local results below are **provisional with respect to the pinned dependency and
bundled browser**. `npm ci` failed with E403 because the environment blocks
`cdn.sheetjs.com`. The other locked dependencies were installed from a temporary
manifest/lockfile outside the tracked tree, and the npm mirror
`@e965/xlsx@0.20.3` was unpacked as local `node_modules/xlsx` for these checks.
This does **not** verify the official tarball's pinned integrity. Dependency
specifications and `package-lock.json` remain unchanged.

`npx playwright install chromium` also failed with `403 Domain forbidden` from
`cdn.playwright.dev`. Browser tests used system Chromium **154.0.8037.57** through
an isolated `PLAYWRIGHT_BROWSERS_PATH`, rather than Playwright's requested Chromium
156 build. Runtime: Node **24.19.0**, npm **11.9.0**, Playwright **1.64.0**. CI uses
Node 22 and must still validate the official locked package and bundled browser.
These local results alone do not establish official locked-package/bundled-browser validation.

| Command from `web/` | Final local result | Elapsed |
| --- | --- | --- |
| `npm run typecheck` | Exit 0 | 5.91 s |
| `npm run lint` | Exit 0; 0 errors, 2 existing `no-console` warnings in `scripts/generate-golden.ts` | 3.87 s |
| `npm test` | Exit 0; 969 passed, 6 private-fixture tests skipped; 59 files passed, 1 skipped | 28.45 s |
| `npm run build` | Exit 0 | 8.77 s |
| `npm run test:migration` | Exit 0; 54 unit tests and 4 browser tests passed | 24.43 s |
| `npx playwright install chromium` (installed CLI, `--no-install`) | Exit 1; network policy denied browser download | 4.19 s |
| `npm run test:e2e` | Exit 0; development: 52 passed / 2 private-fixture tests skipped; production CSP: 3 passed | 129.98 s |

The native suite contains 51 tests. A separate final-code large-workbook run
passed with **18,286 distinct occurrence IDs**, exact persistence and zero new
rows on replanning: **6.81 s**, **219.2 MiB RSS increase**, **992.4 MiB process peak
RSS**. The process peak includes the XLSX runtime and fake-IndexedDB test harness;
it is not workbook-only memory. The regression limits are 45 seconds and 1 GiB
RSS growth, not a guarantee for other devices. All fixture data is invented; no
real financial workbook was provided or committed.

An early dependency-directory symlink caused development PDF-worker URL errors
and a navigation abort. Replacing it with the normal physical `web/node_modules`
layout resolved the problem: all 7 affected PDF/attachment browser tests passed,
followed by the full successful run above. No bank parser was changed. The native
E2E test also explicitly disables Demo Mode in its fresh browser before import.
Intentionally empty raw descriptions are retained when the identity still verifies;
a same-ID conflict produces one blocking warning rather than a misleading second
warning about different IDs. These final cases were rechecked with the full unit
suite and the migration browser workflow.

Original IDs can be safely retained when the ID/fingerprint/occurrence relationship
and recoverable business fields validate. Unverifiable identity rows are excluded;
existing-ID financial conflicts block confirmation. Missing confidence, review
flags, original row numbers, statement relationships/periods, independent notes,
original provenance markers and (in 20-column exports) raw description cannot be
faithfully recovered. Use JSON V2 for those application records and metadata.
