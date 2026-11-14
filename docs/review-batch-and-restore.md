# Restore cleanup and bulk review (PR #50 follow-up)

## Restoring native history

`importBackup()` validates the original payload, then maps transactions through
`normalizeRestoredTransaction()` before writing. This pure, immutable boundary
keeps the existing retired-merchant normalization and removes only
`low_confidence` from transactions matching both `origin: legacy_import` and
`sourceId: legacy-keepraw-ledger-export-v1`. All other flags, review statuses,
confidence values, identities, financial fields and provenance remain exact.
Other sources are untouched. The caller's payload is never modified.

JSON V1/V2 and ZIP use the same path. Existing local records retain the existing
merge/conflict policy; this change prevents incoming flags from being
reintroduced. V1 keeps local notes; V2 restores original note content/timestamps.
ZIP calls `importBackup()` within its existing outer transaction covering all six
stores. Cleanup opens no extra transaction: financial rows, notes, settings and
attachments roll back together if any later operation fails. Neither schema v5
nor the existing v5 content upgrade, backup versions, archive formats, XLSX
columns, parsers or identity algorithms change.

## Review UI

The transaction queue keeps its existing predicate and defaults to 100 rows per
page, with 50/100/200 choices, range/count, first/previous/next/last controls and
immediate clamping when operations shrink the queue. Statements, statement
transactions and notes are also paginated so a large ledger cannot produce an
unbounded DOM through a secondary list. Duplicate comparisons are computed for
only the currently displayed transactions, using the unchanged comparison logic.

Selection uses transaction IDs and survives page and page-size changes. The
header selects/deselects the current page (with an indeterminate state), while an
explicit action selects the entire current queue. Normal and rejected records
are excluded. Mode changes clear selection. Selection and cancellation write
nothing. Selections are intersected with the current queue after updates.

A native modal dialog confirms the exact batch size. Confirmation warns when
suspected duplicates will lose their flag. Submission is guarded and disabled
while pending. Successful operations clear selection; failures preserve it and
show an error. If selected rows cease to be reviewable while the dialog is open,
submission is disabled until the user cancels and selects again. Existing single
review actions and duplicate comparisons remain available.

## Atomic writes and isolation

The new repository `reviewTransactions(ids, decision)` owns/deduplicates IDs,
re-reads current rows inside one read/write transaction, validates every target,
and changes only `reviewStatus` and `flags`. Confirm clears flags; reject retains
the latest flags. It never bulk-writes captured React transaction objects.
Missing, normal, rejected or stored demo targets abort the entire operation.
Statement reconciliation/status is rebuilt once per affected statement and the
ledger revision is bumped once, inside the same transaction. Cross-page
notifications fire only after the root commit. A failure in any chunk or
statement rebuild rolls everything back.

AppStore serializes this API through its existing enqueue queue. It captures the
request's demo ownership and generation. Demo batches validate all targets and
publish a new in-memory snapshot with updated derived statements; they never
call the real repository, change notes/evidence or bump the real revision.
A real request cannot write once demo mode has been enabled.

## Regression evidence

Tests were added first: old JSON V1/V2 and ZIP retained the erroneous flag, and
the old review UI rendered 250 transaction rows instead of the expected 100.

- `nativeBackupCleanup.test.ts`: V1/V2 immutable/idempotent cleanup, exact
  provenance boundaries, every status/confidence value, notes, JSON late-write
  failure, and ZIP attachment failure after nested restore with complete rollback.
- `nativeBackupRestore.spec.ts`: actual Settings UI backup/download/restore for
  JSON V1, V2 and ZIP in fresh browser contexts, repeat restore, queue counts,
  refresh, original evidence and a ZIP failure followed by successful retry.
- `bulkReviewRepository.test.ts`: latest concurrent fields survive, both decisions,
  no partial writes, second-chunk and statement-rebuild failures, revision and
  invalid/demo target checks.
- `bulkReviewPage.test.tsx`: page bounds, cross-page selection, accurate modal
  warning/counts, failure retention, repeat-submission guard, mode reset and
  pagination of statements/details/notes.
- `bulkReview.spec.ts`: **18,286 pending synthetic rows**, plus one normal and one
  rejected control. Initially only 100 queue rows are rendered. Current-page
  selection counts 100; all-queue selection counts 18,286. Deselecting one across
  pages leaves 18,285 selected. A confirmed batch clears all selected flags and
  leaves the unselected row exact; excluding that remaining row preserves its
  flags. All other fields and notes survive refresh and application reopen.
  Additional UI tests cover 50/100/200 sizes, a 51-row exclusion that clamps the
  last page, failure rollback/selection retention, concurrent field preservation,
  cross-page commit synchronization and in-memory-only Demo batches.

All fixtures are synthetic. `npm run verify` covers typecheck/lint/unit tests/build;
`npm run test:e2e` covers development and production browsers;
`npm run test:migration` additionally includes the restore regressions;
`npm audit --audit-level=high` retains the project's security threshold.
