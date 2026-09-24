# SQL filtering implementation evidence

Implementation authorized 2026-09-23. Scope is the unified
[implementation plan](sql-filtering-plan.md). Local acceptance checkpoint of
2026-09-23: 0.0.14 is built and installed on the development machine from an
uncommitted working tree. It is not a GitHub release; Windows and CI evidence
are still missing (see *Unexecuted*).

## Phase status

| Phase | Status |
| --- | --- |
| 1. Baseline and execution design | Done. Performance baselines recorded below. |
| 2. Restricted execution and cancellation | Done on macOS. Containment, deadlines and cleanup verified (SEC-01–13, DOS-01). |
| 3. Catalog and SQL handoff | Done. |
| 4. User workflow and diagnostics | Done. Browser and isolated installed-host workflows pass. |
| 5. Acceptance | Done on macOS arm64. All families executed locally; Windows rows are unexecuted. |
| 6. Release and installation | Local part done: README, 0.0.14, VSIX inspected and installed. Not pushed; no CI or release assets. |

## Acceptance checkpoint (2026-09-23, macOS arm64)

`npm test`: 768 tests, 764 passed, 0 failed, 0 skipped, 4 TODO.
`test:security` 42/42, `test:resources` 6/6, `test:browser` and `test:host`
pass, `test:package` passes on `data-file-viewer-0.0.14.vsix` (1,488 files,
42.5 MB). Fuzz: seed 20260923 (default) and a 30,000-run campaign with seed
777001, both clean.

| Family | Tests | Result |
| --- | --- | --- |
| SEC-01–04 outside files | `securityMatrix`: 9 reader functions × absolute/relative/symlink/prefix/glob/`file://` paths, nested/CTE/lateral/lambda/union forms, persisted views and macros; all 8 read paths | No canary in any result or error. Disabling `restrictedReads` makes all 8 tests fail. |
| SEC-05–07 network | Local listener; http/https/redirect/credential URLs; stored remote view during open, catalog and preview | 0 connection attempts |
| SEC-08–10 writes | 45 write/DDL/COPY/ATTACH/SET/INSTALL/multi-statement/comment/dollar-quote forms | Document hash and directory listing unchanged |
| SEC-11–13 catalogs | Two documents, schemas with the same name, attached `backup_cmp`, hidden SQLite source catalog | Only this document's relations are reachable |
| SEC-14–17 messages | Seeded fuzz of `validateQueryMessage`, cycles, BigInt, depth bombs in read fields, replayed and older request IDs | Always a typed refusal or a well-formed message |
| SEC-18–20 hostile names | Quotes, SQL punctuation, markup and Unicode in sheet/header/value names, through filter, sort and SQL handoff | Exact matches; `contains` is literal, not LIKE |
| SEC-21–23 sinks | Sentinel in path, literals, identifiers and failing SQL through run, stats and chart | Not in webview messages, notifications or output channel |
| SEC-24–26 trust | Trust revoked after open | All operations refused at execution time; no write; works again after trust returns |
| REL-01–12 | Date/text/year/mixed/NULL/precision matrix; SQL handoff round trips | Explicit errors; no silent conversion |
| REL-13–20 | Stale owners, cross-document target IDs, catalog generations, source replaced on disk, cancel, 10-Run burst | See defect D1 |
| INT-01–04 | Edit from a filtered result, user `rowid` column, stale workbook bounds, failed publication | Checked by an independent DuckDB reader |
| PERF-01–04, DOS-01–04 | `test/resources/` | Below |
| PKG-01–04 | `test/package.cjs` | Passes on macOS; Windows not run |

Scanner/parser comparison: 0 Safe Mode scanner misses in 30,600 seeded runs.
Every miss would still have to be refused by the reader, as the test requires.

### Measurements (this machine, `npm run test:resources`)

| Case | Result |
| --- | --- |
| 200,000-row CSV | cold open 165 ms, first query 54 ms, warm filter p50 39 ms / p95 40 ms, sort+stats+chart 205 ms, worker RSS 146 MiB |
| 50 sheets / 500 tables + 32,000-char cell | cold open 122 ms, 1,000 target switches p50 2.9 ms / p95 3.2 ms, unreferenced sheets stay unprepared, RSS 117 → 173 MiB then flat at 174 MiB over 50 refresh cycles |
| Runaway SQL (2.5 s test deadline) | CPU-bound and recursive stopped at 2.5 s; cartesian stopped by the memory budget in 90 ms; worker process and scratch directory gone |
| Zip bomb (300 MB inflated), `A1:XFD1048576` dimension, entity expansion, truncated part | refused in ≤ 100 ms |
| 4 documents × 12 concurrent requests | 16 refused by the per-worker bound; every document answers afterwards |
| Supplied files (temporary copies) | DuckDB open 59 ms, xlsx open 643 ms; corrected queries 8 ms each |

### Supplied-file acceptance

