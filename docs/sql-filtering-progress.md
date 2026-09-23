# SQL filtering implementation evidence

Implementation authorized 2026-09-23. Scope is the unified
[implementation plan](sql-filtering-plan.md). Work in progress; this is not a
release or a claim that the installed extension has these protections.

## Phase status

| Phase | Status |
| --- | --- |
| 1. Baseline and execution design | In progress: engine capabilities and synthetic regressions verified; runtime ownership prototype next. |
| 2. Restricted execution and cancellation | Restricted engine, native AST authorization and read worker tested; provider/save handoff not yet integrated. |
| 3. Catalog and SQL handoff | Not started. |
| 4. User workflow and diagnostics | Not started. |
| 5. Acceptance | Not started. |
| 6. Release and installation | Not started. |

## Baseline

Source baseline: `4f71065`, extension 0.0.13; macOS arm64, DuckDB v1.5.5,
`@duckdb/node-api` 1.5.5-r.3. Existing suite: 704 tests, 672 passed, 0 failed,
28 skipped, 4 TODO. Skips and TODOs are not security acceptance evidence.

Read-only reproduction used temporary copies of the two supplied files. Both
original predicates failed; both corrected predicates returned 100 rows. Both
original SHA-256 hashes remained unchanged. No source rows, paths or hashes are
published here. Temporary copies were deleted.

| Format | Open + original failure + corrected query | Five warm corrected queries | Process RSS after sample |
| --- | --- | --- | --- |
| DuckDB | 19 ms | 4, 2, 2, 3, 2 ms | 122 MiB |
| XLSX | 5241 ms | 5, 5, 4, 4, 15 ms | 635 MiB |

These are a small local baseline, not p95/peak-RSS acceptance measurements. The
Excel RSS includes native allocations outside DuckDB's query memory budget.

## Execution inventory and ownership design

`duckdbConnection.ts` contains three kinds of native access:

- Trusted setup: format extension bootstrap, source attachment, worksheet
  preparation, text interpretation, cached table creation and schema reads.
- Reads containing caller SQL: Run, sorted Run, chart probes/results, counts,
  descriptive/top-value statistics, editability probes and backup diff replay.
  Inline filtering and live refresh enter these same operations. Stored views
  and macros can execute through any of these paths.
- Writes: backup publication, explicit cell updates, flat-file materialization,
  SQLite transactions, workbook patching and atomic file replacement.

The existing document serializes connection use, but the queue is unbounded.
Native parsing and query work currently run inside the extension host.

Implementation design: a document-owned child process holds the restricted read
connection and worksheet caches. Only explicit host RPC methods are exposed.
The parent bounds requests and deadlines, handles cancellation and discards old
worker generations. Killable readers never save data. Explicit existing saves
must close the reader, use the trusted write path, then reopen and invalidate read
state. DuckDB file locks make concurrently opening a separate read-only process
alongside a read-write owner unsuitable. A worker is an availability boundary,
not a native-code security sandbox.

File policy: derive canonical source paths in the host; permit precise paths
needed for the opened format, never the directory. Bootstrap only the format's
host-selected extensions before locking capability settings. No automatic grant
on errors or when Safe Mode is switched off. Disable spill initially; do not
create unbounded plaintext intermediates. Source alias/replacement behavior and
format compatibility still require integration verification.

Restricted Mode: fail closed before starting a query runtime or save operation
until a restricted preview path passes the same acceptance tests. Recheck trust
and Safe Mode when queued work starts. Catalog identity and drafts belong to the
owning view and source generation.

## Evidence added

`test/queryRuntimeBaseline.test.ts`:

- Synthetic outside-file and persisted-view reads are denied by locked engine
  settings; an approved CSV still returns the correct sum.
- A local HTTP listener observes zero requests for the blocked remote read.
- Settings changes, extension installation and nested outside-file reads fail.
- DATE/TIMESTAMP/VARCHAR versus numeric-year behavior is pinned.
- Native `getTableNames` finds unknown cold table references but expands existing
  views, losing worksheet names. Full regressions exposed this limitation.
  `json_serialize_sql` now supplies the syntactic references for lazy loading;
  existing raw worksheets, cold joins, comments and literals are covered.
- An offset worksheet region remains a separate typed relation and read-only
  querying leaves workbook bytes unchanged.

`test/queryPolicy.test.ts` covers byte-based SQL budgets, explicit result-size
rejection, locked capability settings, query memory/thread limits and no spill.
`src/queryPolicy.ts` is used by the internal restricted read mode. The provider
still uses its original runtime until save-handoff validation passes.

The child-process prototype passes cooperative native cancellation and a separate
uncooperative-process hard-stop test (about 2.03 seconds locally). Requests are
bounded; cancellation/disposal rejects pending promises and worker generations
prevent old replies from satisfying new requests. Read RPC exposes no save method.

Current full regression run: 721 tests, 689 passed, 0 failed, 28 skipped, 4 TODO.
Typecheck and diff whitespace checks pass. This is intermediate evidence, not
completion of the plan's acceptance matrix.

All remaining SEC, REL, INT, PERF, DOS and PKG families from the unified plan
remain required. No family is complete merely because a baseline probe passes.
