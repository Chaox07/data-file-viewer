# SQL filtering implementation evidence

Implementation authorized 2026-09-23. Scope is the unified
[implementation plan](sql-filtering-plan.md). Work in progress; this is not a
release or a claim that the installed extension has these protections.

## Phase status

| Phase | Status |
| --- | --- |
| 1. Baseline and execution design | Baseline captured; design implemented. Performance acceptance remains open. |
| 2. Restricted execution and cancellation | Provider integrated with killable restricted reader and separate trusted saves; security acceptance in progress. |
| 3. Catalog and SQL handoff | Implemented: document-owned targets, actual types, lazy sheet preparation and inline SQL. |
| 4. User workflow and diagnostics | Browser workflow passes; diagnostic and notice privacy checks pass. Installed-host checks remain open. |
| 5. Acceptance | In progress; full matrix is not yet closed. |
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

The baseline document serialized connection use with an unbounded queue.
The implementation now bounds that queue and moves read parsing/query work into
the reader process. Explicit saves still run through the trusted host writer.

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
`src/queryPolicy.ts` is used by the restricted reader, now integrated into the
provider through `ViewerFile`.

The child process passes native cancellation and a separate uncooperative-process
hard-stop test. Cancel now invalidates pending replies and kills the reader
immediately, because ingestion helpers may catch interrupts. Requests are
bounded; cancellation/disposal rejects pending promises and worker generations
prevent old replies from satisfying new requests. Read RPC exposes no save method.

Current full regression run: 741 tests, 709 passed, 0 failed, 28 skipped, 4 TODO.
Typecheck and diff whitespace checks pass. This is intermediate evidence, not
completion of the plan's acceptance matrix.

Additional current evidence:

- Real-provider browser workflow: target types, unchanged selection draft,
  explicit SQL handoff/restoration, inline filters, exact date filtering,
  failed-query discovery and hostile metadata rendered without resource fetches.
- Chart browser regression: 200,000 points, crosshair, exact hover values after
  zoom, wheel/brush/reset, line/scatter, categories, gaps and legend changes.
- Save/backup comparison: CSV, DuckDB, XLSX, SQLite, Parquet, Arrow stream and
  Feather pass. This exposed and fixed a missing precise allowlist entry for
  Feather's converted backup; no directory-wide grant was added.
- Worker tests cover deadlines, late-success cancellation, private scratch
  cleanup after close/crash, environment filtering and the four-worker pool.
- Workbook preflight tests cover unsafe paths, entities, actual aggregate
  inflation, part/count/compressed budgets and refusal to loosen limits.
- Result tests cover UTF-8 cell limits, aggregate payload limits and 200,000
  small rows. Reading notices and raw native failures omit sampled values.
- Paired-file checks exposed a read-only attachment regression: SQLite sibling
  views now use an explicitly writable in-memory catalog while source files stay
  read-only. Exact host-built grants survive reader refresh; altered queries
  cannot reuse those grants. View trust is scoped to its catalog.

Remaining gates include the complete adversarial/lifecycle matrix,
high-load measurements, disposition of existing skips/TODOs,
package inspection, installed-host verification and macOS/Windows CI. The
installed extension remains 0.0.13. No release claim is made by this checkpoint.

All remaining SEC, REL, INT, PERF, DOS and PKG families from the unified plan
remain required. No family is complete merely because a baseline probe passes.

Expanded Windows CI exposed native fixture-handle leaks and a production DuckDB
backup copy failure under Windows' exclusive file locks. Fixtures now close
their owning instances; the Windows backup path checkpoints, closes its native
owner, copies to a unique destination and restores the connection. A second
raw writer open may explicitly refuse an exclusive Windows lock; its test also
checks that the first connection remains usable and unchanged. Windows CI must
verify these changes before release. Matrix jobs no longer cancel the other
platform when one fails.

Adversarial follow-up also rejects replayed request IDs, checks UTF-16 XML entity
declarations, bounds failure metadata and prevents user-defined macros from
inheriting grants for built-in range functions. Local browser checks remain green.
