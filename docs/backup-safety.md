# Versioned backup validation and restore policy (V1 + V2)

Both `credit-bill-manager-backup` and `credit-card-data-backup` remain supported.
New JSON exports use backup version 2. New ZIP exports carry the same V2 ledger
information in `database.json`. The ZIP manifest stays at version 1; the archive
envelope is unchanged beyond the versioned database payload.

## V2 schema

V2 keeps every V1 financial field, fingerprint, occurrence, amount, currency,
review decision, statement association, import provenance and settings byte
semantics, plus independent `reviewNotes`:

```json
{
  "format": "credit-card-data-backup",
  "version": 2,
  "exportedAt": "2026-01-01T00:00:00.000Z",
  "statements": [],
  "transactions": [],
  "imports": [],
  "reviewNotes": [
    { "transactionId": "tx-1", "note": "exact user text 🎉 中文", "updatedAt": "2026-01-02T00:00:00.000Z" }
  ],
  "settings": null
}
```

- `reviewNotes` is required in V2 (possibly empty), sorted by `transactionId`
  for stable output. Note content is stored only here, never duplicated inside
  transaction records.
- Each note preserves `transactionId`, exact `note` content (Unicode, Chinese,
  punctuation, line breaks, non-ASCII) and `updatedAt`.
- Validation: `transactionId` uses the same nonempty identifier rules as other
  IDs; `note` must be a non-empty, non-whitespace-only string of at most 100,000
  characters (new input is capped at the same bound; previously stored notes up
  to the bound export exactly with no truncation or omission); `updatedAt` must
  be a valid ISO timestamp; `transactionId`s must be unique.
- Reference policy: orphaned notes (no matching transaction in the payload)
  are valid and preserved. Exports include every stored note including orphans
  and never assume orphans belong to demo data. Restores insert orphans as
  recoverable user text rather than dropping them. Demo filtering uses only
  explicit `isDemo` flags, never note presence.
- Malformed, duplicate, mistyped, oversized or contradictory V2 payloads are
  rejected rather than silently repaired. A V1 payload carrying `reviewNotes`,
  a V2 payload missing `reviewNotes`, and any `version` other than 1 or 2 are
  rejected.

## Version detection and compatibility

- `version: 1` without `reviewNotes`: legacy backup. Both format names remain
  readable in JSON and inside ZIP `database.json`.
- `version: 2` with `reviewNotes`: current backup.
- V1 files can never reconstruct notes that were never exported. V1 restores
  preserve all existing local notes unchanged; V1 restores into a fresh profile
  invent no notes.
- V2 exports preserve notes; V2 restores recover them into fresh profiles.
- No IndexedDB schema migration was introduced for V2. The portable backup
  format advances independently from the Dexie V3 index layout.

## Note conflict and restore rules

Financial preservation takes priority over convenience:

- Incoming note absent locally: insert it with original content and timestamp.
- Existing note with identical content: preserve the existing row (including its
  timestamp). Repeated restoration is idempotent and creates no duplicates.
- Same `transactionId` with conflicting content: reject the entire restoration.
  Never last-write-wins, never compare `updatedAt` to overwrite.
- V1 restore: leave every local note untouched.
- Absence of a note in the payload never deletes an existing local note.

A shared transaction key with conflicting financial fields, statement identity
conflicts and import-hash conflicts continue to reject the entire restore, as in
V1. Matching existing financial records retain their user metadata and
provenance. Complete newly restored statements keep their original decisions and
reconciliation; additional rows in an existing or partial statement trigger
recalculation of derived counts and reconciliation. Restored settings replace
current settings. Repeat restoration is idempotent.

## Atomicity and backup safety

All restored ledger changes commit atomically in one IndexedDB transaction
covering transactions, statements, imports, review notes, settings and restored
original attachments (where applicable). JSON restores cover the first five;
ZIP restores cover all six. If any operation fails — including a late note,
transaction or attachment write — the entire restore rolls back.

