# DuckDB preview controls: fix plan and completion

Date: 2026-09-22. Version: 0.0.11. Base: afd73aae033ad3c2dedf9e1449c86d16820dafbb.

## Problem and scoped plan

Automatic and sidebar previews sent a `sheetPreview` marker for every table.
The host accepted it without checking worksheet identity and returned an empty
`sheetTables` array for ordinary DuckDB tables. The grid correctly interprets
any defined worksheet metadata, including an empty array, as a worksheet and
suppresses ordinary sorting, statistics and plot buttons.

The plan was to validate actual worksheet identity in the host, retain the
renderer distinction between absent metadata and empty worksheet metadata,
regress the real message handler, verify the visible UI, package and install
the fix, push a task branch and remove the disposable clone.

## Implementation

- `DuckDbFile.isWorksheet()` checks both Excel format and membership in the
  original worksheet path map. Derived tables are not worksheets.
- The provider requires this predicate before setting `lastSheetPreview`.
  Ordinary results therefore omit worksheet metadata; subsequent live refresh
  uses the corrected context.
- Four provider/reducer regressions cover DuckDB repeated selection (50
  switches), full-result sorting with LIMIT, empty results, failed-query
  recovery, manual SQL, CSV, derived Excel tables, real worksheets and
  detection disabled.
- Package and lockfile versions are 0.0.11; README records the behavior change.

No renderer workaround, data conversion, producer change, configuration
migration, sorting change or chart eligibility change was made.

## Verification

All commands ran on macOS arm64. Routine tests used Node 24 after a preliminary
Node 26 run encountered shutdown hangs while asynchronous row counts were
still running; the new test harness drains the document queue before teardown.

| Check | Result |
| --- | --- |
| Regression with the worksheet guard removed | 3 failures, 1 pass; the failures expose suppressed ordinary controls |
| Focused regression after correction | 4 passed |
| `npm run typecheck` | Passed |
| `conda run --no-capture-output -n myproject python test/stress/foreign/build_corpus.py` | Built optional independent-writer fixtures |
| `npm test` | 695 passed, 0 failed, 1 skipped, 4 existing TODOs (700 total) |
| `npm run stress` | 277 passed, 0 failed, 0 skipped, 4 existing known cases |
| `npm run package` | Built 0.0.11 VSIX |
| Real VS Code UI, baseline 0.0.10 | Automatic/sidebar preview: no header controls; manual SQL: 2 sort, 2 stats, 1 plot |
| Real VS Code UI, packaged 0.0.11 | Automatic/sidebar preview: 2 sort, 2 stats, 1 plot; ascending/descending rows verified; stats populated; USDTRY chart rendered with 100 points |
| Live mode | Normal controls remained present after reconnect/refresh |
| Excel with detection enabled | No ordinary A/B header controls; 2 inline sort buttons and 1 inline plot button |
| Excel with detection disabled | No ordinary or inline controls; all four fixture rows displayed |

The UI checks used a disposable profile and a copy of a local 11-table
DuckDB database, including a 122-row table with a VARCHAR Date and DOUBLE
USDTRY column. The original and copied database hashes remained unchanged.
Personal database files are not included in the repository; automated tests
use synthetic fixtures. The existing TODO/known cases are not claimed fixed.

The normal VS Code profile was updated using `code --install-extension
<0.0.11.vsix> --force`. Its registered version is 0.0.11. The same UI checks
were also run against that installed extension directory in a disposable
host. An existing normal-profile window may need Reload Window before its
already-loaded extension host uses the new code.

## Delivery and rollback

Source, tests and this report are delivered on `fix/duckdb-preview-controls`.
No Marketplace publication or merge into main is part of this task.
The task-owned source clone is removed only after verifying the pushed SHA.
The local VSIX and report are retained; extracted package copies, disposable
profiles, duplicated database fixtures and build dependencies are removed.

The prior installed 0.0.10 directory is archived locally for rollback. It can
also be rebuilt from the base commit above using `npm ci` and `npm run package`.
