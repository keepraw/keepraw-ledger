# Native XLSX confidence repair (PR #48)

Native 20/21-column XLSX exports omit confidence and flags. The native adapter
keeps numeric `confidence: 0` as an unavailable-metadata sentinel, leaves flags
empty, and retains the exported review status. Its preview gives one batch-level
explanation. Zero is not a recovered parser measurement.

## Existing IndexedDB data

Opening an existing database upgrades it to version 5. The registered Dexie
content upgrade runs `repairNativeLedgerConfidence` inside IndexedDB's atomic
versionchange transaction. It removes only `low_confidence`, and only when both
`origin === 'legacy_import'` and
`sourceId === 'legacy-keepraw-ledger-export-v1'`. This adapter never imported
original flags: PR #48 added this flag unconditionally. Missing or different
provenance is excluded, including bank-parser records and other legacy adapters.

The repair changes no other property: confidence, reviewStatus (including pending
and rejected), other flags and their ordering, identity, occurrence, monetary
fields, descriptions, categories and source metadata stay exact. Notes and all
other stores are untouched. It does not re-import, regenerate IDs or delete rows.
Rows without the flag are not written. Repeating the operation has no effect.
Failures propagate, rolling back row changes and the version bump together; the
next open retries the upgrade. Older databases also run their existing upgrades
in the same transaction. Fresh databases start at v5 with no historical rows.
The v5 upgrade repairs records present when an older database is opened.
The follow-up restore boundary in `importBackup()` also cleans incoming V1/V2
JSON and ZIP rows when restoring into an already-v5 database. It leaves historical
backup files and their formats unchanged. See [restore and bulk review](review-batch-and-restore.md).

## Confidence usage audit

All `confidence` references under `web/src` were inspected:

- `parsers/{abc,boc,bocom,ccb,citic,icbc}.ts` produce actual statement/transaction
  confidence. `core/ingest.ts` turns parser transaction confidence below 0.8 into
  `low_confidence`. These paths and thresholds are unchanged.
- `importers/legacyPythonExportV1.ts` reads exported confidence;
  `legacyUnifiedBillV1.ts` assigns confidence from its parsing issues;
  `legacyKeeprawExportV1.ts` uses its existing format-specific default. These
  adapters are outside this fix and unchanged.
- `legacyImport.ts` copies adapter confidence into stored transactions. Only the
  native adapter's flag policy changes; it still stores numeric zero.
- `core/types.ts`, `parsers/types.ts` and `importers/types.ts` declare numerical
  fields; `backup/validation.ts` validates the 0–1 range; `demo/demoData.ts` seeds
  demo confidence. No schema or backup format changes are needed.
- `ReviewPage.tsx` uses flags/status, and `core/dataQuality.ts` counts flags.
  Neither interprets confidence zero as a review task. The queue predicate and data-quality aggregation are unchanged; the review UI
  now paginates that same queue and supports atomic batch decisions.

## Verification

The new regression tests failed before the fix: new rows carried the unwanted
flag, old rows remained unchanged, and the post-repair abort probe saw no repair.

`nativeConfidenceReview.test.tsx` runs the actual XLSX preview/planner and renders
ReviewPage. It covers all four exported statuses, suspected duplicates, and the
real BOC PDF parser's low-confidence fallback followed by normal ingestion.

`nativeConfidenceRepair.test.ts` compares complete objects and every store,
including a note for each row, tests exact provenance boundaries, forces a second
execution, reopens storage, and aborts after observing a completed repair to
prove rollback and retry. This focused fake-indexeddb test uses 182 target rows.

`e2e/nativeConfidenceRepair.spec.ts` runs 18,286 synthetic transactions through
UI XLSX import and real Chromium IndexedDB. The distribution is 18,000 ok,
200 confirmed, 50 pending and 36 rejected. New imports have no flags and a queue
of 50. The test recreates an isolated v4 database with the PR #48 artificial flag
on every row and an additional suspected_duplicate on 12 ok rows. The historical
queue falls from 18,250 to 62 (50 pending + 12 suspected duplicates); data-quality
flagged falls from 18,286 to 12. Complete records, all notes and every store are
compared after upgrade, refresh and closing/reopening the application page.
The queue predicate remains unchanged; rejected rows stay rejected.

`npm run test:migration` explicitly includes the new unit/component/browser
coverage. `npm run verify`, `npm run test:e2e`, `npm run test:migration` and the CI
security audit must pass before review. The browser test uses only synthetic
records in its own Playwright context, never user financial data.
