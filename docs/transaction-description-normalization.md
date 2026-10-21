# Transaction description display

`core/descriptionNormalizer.ts` supplies deterministic browser-local display rules.
Only delimited leading `网上消费` / `消费` actions are removed. Recognized payment
channels keep their names; their separator before the merchant becomes `-`.
Merchant punctuation, parentheses, numbers and complete names are retained. There
is no alias mapping or network service. Other transaction actions remain visible.

`extractMerchant` shares those rules and no longer drops the first segment at a
hyphen/colon or truncates long names. All six native parsers and three historical
XLSX adapters use it. Existing merchant and category values remain untouched.

## Persistence and compatibility

The stored `description` is source-cleaned text and is part of the existing
fingerprint **and exact occurrence matching**. Changing it on import or in a
migration would break overlap detection. It therefore remains unchanged for both
new imports and old records. `transactionDisplayDescription` computes the display
value at the presentation boundary. Never persist its result or use it as identity
input. Source-format cleanup is shared with the bank parsers in
`core/sourceDescription.ts`; that cleanup retains the previous identity behavior.

No IndexedDB schema migration, financial recalculation, ID/fingerprint/occurrence
rewrite, or source association change is performed. JSON/ZIP backups still contain
exact stored records; restoration uses the existing conflict and atomicity rules.
CSV/XLSX display descriptions share the UI conversion and include raw descriptions
(the ledger archive appends `raw_description` to Technical Metadata). Search can
match display descriptions, stored descriptions, merchants and raw descriptions.

## Manual edits and conservative limits

The historical model does not record field-level edit provenance. A description
is displayed with normalization only if it equals the original description or
recognized source-format cleanup of that original. Any divergent value is shown
verbatim, even when it starts with `消费`. Merchant and category edits are never
regenerated. There is no write during display, search or export.

A user intentionally entering exactly the original source value is indistinguishable
from the import value: its display will be normalized, while its persisted value
and backup remain exact. Older records with unrecognized cleanup are displayed
verbatim. Existing merchant labels previously damaged by extraction cannot be
reconstructed safely without risking manual edits; the normalized description
provides the complete label, and new imports extract the full merchant correctly.

For example, `网上消费 支付宝，合成 A-B (HK)` displays and exports as
`支付宝-合成 A-B (HK)`, while the original remains available in tooltips, exports
and backups. `消费 自定义描述` replacing a different original remains unchanged.