Expensive JSON parsing, ZIP decompression, structural validation and SHA-256
verification complete before entering the write transaction. No hashing or ZIP
work occurs inside that transaction. Transaction and note lookup/insertion use
batches of 2,000 requests in that same transaction.

Exports obtain mutually consistent ledger records and notes from one readonly
transaction; the manifest derives from that same immutable import snapshot.
This avoids torn backup states from concurrent edits.

Existing PR #27 protections are unchanged: input-size limits, JSON complexity
budgets, ZIP entry validation, path safety, expansion limits and SHA-256
verification. Resource budgets were not weakened for V2; notes count toward the
existing 1,000,000 total-record budget (statements + transactions + imports +
reviewNotes) plus the 100,000-character per-note bound (a single note's transient
JSON encoding stays well under 1 MiB). The existing byte,
entry-count and JSON complexity limits apply identically to V2.

Limits: 256 MiB archive input/output, 256 MiB expanded content, 64 MiB per
original, 128 MiB per JSON file, 20,000 ZIP entries and 1,000,000 total database
records (including review notes). JSON is checked before `JSON.parse`: maximum
nesting 64, 8,000,000 lexical tokens and 2,000,000 containers. UTF-8 must decode
without replacement. Standard ZIP directories are checked before loading;
actual decompression is bounded independently of advertised sizes. ZIP64 and
multi-disk archives are rejected.

ZIP preview and restore validate the same records, manifest associations and
original bytes. Missing archived evidence, unmatched or duplicate manifest
records, extra files, unsafe paths and mismatched real SHA-256 hashes reject the
archive before persistence. Explicit fictional demo archives retain their
synthetic-hash compatibility exception. Hash-based filename fallback is retained
only when the match is unambiguous. Existing attachments must contain the
verified bytes; corrupted content under an existing key aborts restoration.

## JSON / ZIP behavior

- JSON contains ledger information (including V2 notes) but not raw evidence files.
- ZIP includes available original evidence under the existing best-effort policy
  (`indexeddb` vs `missing`); missing historical attachments are never fabricated.
- Existing V1 archives remain readable in both preview and restore paths.
- Existing ZIP manifest and evidence integrity rules remain enforced.
- Preview reports the backup version, review-note count and attachment gaps.
  Restore messages state how many transactions, statements, notes and original
  files were recovered, and call out V1 note limitations explicitly.
- Backup files are local unencrypted files, not secure encrypted cloud backups.
  The Settings UI states this.

## Follow-up notes (solved by V2)

V2 closes the known V1 gap: independent free-text `reviewNotes` are now
exported and restored across devices with exact preservation. V1 files still
cannot restore notes that were never exported. ZIP attachment `importedAt` in
fresh restores continues to follow the existing V1 restore contract
(reconstructed when missing); existing restores and migrations still require
stored timestamps to remain exact.

## 超限附件与完整备份恢复（AUD-014）

新上传的银行账单和历史文件在完整读取、计算 SHA-256、复制原件前检查 25 MiB 单文件预算；银行账单每批另有 100 MiB 预算。明确拒绝的文件不进入原始附件。已有附件不自动删除或截断；JSON 数据备份不受附件大小影响。

完整 ZIP 保持 64 MiB 单原件、256 MiB 总量及既有校验限制。设置页会显示导出错误和恢复建议。若旧原件或原件总量超限：先导出 JSON，再在“原始文件管理”下载并保存相关原件，明确确认“设为外部保存”后重试 ZIP。此选择可撤回，不删除本机原件，也不修改交易、导入记录或复核备注。ZIP 的 manifest 使用既有 `external` 状态，导出和恢复均提示这些原件需另外保管；它们不会被静默当作已包含在 ZIP。新设备恢复金融数据后，外部原件仍需用户单独保存。

外部保存偏好是本机内部设置，不进入 JSON 的应用设置。修改与 AUD-005 共用提交版本事务：过期选择回滚并提示刷新；并发导入重新规划；清空代际保护仍生效。ZIP 构建期间如账本或外部保存选择变化，拒绝下载混合版本备份，用户可重试。取消确认不写入任何状态。
