# Transaction description display

`core/descriptionNormalizer.ts` supplies deterministic browser-local display rules.
Only delimited leading `网上消费` / `消费` actions are removed. Recognized payment
channels keep their names; their separator before the merchant becomes `-`.
Merchant punctuation, parentheses, numbers and complete names are retained. There
is no alias mapping or network service. Other transaction actions remain visible.

`description` is the sole transaction detail field. It contains payment channels,
complete merchant names and business semantics; `rawDescription` retains source
text. There is no separate merchant field or extraction function in transaction,
parser, historical-adapter, demo, search or export models.

## Persistence and compatibility

The stored `description` is source-cleaned text and is part of the existing
fingerprint **and exact occurrence matching**. Changing it on import or in a
migration would break overlap detection. It therefore remains unchanged for both
new imports and old records. `transactionDisplayDescription` computes the display
value at the presentation boundary. Never persist its result or use it as identity
input. Source-format cleanup is shared with the bank parsers in
`core/sourceDescription.ts`; that cleanup retains the previous identity behavior.

The v4 IndexedDB upgrade deletes only the retired `merchant` property in the
atomic Dexie versionchange transaction. No financial recalculation,
ID/fingerprint/occurrence rewrite, or source association change is performed. JSON/ZIP backups still
contain exact current records; restoration uses the existing conflict and atomicity rules.
CSV/XLSX display descriptions share the UI conversion and include raw descriptions
(the ledger archive appends `raw_description` to Technical Metadata). Search can
match display descriptions, stored descriptions and raw descriptions.

## Manual edits and conservative limits

The historical model does not record field-level edit provenance. A description
is displayed with normalization only if it equals the original description or
recognized source-format cleanup of that original. Any divergent value is shown
verbatim, even when it starts with `消费`. Category edits are never regenerated.
There is no write during display, search or export.

A user intentionally entering exactly the original source value is indistinguishable
from the import value: its display will be normalized, while its persisted value
and backup remain exact. Older records with unrecognized cleanup are displayed
verbatim. The retired standalone merchant value is intentionally discarded by the
v4 migration and old-backup recovery; description and rawDescription remain exact.

For example, `网上消费 支付宝，合成 A-B (HK)` displays and exports as
`支付宝-合成 A-B (HK)`, while the original remains available in tooltips, exports
and backups. `消费 自定义描述` replacing a different original remains unchanged.

## Old backups and new writes

New JSON and ZIP backups retain the existing V2 envelope but omit `merchant`.
Historical V1/V2 payloads may carry that property as a string; all other field,
reference, money, note, attachment and conflict validation remains unchanged.
Restoration strips the legacy property before writing, without mutating the input
payload. V1 note behavior and V2 atomic note/evidence recovery remain unchanged.
Repository writes also discard stale runtime copies of the retired property, and
export defensively omits it. New CSV/XLSX files have no standalone merchant column.

Archived storage benchmark results still describe the schema measured at the time;
their retired-field metrics are historical evidence, not current transaction data.
