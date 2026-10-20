# Golden Fixtures (Task A-3.4)

Frozen historical regression baseline. TypeScript compares **normalized** outputs, never the
native `Transaction` models directly (see A-3.2/A-3.3 audits).

## Layout

```text
golden/
  <bank>/                  # boc | icbc | abc | ccb | bocom | citic (Web BankId)
    <card>_<yyyymm>/       # linkable card suffix and statement month
      input.meta.json     # traceable input reference (hash, no content)
      python.json         # golden/v1 normalized Python output (desensitized)
      web.json            # golden/v1 normalized Web output (desensitized)
      diff.json           # diff report (BLOCKING / WARNING / INFO + identity table)
```

## Rules

1. **Raw bills are never committed.** `processed/`, `inbox/` and `*.eml/*.pdf`
   are git-ignored. Only `input.meta.json` (file name, size, SHA-256, cycle,
   counts) is stored. These references are linkable financial metadata, not
   anonymous data; exact dates/amounts and deterministic merchant hashes also
   remain. See the [privacy audit](../docs/python-retirement-readiness.md).
2. **Committed outputs are desensitized** (`"desensitized": true`). Merchant and
   personal names become `商户_<fnv1a32>` placeholders (order-independent, so
   both pipelines map the same merchant to the same placeholder); dates,
   amounts, currencies, directions, row counts and structural prefixes
   (`消费`, `还款`, `(存入)` …) are preserved byte-for-byte.
3. **The golden layer never merges.** `diff.json → identity` only observes which
   business keys pair (`full` / `partial` / `unpaired`, always `merged: false`).
4. **P2 fields are never compared** (`merchant`, `category`, `flags`, `summary`).

## TypeScript tooling

The Python generator and runtime are retired. The committed `python.json`,
`web.json`, `input.meta.json` and `diff.json` files remain immutable regression
inputs. TypeScript validates and recomputes their comparisons with `npm test`.
For a separately reviewed new Web snapshot, the TypeScript generator remains
available and requires the original file with a matching SHA-256:

```bash
# From web/
npm run golden:generate -- --input /path/to/local/statement --out /path/to/new/reference
```

## Batches

`cd web && npm test` independently loads and validates all committed references,
checks transaction multiplicity and financial fields, and recomputes the complete
diff and identity pairing without Python. The six immutable historical snapshots
remain unchanged: 66 transactions, zero BLOCKING differences and eight approved
description warnings. Synthetic parser tests are separate; private originals are
not required for this reference gate. Never regenerate expected files to make a
regression pass.

This reference gate compares saved outputs, not a fresh parse of the six historical
private originals. `web/tests/currentParserGolden.test.ts` separately invokes all
six current parsers on invented templates and checks independently specified
transaction counts, multiplicities, both monetary legs, currencies, directions and
classifications through ingestion and IndexedDB persistence. These synthetic
references supplement the historical JSON; they do not certify private layouts.

- Batch 1: `icbc/3443_202607`, `abc/3982_202607`, `ccb/5574_202607` — real EML.
- Batch 2: `boc/6505_202607` (real PDF via pdfplumber / pdf.js geometry),
  `bocom/5155_202607` (real EML), `citic/7650_202607` (real EML, Web side uses
  the experimental parser, see below).

## CITIC note

CITIC (`citic_eml`) is a registered production parser (`web/src/parsers/citic.ts`,
in `PARSERS`). The golden generator resolves it through the normal registry
path (`detectParser`), so `golden/citic/*/web.json` is reproducible with no
special cases. History: on the old `main` the parser was reverted (`f1c81b6`)
and the baseline temporarily used an unregistered copy; after the
experimental → main migration the production parser is authoritative and no
duplicate exists in the tree.

## New output privacy policy (AUD-013)

Generator `keepraw-golden-ts/1.1.0` keeps `golden/v1` and leaves all frozen JSON
references unchanged. Newly generated shareable output omits source debug text
(`rawText: ""`); parsed descriptions retain only a fixed structural prefix and a
deterministic, idempotent merchant placeholder. The standalone raw-text helper
projects only currency/decimal pairs and ISO dates, never whole CJK runs merely
because they contain words such as `消费`.

The normalizer rejects unexpected text in structural fields, full account
numbers in card-tail fields, nonnumeric source positions and native identifiers
that do not match the computed financial fingerprint. Amounts, currencies,
dates, directions, counts, valid card tails and native identities remain the
independent comparison evidence; they are not rewritten to make a baseline pass.
These retained fields and deterministic hashes remain linkable financial
metadata, not anonymous data.

The CLI always desensitizes output and rejects `--no-desensitize`. Successful
logs omit source paths, card tails and cycles; failures do not echo parser text
or filenames. Input SHA-256 checks against `input.meta.json` still apply.
The adapter's explicit `desensitize: false` option remains for local test/debug
comparisons, not for generating shareable fixtures. Review new output before
publication. Never regenerate the frozen references to accept a privacy fix;
the regression suite checks their original hashes and financial comparisons.