On temporary copies of the two reported files: both original predicates fail
with explanatory messages. The corrected queries return 100 rows, and the
workbook's inline filter hands the same 100 rows to SQL. `Raw_Data · Table 2`
is listed at B11 with DATE-typed `Date` and 16,803 rows, separately from
Table 1. Stats and chart come from that exact result. Original SHA-256 hashes
were unchanged; the copies were deleted.

### Defects found and fixed at this checkpoint

- **D1 (REL-17):** a burst of Run clicks filled the 8-slot queue with work a
  newer Run had already superseded, so the newest query was refused. Superseded
  query jobs no longer count against the limit and are skipped when reached,
  with a hard ceiling of 64. Regression: `hostProtocol` REL-17–20, which fails
  on the previous code.
- **D2 (diagnostics):** a worksheet DuckDB cannot read (for example, a cell
  over Excel's 32,767-character limit) gave a generic error. A query naming
  one of its detected tables said "select a table from this document's query
  catalog". Both now give the real reason. Regression: `queryDiagnostics`.
- **Test harness:** E21 looked for the Tier B corpus one directory above the
  repository, so it had always skipped. It now uses `stress/paths`.
- **Packaging:** `.vscodeignore` now excludes `*.vsix` and `docs/**`.

### Triaged, not fixed

- `repeat()` and other scalar functions sharing a name with a table function
  are refused (usability; `rpad` is the documented workaround).
- The 4 TODO known bugs (blank CSV invents rows ×2, `""` reads as NULL, text
  typed into a numeric workbook column reads back empty although written
  correctly) predate this feature, are not confidentiality or corruption
  issues, and are outside the plan's scope.
- Errors crossing the worker boundary keep their message, but their category
  becomes `blocked`.

### Unexecuted (require a push)

Windows CI (native handle-leak fixes, exclusive-lock backup path), the
macOS/Windows CI matrix, release assets and installed-host verification on
Windows. These are release blockers under section 6 until run.

## Speed checkpoint (2026-09-24, 0.0.15)

Profiled every format by stage (`test/resources/profile.test.ts`), then changed one
thing at a time against an equivalence snapshot of 14 files
(`test/resources/equivalence.test.ts`). Full detail, and the list of what to
scrutinize, is in [review-handoff.md](review-handoff.md).

| File | Stage | Before ms | After ms |
| --- | --- | ---: | ---: |
| YieldCurve.xlsx (21 MB) | open / edit one cell | 686 / 9,961 | 389 / 1,330 |
| strings.xlsx (40k rows) | edit | 1,139 | 233 |
| CSV 200k | warm query / sort / stats / Run round trip | 58 / 96 / 58 / 142 | 2 / 14 / 11 / 9 |
| SQLite 200 tables | open / edit | 812 / 1,924 | 184 / 581 |

Changes:
- the throwaway writer skips its post-edit re-read
- workbook patches copy untouched ZIP members and use native zlib
- workbook edits are located by the reader and patched by the host, guarded by a SHA-256
  of the bytes the reader opened
- the preflight uses native streaming inflate
- CSV is cached as a table in the read worker
- SQLite catalog reads are batched

The only observable difference: a reading notice is no longer shown twice after a
workbook edit. Still slow: the first query after a workbook edit (~5 s, the
text-column probe re-runs).

## Opening checkpoint (2026-09-24, 0.0.16)

Same method, against a fresh baseline that was byte-identical to the 0.0.15 one;
the finished set reproduces it with 0 differences on 14 files. Detail and what to
scrutinize: Part C of [review-handoff.md](review-handoff.md).

| File | Stage | 0.0.15 ms | 0.0.16 ms |
| --- | --- | ---: | ---: |
| YieldCurve.xlsx (21 MB) | open → first data-table view | 5,404 | 3,139 |
| | first query after an edit | 4,969 | 2,899 |
| | reader restarted on unchanged bytes, table again | 3,130 | 2,430 |
| CSV 200k | open | 403 | 327 |
| Parquet / DuckDB / Stata / Arrow / SQLite | second file opened while one is open | 75 / 76 / 80 / 80 / 192 | 11 / 10 / 18 / 22 / 136 |

Changes:
- one spare reader process is kept ready while a document is open
- one catalog scan builds the function allowlist
- reader threads are half the machine's cores (was 2)
- workbook `<dimension>` heads are read through the central directory with native zlib
- the text-column check runs as parallel column groups on side connections of the same
  instance
- its decisions are cached in the host's memory for the tab, for identical bytes only
- the sheet grid reaches detection as JSON rows
- a worker's CSV is cached before the check

Dropped after measuring:
- install-only-if-load-fails (under 0.5 ms)
- batched SQLite views (5%)
- a marker-test change (no gain)
- a Rust Excel reader (cell text not identical)

Tests: 781 (777 pass, 4 TODO), security 43/43, browser, fuzz seed 20260924, resources,
package, host.

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
