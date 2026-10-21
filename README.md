# Keepraw-Ledger

**A privacy-first, local-first credit card statement parser, ledger, and reconciliation tool for Chinese bank statements.**

Keepraw-Ledger converts supported credit card statements into structured transactions for review, reporting, and archival. The supported application is a browser-based React and TypeScript frontend with IndexedDB storage, statement import, transaction review, reconciliation, and backup tools. There is no application backend. The retired Python implementation has been removed.

**Live project homepage:** [ledger.keepraw.com](https://ledger.keepraw.com/) (as listed in the GitHub repository settings).

This project is under active development and is not a replacement for your bank's official records.

## Features

The web application currently includes:

- **Statement import:** Bank-specific PDF and EML parsers, with explicit format detection instead of an unrestricted generic fallback.
- **Transaction ledger:** Search, filtering, categorization, manual editing, and CSV/XLSX export.
- **Reconciliation:** Compare parsed transactions with available bank statement summaries; flag missing or mismatched data for review.
- **Data quality and review:** Surface low-confidence rows, possible duplicates, and incomplete information.
- **Dashboard:** Spending summaries and trends. Unreconciled statements are excluded from the dashboard by default.
- **Local-first storage:** IndexedDB through Dexie, with original statement attachments stored when the browser permits.
- **Demo mode:** In-memory fictional sample data, isolated from the real ledger and blocked from real-statement imports.
- **Backup and restore:** Lightweight JSON data backups and ZIP archives containing available original documents.
- **Legacy import:** Explicit adapters for recognized historical XLSX export formats, with a preview before import.

Amounts are represented internally as integer minor currency units (for example, cents or fen) rather than accumulated as floating-point currency values. This does **not** eliminate the need to validate parsing, transaction direction, and reconciliation results.

## Supported statement formats

These are the formats registered by the **web** parsing pipeline.

| Bank | Input format | Parser |
| --- | --- | --- |
| Bank of China (BOC) | Text-based PDF statement | `boc_pdf` |
| Industrial and Commercial Bank of China (ICBC) | HTML email statement (`.eml`) | `icbc_eml` |
| Agricultural Bank of China (ABC) | HTML email statement (`.eml`) | `abc_eml` |
| China Construction Bank (CCB) | HTML email statement (`.eml`) | `ccb_eml` |
| Bank of Communications (BOCOM) | HTML email statement (`.eml`) | `bocom_eml` |
| China CITIC Bank | HTML email statement (`.eml`) | `citic_eml` |

**Scope:** These parsers support the bank statement layouts they have been developed and tested against, **not every historical or regional variation** of each bank's statement. The web app does not currently provide OCR for scanned, image-only PDFs. Unrecognized files should be treated as unsupported and checked manually.

Historical XLSX migration runs entirely in the browser: **XLSX → TypeScript adapters → IndexedDB → JSON backup / XLSX archive**. It requires no Python installation, Python preprocessing, SQLite database, account, or parsing server. The same three adapters support BOC, ICBC, ABC, CCB, BOCOM and CITIC rows, including mixed-bank workbooks.

| Historical sheet | Required column convention | TypeScript adapter |
| --- | --- | --- |
| `标准字段` | The complete 15-column snake_case export | `legacy-python-export-v1` |
| `交易明细` | 银行 / 卡尾号 / 交易日 / 入账日 / 说明 / 交易币种 / 交易金额 / 结算币种 / 结算金额 | `legacy-keepraw-export-v1` |
| `统一账单` | 银行名称 / 卡号 / 交易日期 / 入账日期 / 交易详情 / 交易币种 / 交易金额 / 入账币种 / 入账金额 | `legacy-unified-bill-v1` |

The `python` in the first adapter's identifier records a compatible historical file format; it does not invoke Python. These fixed schemas are not a general-purpose bank XLSX layout detector. See the [TypeScript historical migration workflow and validation](docs/typescript-historical-migration.md) for import, review, backup, recovery and identity boundaries.

Python retirement and its migration evidence are recorded in [the readiness audit](docs/python-retirement-readiness.md).
The Web migration workflow supports `legacy-python-export-v1` (`标准字段`),
`legacy-keepraw-export-v1` (`交易明细`), and strictly detected
`legacy-unified-bill-v1` (`统一账单`, nine full Chinese headers). Future dates are
preserved for review; malformed original money, unsupported currency precision
and 1904-date-system workbooks are refused explicitly. The supported historical
data path is **XLSX Import → TypeScript Importer → IndexedDB → JSON Backup → Browser Restore**.
SQLite historical audit: **NOT APPLICABLE** — legacy SQLite artifact unavailable.

## Getting started with the web app

### Use the hosted app

1. Open the [project website](https://ledger.keepraw.com/).
2. Explore **Demo Mode** on first use. The example transactions are fictional and remain separate from the real database.
3. Open **Settings**, disable Demo Mode, then open **Import**.
4. Choose or drag in supported PDF/EML statements. Multiple files can be selected together.
5. Examine the **Reconciliation**, **Data Quality**, and **Review** views before relying on the dashboard totals.
6. Export a backup from **Settings**, and store the file somewhere outside your browser.

The site is a static frontend: it does not require a project account or an application server to store financial records. Opening the hosted site still involves downloading its HTML, JavaScript, and other assets.

### Run locally

**Requirements:** Node.js 22 and npm are recommended for consistency with the repository's GitHub Actions workflow.

```bash
git clone https://github.com/keepraw/keepraw-ledger.git
cd keepraw-ledger/web
npm ci
npm run dev
```

Vite prints the local URL, generally `http://localhost:5173/`. No API key, cloud database, or external parsing service is needed.

### Web development commands

Run these commands from the `web/` directory:

```bash
npm run typecheck            # TypeScript
npm run lint                 # ESLint
npm test                     # Vitest unit and integration tests
npm run build                # Production build
npm run verify               # Typecheck + lint + tests + build
npx playwright install chromium
npm run test:e2e             # Playwright browser tests
npm run test:migration       # Browser-only historical migration + JSON recovery
```

The single Validation workflow (`.github/workflows/ci.yml`) runs Web checks (TypeScript, ESLint, Vitest including goldens, build, npm audit, and Chromium Playwright). Deployment requires the Web job to succeed and a push or explicit dispatch on `main`. It reuses that run's validated `web/dist` artifact; PRs neither upload Pages artifacts nor deploy. Deployments are serialized, and superseded main revisions are skipped. For a GitHub Pages project subpath instead of the configured custom-domain root, set `VITE_BASE_PATH` for the build.

## Storage, privacy, and backup

### What stays local

The web application parses statements in the browser and stores ledger data under the current site's origin in **IndexedDB**. It does not have a dedicated backend that receives your statements.

This is a **local-processing model**, not a promise that the device never connects to the internet. The hosted website must load static assets, and other software on your device (including browser extensions) is outside the application's control.

IndexedDB data is isolated by browser profile and site origin:

- Different devices and browser profiles do not automatically share data.
- The hosted domain and `localhost` do not automatically share data.
- Clearing site data, using private browsing, or browser storage eviction can remove your local ledger.

### Backup formats

| Backup type | Includes | Excludes / caveats |
| --- | --- | --- |
| **JSON data backup (V2)** | Statements, transactions, import records, independent review notes, application settings | Original PDF/EML files; historical V1 backups contain no review notes |
| **Full ZIP archive (V2 database.json)** | V2 JSON database, manifest, and original files still available in IndexedDB | Original files already missing from browser storage; historical V1 archives contain no review notes |

A full archive reports missing original documents in its manifest rather than inventing them. Both formats contain sensitive financial data and are **not encrypted by the application**. Protect downloaded backups accordingly. V2 exports preserve independent free-text review notes across devices; V1 files cannot restore notes that were never exported (V1 restores keep existing local notes unchanged).

Database v4 removes the retired standalone `merchant` property from existing
transactions in one atomic upgrade, preserving every other field and transaction
identity. Transaction details use `description`, with `rawDescription` retaining
the source. Historical V1/V2 JSON and ZIP backups remain readable: restoration
discards only the retired field, and new backups omit it.

Backup restoration merges records by primary key; importing the same backup again does not create a new copy of the same records. Existing matching records retain their metadata; conflicting financial fields or conflicting note content abort restoration instead of overwriting. Keep a separate backup before any restoration or migration. XLSX/CSV archives include transaction IDs, fingerprints and occurrence numbers for independent inspection; use JSON to restore the application state.

### Data deletion and browser storage limitations

**Clear Real Data** removes statements, transactions, and imports not explicitly marked `isDemo: true`; records without that marker are treated as real. It also removes review notes and original-file attachments without a reliable link to surviving demo data, including orphans. Notes for surviving demo transactions remain, as do attachments referenced by surviving demo imports, including a file hash shared with a real import. Settings are retained. The cleanup runs in one IndexedDB transaction and rolls back if it fails.

**Clear All Data** removes every record from the `statements`, `transactions`, `imports`, `reviewNotes`, and `attachments` IndexedDB tables, including stored demo data and orphaned notes and attachments. The separate sixth `settings` table is not included, so application settings may remain. Demo examples are generated in memory; clearing persisted records does not permanently disable or remove the demo feature.

In-app cleanup applies to app records; it cannot guarantee that browser-managed storage or device media has been physically erased or made unrecoverable. Manually clearing this site's browser data can also remove its IndexedDB data and application settings. Downloaded JSON/ZIP backups, original files saved outside the browser, and other copies are not deleted by in-app cleanup. Back up anything you need to keep before deleting data.

## Repository layout

```text
web/
  src/app/               React application state
  src/core/              Amounts, identity, dedupe, analytics, reconciliation
  src/parsers/           Bank-specific browser parsers
  src/db/                Dexie and IndexedDB storage
  src/importers/         Historical XLSX import adapters
  src/backup/            Data and full-archive backup logic
  src/ui/                Views and components
  tests/                 Vitest unit and integration tests
  e2e/                   Playwright tests
  scripts/               TypeScript migration audit and golden-fixture tooling
golden/                  Frozen historical regression baselines
docs/                    Parser and format research
.github/workflows/       Web validation and GitHub Pages deployment
```

## Development and correctness guidelines

Changes to bank parsers, monetary amounts, deduplication, migration, or backup logic should be tested against **synthetic or desensitized fixtures**. Check transaction counts, duplicate occurrences, signed amounts, currencies, statement periods, reconciliation differences, and review flags.

The repository includes golden fixtures for the six registered banks (`golden/README.md`), plus focused Web tests. Frozen `python.json` snapshots remain as TypeScript regression inputs and do not require a Python runtime. These are regression aids, **not** proof that every statement template is supported or every financial edge case has been verified.

### Known limitations requiring follow-up

- **Transaction identity:** PR #12 preserves occurrences and user edits. Ambiguous legacy/native classification, posting-date, description and original-money disagreements now request review and remain distinct. Equal business rows without evidence distinguishing overlap from a new event still require care.
- **Financial import safety:** Malformed money, conflicting currency tokens and invalid precision in a recognized bank transaction fail the complete parse. Historical adapters report excluded source rows. No stored history is repaired automatically.
- **Currency and duplicate totals:** Dashboard amounts, trends and distributions include only CNY settlement rows; other settlement currencies are retained with an explicit exclusion warning, without FX conversion. Unresolved suspected duplicates remain included with a warning and bounded source comparisons in Review.
- **Stored attachment lifecycle:** PR #13 fixes transactional clearing and evidence/result association. Evidence retention remains best effort under browser quota limits.
- **Backup integrity:** PR #14 validates records and restores ZIP data/evidence atomically. V2 backups preserve independent free-text review notes with conflict rejection and atomic rollback; historical V1 backups remain readable but contain no review notes.
- **Testing and dependencies:** Keep Web and browser checks mandatory, monitor dependency advisories, and extend large-dataset coverage as needed.

This is a personal finance data tool. **Always compare imported results with official bank statements** before using the output for financial decisions.

## Protecting real statements

Never commit original credit card statements, unredacted transaction records, log files, database files, or backup archives to the public repository. The `.gitignore` ignores typical sensitive file types and runtime folders, but it is not a substitute for checking staged files:

```bash
git status --short
git diff --cached --name-only
```

If a sensitive file was committed, deleting it in a later commit does not remove it from Git history. Treat exposed information accordingly and review the repository history.

## License

There is no `LICENSE` file in the repository at the time of writing. Public source visibility alone does not grant permission to redistribute or relicense this work. Add an explicit license if external usage or contributions are intended.
