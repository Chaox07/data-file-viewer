# Historical review handoff: SQL-filtering checkpoint and speed work (0.0.14 → 0.0.16)

This is the pre-publication checkpoint. See [0.0.19 review](review-0.0.19.md) for
subsequent corrections and validation; publication was authorized on 2026-09-24.

For an independent reviewer. Everything below is **uncommitted** in the working tree of
`feat/sql-filtering-security`, base commit `ce7845b` (origin/main is `4f71065`). Nothing
was committed, pushed, released or posted. The user asked for that explicitly, so they
can review and change the work first. 0.0.16 is built from this tree and installed on the
author's machine. Part A is 0.0.14, Part B is 0.0.15, Part C (faster opening) is 0.0.16.

Please verify claims by running the commands, not by trusting this file. Places where the
author is least sure are listed under **Scrutinize**.

## Reproduce

Requires Node 22+ and a conda env `myproject` with pandas, pyarrow and openpyxl.

```sh
git diff ce7845b --stat; git status --short                   # the whole change set
conda run -n myproject python test/stress/foreign/build_corpus.py      # Tier B corpus
conda run -n myproject python test/resources/build_profile_corpus.py   # speed corpus
npm run typecheck
npm test                     # expect 781 tests: 777 pass, 0 fail, 0 skipped, 4 TODO
npm run test:security        # expect 43/43
npm run test:browser         # two "passed" lines (needs Chrome + Playwright)
npm run test:fuzz -- --seed 20260924 --runs 20000                       # all pass (also 924001)
npm run test:resources       # DOS/PERF, PROFILE lines, EQUIVALENCE (see below)
npx vsce package --allow-missing-repository && npm run test:package && npm run test:host
```

`test:resources` compares against `test/stress/_work/equivalence/baseline.json`, which is
gitignored and machine-local. To review the speed work independently, record a baseline
yourself on the pre-change code, then compare:

```sh
git stash   # or check out ce7845b plus Part A's files into a copy
DFV_EQUIV_RECORD=1 node --test --test-timeout=1200000 out-test/test/resources/equivalence.test.js
git stash pop && npx tsc -p tsconfig.test.json
node --test --test-timeout=1200000 out-test/test/resources/equivalence.test.js   # expect 0 differences
```

Exception: comparing against the state **before E4** shows exactly two differences, both
`afterEditWarnings` (explained in E4 below). The author kept that baseline as
`baseline-v0.json`. `baseline-v1.json` is the 0.0.15 baseline; the one recorded at the
start of Part C was byte-identical to it, and Part C reproduces it with 0 differences.

The equivalence and profile tests use a temporary copy of the user's workbook at
`~/Desktop/scatter/YieldCurve_Data.xlsx` (and `.duckdb`) when present. They assert that
the original's SHA-256 is unchanged, and print no row data.

---

## Part A: SQL-filtering checkpoint (0.0.14)

Scope: phase 5 (acceptance) and the local part of phase 6 of `docs/sql-filtering-plan.md`.
The progress and evidence are in `docs/sql-filtering-progress.md`.

### Product changes

| File | Change | Why |
| --- | --- | --- |
| `src/duckdbEditorProvider.ts` | `runExclusive(fn, isSuperseded?)`: superseded query jobs do not count against the 8-slot queue, are skipped when reached, and there is a hard ceiling of 64. `runQuery`, `runCombinedQuery` and `sortQuery` pass `superseded = () => owner !== document.activeQueryRequest`. | **D1:** a burst of Run clicks filled the queue with dead work, so the newest query was refused with "Too many queued operations". |
| `src/duckdbConnection.ts` | `unreadableSheets` map: when `ensureSheetPrepared` fails before the grid is read, the error is recorded. `prepareDerivedTablesFor` rethrows it for queries naming `<sheet> · Table N`. | **D2:** a query on a table of an unreadable sheet said "select a table from this document's query catalog". |
| `src/queryDiagnostics.ts` | `Cell data too large` / `is the file corrupted` map to a `resource` diagnostic that names Excel's 32,767-character cell limit. | D2, the raw-sheet half |
| `.vscodeignore` | Adds `*.vsix` and `docs/**` | An old VSIX in the folder could be packed into the next one; the plan docs were shipped. |
| `README.md`, `package*.json` | 0.0.14 notes, test commands, version | |

### Test changes

- `test/integrityFindings.test.ts` **E21:** its corpus path went three levels up from
  `out-test/test` (outside the repo), so it had always skipped. It now uses
  `stress/paths.foreignDir`.
- New files:
  - `securityMatrix.test.ts` (SEC-01–13)
  - `queryBoundary.test.ts` (SEC-14–20, REL-01–12, seeded fuzz)
  - `hostProtocol.test.ts` (REL-13–20, SEC-21–26 through the real provider with a
    recording webview)
  - `editIntegrity.test.ts` (INT-01–04)
  - `scannerDifferential.test.ts` (the Safe Mode scanner compared with DuckDB's parser)
  - `resources/resources.test.ts` (DOS/PERF)
  - `package.cjs` (PKG) and `fuzz.cjs`
- Mutation evidence: with `restrictedReads: false` swapped into the compiled
  securityMatrix tests, all 8 fail. The D1 regression fails on the pre-fix provider.

### Things the author changed while writing tests (check that none hides a defect)

- DOS-01: the cartesian join is stopped by the 512 MB memory budget, not the deadline.
  A CPU-bound `hash()` scan was added to exercise the deadline.
  `string_agg` under `count(*)` was optimized away, so the test uses `length()`.
- DOS-04 and PERF: `repeat()` is refused by the function allowlist (see Known gaps), so
  `rpad` is used. The PERF large cell was reduced to 32,000 characters, because DuckDB
  refuses a cell over roughly 32K as corrupt, as Excel would.
- Fuzz invariants were narrowed twice: `intervalMs`/`cursor` only for the commands that
  read them, and `sql` only for `runQuery`. The rationale is that validation is per
  command and unused fields are ignored by the handlers. Verify with
  `grep -n "message.sql\|message.intervalMs\|message.cursor" src/duckdbEditorProvider.ts`.
- REL-01 fixture: a fully blank row ends a detected table, so the NULL row carries one
  cell.

### Side effects outside the repository

- Built and installed 0.0.14, then 0.0.15. Deleted the 0.0.13 and 0.0.14 extension
  directories after `extensions.json` stopped referencing them.
- Searched the home folder (read-only) for workbooks with a `Raw_Data` sheet to find the
  plan's "two supplied files". Acceptance used temporary copies, with hashes checked.
- Wrote notes to the author's memory directory. Not part of the repo.

---

## Part B: speed work (0.0.15)

Method:
1. `test/resources/profile.test.ts` measured every format by stage.
2. `test/resources/equivalence.test.ts` snapshots everything a user can observe for 14
   files: tables, detected tables, catalog, column types, full results of every relation,
   counts, sorts, top values, editability, notices, one scripted edit, the rows after the
   edit, and the decompressed members of an edited workbook.
3. Each candidate was implemented alone, then re-profiled, and had to reproduce the
   snapshot and keep all suites green.

### Results (`viewer` rows of the profile: ms, this machine, through the real worker)

| File | Stage | Before | After |
| --- | --- | ---: | ---: |
| YieldCurve.xlsx, 21 MB | open | 686 | 389 |
| | **edit one cell** | **9,961** | **1,330** |
| | first query after the edit | 4,936 | 4,961 (unchanged, see gaps) |
| strings.xlsx, 40k rows | edit | 1,139 | 233 |
| CSV, 200k rows | warm query / count / sort / stats / top values | 58 / 46 / 96 / 58 / 100 | 2 / 1 / 14 / 11 / 8 |
| | Run round trip (query + editability + count) | 142 | 9 |
| | open | 349 | 402 (+53, the one-time cache) |
| SQLite, 200 tables + 200k untyped | open | 812 | 184 |
| | edit | 1,924 | 581 |
| Parquet, Arrow, Feather, Stata, DuckDB | all | unchanged (2–25 per operation) | |

### Changes

**E1: the writer skips a post-edit re-read** (`src/duckdbConnection.ts`).
- New internal open option `discardAfterWrite`; `ViewerFile.write` sets it.
- `updateXlsxCell` returns before re-reading the edited sheet's cached tables. That
  re-read cost 1.28 s, and the writer is disposed right after (the reader reopens from
  the file).
- In-process `DuckDbFile` users, and the existing tests, keep the re-read.

**E2: ZIP rewrite copies untouched members** (new `src/zipPatch.ts`, used by
`xlsxWrite.patchCell`).
- `indexZip` parses the central directory. It declines ZIP64, encryption, multi-disk,
  methods other than stored/deflate, duplicate names and out-of-range offsets.
- `readMember` inflates with native zlib and checks the declared size.
- `rewriteZip` rebuilds local headers from the central records: sizes in the header,
  bit 3 cleared, and the original extras, timestamps, name bytes and comments kept.
  Unchanged members' compressed bytes are copied verbatim; only the replacement is
  deflated (level 6). CRC-32 uses `zlib.crc32` when present, with a JavaScript table
  fallback for older Node (VS Code ^1.85 means Node 18).
- `patchCell` now inflates only the four parts it reads (sheet, sharedStrings, styles,
  workbook). An archive outside scope keeps the old `unzipSync`/`zipSync` path.
- The member contents are identical; the ZIP encoding of the untouched members differs
  (they keep the file's original encoding). `updateCell` went from 4,025 to 957 ms in
  isolation.
- Tests: `test/zipPatch.test.ts` (round trip, data-descriptor archive, stored member,
  UTF-8 name, out-of-scope refusals, DuckDB reads the rewritten workbook), plus all
  existing `xlsxWrite`/`ext01`/`ext02` tests.

**E4: workbook edits are located by the reader, patched by the host** (`src/viewerFile.ts`,
`src/duckdbConnection.ts`, `src/queryProtocol.ts`, `src/queryWorkerEntry.ts`).
- `updateXlsxCell` was split. `locateXlsxCell` does the same `row_number()` match, the
  same refusals and the same Excel arithmetic; the patch half is unchanged.
- New read method `locateXlsxEdit(table, column, rowValues)`. It prepares the table
  through the normal query funnel, then returns the target plus `openedSha256`, the hash
  of the bytes the worker preflighted.
- `ViewerFile.updateCell` for xlsx:
  1. locate in the worker
  2. keep the old "detected table changed → refuse" check (the identity before the edit
     compared with the identity after locating)
  3. `withReaderClosed` (the same stamp check, close and reopen as `write`)
  4. `patchCell({..., expectedSha256})`
- `patchCell` refuses unless the buffer it read hashes to `expectedSha256`, so the located
  row is proven to be a row of the bytes being patched. Its existing `expectedCurrent`
  cell-value check still applies.
- This removed the writer's full sheet preparation and typed-table probe: about 5 s on the
  21 MB workbook.
- **Only observable change:** `afterEditWarnings` no longer contains duplicates.
  Previously the throwaway writer's reading notices were appended to the reader's, so
  after a workbook edit the same notice was shown twice. The set of notices is the same.
- `write` was refactored into `withReaderClosed` plus the DuckDB writer; the behavior of
  the other formats is unchanged, and the equivalence harness covers them.

**E3: native preflight** (`src/xlsxBudget.ts`).
- `preflightWorkbook` now reads the file once, hashes it, and returns the SHA-256 (the
  return type changed from `void` to `string`).
- If `indexZip` accepts the archive and every local header's name equals its central
  name (`rawMembers`), each member is stream-inflated with `zlib.createInflateRaw`,
  counting bytes against the same limits. The shared `unsafeName` and `entityScanner`
  helpers run the same checks with the same messages.
- Otherwise the original fflate streaming path runs unchanged (`preflightStream`).
- Time went from 470 to 165 ms, hash included.
- New tests: a central directory that under-declares a size (stopped by counting), the
  normalized duplicate `a\b` versus `a/b`, and a local/central name mismatch (falls back
  to the old path, which refuses it).

**E5: CSV cached in the read worker** (`src/duckdbConnection.ts`, restricted open path).
- Before the engine is locked, a CSV of 128 MB or less is materialized with
  `replaceWithTable` under its own name, and `source.cached = true`. On failure it stays a
  view.
- The trusted writer, edits and backups do not use restricted mode, so they are
  unaffected.
- The worker already refuses on any stamp change and is reopened, so the cache is never
  staler than the view.

**E6: SQLite open batching** (`src/sqliteTypes.ts` `planSqliteTables`).
- One `information_schema.columns` query and one `sqlite_query` over
  `sqlite_master × pragma_table_info` (aliased; duplicate `name` columns are a binder
  error) replace the two per-table queries.
- Any table missing from a batch uses its original per-table query.

### Candidates dropped, with evidence

- **Hoisting the text-column probe into a subquery.** It gave identical counts but was
  slower (2.9 s against 2.2 s): computing eagerly defeats lazy filter evaluation.
- **Skipping the text→decimal cast when the text equals the double's printed form.** It
  was equivalent, but only 15% of cells matched (Excel writes 17 significant digits), so
  there was no gain.
- **Deduplicating the identical second fidelity slot for decimal columns.** DuckDB
  already merges identical aggregates, so there was no gain.
- **Caching Arrow, Stata and Feather.** These are already 2–25 ms per operation.
- **Caching SQLite tables.** Not done: live-mode hot files change constantly, and every
  change would re-materialize. SQLite queries on untyped columns stay at 230–460 ms.

---

## Scrutinize

1. **E4 trust boundary.** The row ordinal and cell coordinates now come from the read
   worker, which is host code in a separate, killable process, not from the webview. Plan
   S2 forbids client-supplied coordinates, and the author reads the worker as host-owned.
   Mitigations: the SHA-256 match on the exact buffer patched, `expectedCurrent`, and the
   identity check. Decide whether a compromised worker (after a native exploit) steering
   an edit into a cell holding the same value is acceptable.
2. **E4 residual race.** `openedSha256` is taken when the worker opens, but DuckDB reads
   the workbook later, when a sheet is prepared. A change keeping the same size and mtime
   between those moments would be missed by the per-request stamp check. Pre-existing for
   reads; for edits the hash now makes it stricter than before.
3. **`zipPatch` correctness** against producers not covered here: Excel itself, LibreOffice,
   Google Sheets exports, and ZIP extras such as `0x5455` timestamps. There is a local
   header rebuild and a data-descriptor clear. Try opening a patched file in Excel.
4. **E3 fast path versus old path.** Names are judged from the central directory, with
   local names required to match. Hidden local entries not in the central directory are
   no longer scanned; DuckDB does not read them. Confirm that is acceptable.
5. **E5 CSV cache.** Check the interaction with Live mode on CSV and with `sqlite`/pair
   siblings (the cache applies only when the main file is a CSV). Memory: up to 128 MB of
   file; on failure it falls back to the view. That failure happens after a partial read.
6. **D1 `runExclusive`.** Superseded work is skipped only when `isSuperseded` is passed.
   Check that no user-initiated non-query work can be mistaken for superseded.
7. **D2** rethrows the raw preparation error. It passes through `queryDiagnostic` before
   reaching the webview; confirm no path forwards it raw.

## Known gaps

- **Windows:** CI, installed-host and release assets are unexecuted (they need a push).
  This includes the Windows fixes from the previous session and the new ZIP rewrite on
  Windows paths.
- **The first query after a workbook edit is about 2.9 s** (was 5 s before Part C). The
  reopened reader re-prepares the sheet and re-runs the text-column check, now in
  parallel. C6's decision cache does not apply here on purpose: the edit changed the
  bytes, and a decision is only reused for the exact bytes it was made on.
- **`repeat()` and other scalar functions sharing a name with a table function** are
  refused by the SQL allowlist; use `rpad`.
- **A misleading refusal message:** editing a column that isn't in the named detected
  table gives `"" is not a column of the sheet` (`columnLettersOf(-1)`). The edit is safely
  refused. Pre-existing and left alone.
- **4 pre-existing TODO known bugs** (blank CSV, `""` read as NULL, text in a numeric
  workbook column); see `docs/sql-filtering-progress.md`.
- **The equivalence baseline is machine-local and gitignored.** The synthetic corpus is
  reproducible from `build_profile_corpus.py` with a fixed seed.

---

## Part C: faster opening for every file type (0.0.16)

Same method as Part B:
- A fresh equivalence baseline was recorded on 0.0.15 before any change. It was
  byte-identical to `baseline-v1.json`, so the harness is deterministic.
- Each change was implemented alone and measured.
- The rule was to drop anything saving under ~10% of its stage.
- The finished set reproduces the baseline: **0 differences on 14 files**, and the user's
  workbook hash is unchanged.

The user decided three things beforehand:
- one spare reader process;
- decisions cached **in memory only**, dropped when the tab or VS Code closes;
- use more cores. During the work they also set the reader's thread count to **half the
  machine's cores, computed automatically** (was a fixed 2).

### Results (ms, this machine: 10-core Mac, through the real worker)

| File | Stage | 0.0.15 | 0.0.16 |
| --- | --- | ---: | ---: |
| YieldCurve.xlsx, 21 MB | open | 459 | 246 |
| | first view of the sheet | 1,989 | 1,596 |
| | first view of its data table (`Raw_Data · Table 2`) | 2,956 | 1,297 |
| | **open to first data-table view** | **5,404** | **3,139** |
| | edit one cell | 1,402 | 1,147 |
| | first query after the edit | 4,969 | 2,899 |
| | reader restarted on unchanged bytes (refresh; also Cancel, backup, refused edit), then the table again | 3,130 | 2,430 |
| strings.xlsx, 40k rows | open | 154 | 90 |
| CSV, 200k rows | open | 403 | 327 |
| Opening a second file while one is open (spare reader) | Parquet / DuckDB / Stata / Arrow / SQLite | 75 / 76 / 80 / 80 / 192 | 11 / 10 / 18 / 22 / 136 |

The profile harness closes each document before opening the next, so its own Parquet,
Arrow, Stata and DuckDB rows (60–70 ms) do not show the spare. The last row comes from a
scratch benchmark that keeps one document open, which is how the spare is meant to be used.

A correction to the author's own notes during the work: an early B5 measurement used
`getDetectedSheetTables('Raw_Data')[0]`, which is a 3-column header block, not the data
table. It reported "2.9 s → 0.6 s". The figures above use the data table (the one holding
`BETA0`, as the equivalence test does). The real B5 gain is 2,950 → 1,290 ms for that step.

### Changes

**C1: spare reader process** (`src/queryWorker.ts`, `src/extension.ts`)
- `spawnReader()` factors out the fork: filtered environment, private `0700` temp
  directory, IPC only.
- `QueryWorker.spare` is one static, pre-forked process that has opened nothing. It is
  created by `replenish()` after a reply settles, when no requests are pending and at least
  one live worker exists.
- `start()` claims it through `claimSpare()`, only if it is alive, connected and runs the
  same entry path. A dead spare is killed, its scratch directory removed, and a fresh fork
  is used instead.
- The spare is `unref()`ed (process and channel), so it never keeps the host or a test
  run alive. Claiming it `ref()`s it again.
- It is not in `workers`, so it never counts toward the four-reader cap.
- `live` counts undisposed workers. When the last one is disposed, `releaseSpare()` kills
  the spare and removes its scratch directory. `deactivate()` calls it too.
- Tests:
  - `queryWorker.test.ts`: a spare appears after a reply; the next start gets that exact
    pid, with its scratch directory; a new spare replaces it; after the last disposal the
    process is dead and the directory gone; a spare killed while idle is not handed out.
  - `queryWorkerIntegration.test.ts`: a claimed spare opens only the file it is sent,
    cannot read the first document's file, refuses a second `open`, and the first
    document is unaffected.

**C2: one catalog scan for the function allowlist** (`src/queryPolicy.ts`, `ReadSqlPolicy`)
- The two `duckdb_functions()` queries became one `group by function_name` that computes
  both flags: about 21 → 9.5 ms per reader.
- Test (`queryPolicy.test.ts`): with the excel extension loaded and user macros named
  `unnest` and `lower_macro`, both sets equal what the two old queries return, and neither
  macro is granted. The existing "user macros cannot inherit grants" test still passes.

**C3: reader threads = half the cores** (`src/queryPolicy.ts` `readerThreads()`,
`src/queryWorker.ts`)
- `max(1, floor(availableParallelism() / 2))`, falling back to `cpus().length`. That is 5
  here. The previous value was a fixed 2.
- The worker's `UV_THREADPOOL_SIZE` is set to `max(4, threads + 1)` so C5's side queries
  are not queued behind Node's default 4-thread pool.
- The user chose this after these measurements, taken with the cap at 2 and uncapped:
  - no measurable difference on any profiled file (at most 200k rows, under two 122,880-row
    row groups);
  - Excel stats went from 22 to 4 ms.
- Cost: a runaway query now loads up to half the cores, not 2, until the 30 s deadline.
  Memory is still 512 MB per reader, and spill is still 0.
- `queryPolicy.test.ts` asserts the formula, not a number.

**C4: native `<dimension>` scan** (`src/xlsxSheets.ts` `declaredDimensionsDirect`,
`src/zipPatch.ts` `sequentialLayout`, `memberHead`)
- The old scan streamed the archive through fflate until each wanted sheet's head was
  seen. YieldCurve's big sheet is stored first, so about 20 MB passed through fflate to
  reach the second sheet.
- The fast path reads the file (≤ 128 MB; above that it streams as before). It indexes the
  central directory and inflates only a prefix of each sheet with native zlib:
  `Z_SYNC_FLUSH`, prefixes of 16 KB ×4 steps, `maxOutputLength` 8 MB. It runs the same
  regex over the same 256 KB head window.
- It answers only if all of these hold:
  - the archive is laid out as a streaming reader sees it (`sequentialLayout`: members back
    to back from byte 0 in central order; each local header equal to its central record in
    name, flags, method, CRC and sizes; no data descriptors; central directory straight
    after the last member);
  - every wanted sheet is present;
  - every wanted sheet has a parseable declaration.
- Anything else falls back to the old stream, damage messages included.
- 121 → 8 ms on YieldCurve.
- Evidence:
  - a one-off differential over all 91 workbooks on this machine (the gitignored stress
    corpus, including every truncation, byte-flip, disguise and trailing-garbage variant,
    plus the user's file): identical dimensions and `damaged` for all 91;
  - the permanent test `xlsxSheets.test.ts` builds its own variants (declared, stored,
    undeclared, unparseable, declaration past 256 KB, missing sheet, four truncations,
    five byte flips, trailing bytes, data descriptors) and compares the two paths on each.

**C5: the text-column check runs as parallel column groups** (`src/duckdbConnection.ts`
`sideQueries`, `probeGroups`, `PROBE_SPLIT`)
- The whole-column probe (~400 aggregates for YieldCurve's data table) was one query. On a
  16,803-row table DuckDB runs that on one thread whatever the cap, because it
  parallelises by row group.
- The probe expressions are now cut into up to `readerThreads()` contiguous groups (at
  least 16 expressions each). Each group runs on its own new connection to the **same
  instance**, so it shares the locked configuration, the 512 MB limit and the allowlist.
- The groups' single rows are concatenated in order, so every count sits at the index
  the old code read.
- A side connection is used only if its `current_database()`/`current_schema()` match the
  main connection's and it can see the table. Otherwise the probe runs as one query, as
  before.
- `interruptCurrentQuery()` interrupts the side connections too. They are closed in a
  `finally`.
- 2,950 → 1,290 ms. With 4 groups it was 1,350.
- Test (`xlsxErrorMarkers.test.ts`): 30 columns of every kind the check decides between,
  over 3,000 rows. Split and single give identical tables, types, rows and notices, for
  xlsx and CSV, restricted and not.

**C6: in-memory decision cache** (`TextDecision`, `reusableDecision`, `textDecisionsOf`
in `src/duckdbConnection.ts`; `src/viewerFile.ts`; `src/queryProtocol.ts`;
`src/queryWorkerEntry.ts`)
- The check records, per table: which columns became which type and locale, which were
  blanked, and the resulting notices. It records no cell values.
- Each decision is keyed on the table's label, its read SQL (`viewBodySql`: path and
  range), its column names and type ids, and the marker tokens.
- The worker reports decisions in its reply metadata, tagged with the SHA-256 its
  preflight computed (xlsx only).
- `ViewerFile` keeps them in a field, merging for the same hash and replacing for a new
  one. It passes them to the next reader it starts.
- The reader uses them only when the hash equals its own `openedSha256`. Each decision is
  used only when every key field matches and every column is a distinct text column of
  the table, with `locale ∈ {en, eu}` and `target ∈ {bigint, hugeint, double}`.
- The projection is then rebuilt with the same SQL builders.
- Cleared in `ViewerFile.dispose()`. Nothing is written to disk.
- Tests (`xlsxErrorMarkers.test.ts`):
  - A reuse gives exactly the cold result and runs no `using sample reservoir` query.
  - Seven bad caches are each ignored and give the cold result: other bytes, an injected
    target, an unknown column, a reordered shape, other tokens, a duplicate column, and a
    non-object.
  - Through `ViewerFile`, a restart gives the same rows, and `dispose()` empties the cache.

**C7: grid hand-off as JSON** (`readGrid` in `src/duckdbConnection.ts`)
- Table detection needs the whole verbatim sheet in JS: 16,814 × 101 cells.
- `getRows()`, `getColumns()`, `getRowsJS()` and per-vector reads all cost about 550 ms.
  The time goes into creating the strings one DuckDB value at a time.
- When every column is VARCHAR, which the verbatim read always produces, each row is now
  fetched as `to_json([...])` and `JSON.parse`d: 575 → 105 ms.
- Identical on the real grid and on hostile strings: quotes, backslash, NUL, newline,
  U+2028, emoji, empty and space.
- Any non-text column takes the old path.
- Row order relies on insertion-order scans, as the old `select *` did.

**C8: CSV cached before the text-column check** (`DuckDbFile.open`)
- Part B's E5 cached a worker's CSV (≤ 128 MB) as a table after the check. Moving it
  before the check means the check's column scan, sample and probe read memory, and its
  projection is an in-memory copy. They no longer re-sniff and re-parse the file
  (86 → 3 ms).
- CSV open: 370 → 290 ms (profile 403 → 327).
- The one assumption: a `repeatable` reservoir sample of the table equals that of the file
  view.
  - Checked: identical on `wide.csv` and `pandas.csv` at 2 and 5 threads.
  - The file-view sample itself is stable across 12 runs at 1, 2, 5 and 10 threads.
    DuckDB draws a repeatable sample single-threaded, in row order.
- The in-process (writer) path is unchanged.

### Candidates dropped, with evidence

- **Extension `install` only when `load` fails:** `install` of an already-installed
  extension takes under 0.5 ms (`load` is 5–14 ms). Nothing to gain.
- **Batched SQLite `create view`:** one multi-statement run took 60 ms against 67 ms for
  the loop, of a 140 ms open (5%). The cost is DuckDB binding each view against the SQLite
  file, not round trips.
- **Normalising the error-marker token list once per call site:** no measurable gain. The
  profile showed the cost is upper-casing each cell's own text. Reverted.
- **Rust Excel reader (calamine-node 0.2.0, napi-rs), measured in a scratch folder only:**
  - It read `Raw_Data` in about 450 ms, against 742 ms for DuckDB's read and pull.
  - It is **not identical**: it returns parsed doubles (`3.8067`) and tagged date objects,
    where the viewer shows the file's literal cell text (`3.8067000000000002`). That
    changes 1,037,004 of 1,698,214 cells.
  - The literal text cannot be recovered in general, because writers format numbers
    differently.
  - Costs: a 2.7 MB native binary per platform, and a single-maintainer v0.2.0 package.
  - Nothing was added to the repository.
- **More DuckDB threads for `read_xlsx`:** no change at 4 threads. A single sheet part is
  parsed serially.
- **Feather conversion (report only):** on a 1M-row, 83 MB uncompressed Feather file, the
  open takes 122–147 ms, against 68–79 ms for the same data as an Arrow stream. The
  existing converter already streams batch by batch. Nothing changed.

### Scrutinize (Part C)

1. **Spare lifecycle.**
   - The spare's environment is a snapshot taken when it was forked, filtered exactly like
     a fresh fork.
   - Check that no path can hand a spare to a second owner: `claimSpare` clears the slot
     before anything else. Also check that `replenish` cannot run after the last disposal:
     `live` is checked inside the `setImmediate`.
   - An unref'd child on Windows is unexecuted here.
2. **More CPU per reader.**
   - Half the cores for DuckDB, plus up to that many side queries, each on its own libuv
     thread, during a check.
   - A runaway user query is still stopped only by the 30 s deadline, and now loads up to
     half the machine.
   - The DOS suite passes (the cartesian query is stopped by memory in 88 ms; the CPU and
     recursive queries by the deadline in about 2.5 s; no orphan).
3. **Side connections.**
   - They are opened after `lock_configuration`, so they inherit it; confirm no setting is
     per-connection in a way that matters.
   - They run only the generated probe SQL, never user SQL, so `ReadSqlPolicy` is not
     involved.
4. **Decision-cache keying.**
   - The key includes the SHA-256 of the bytes the preflight hashed.
   - Part B's residual race (DuckDB reads the workbook later than the hash) applies to
     reuse as it does to reads.
   - The notices are replayed verbatim from the earlier reader of the same bytes.
5. **C4, malformed XML.**
   - A `<dimension>` tag with two `ref` attributes (not well-formed XML) could resolve
     differently on the two paths. The streaming path's own answer there depends on
     fflate's chunk boundaries.
   - The fast path reads the whole package (≤ 128 MB) into memory briefly. On the host,
     this happens only when a trusted writer opens a workbook.
6. **C7** relies on DuckDB's `to_json` being exact for every VARCHAR (it must be valid
   UTF-8 to exist), and on `JSON.parse` giving back the same string.
7. **C8** relies on the table sample equalling the file sample (see C8). A future DuckDB
   that samples a table in parallel would break it. The equivalence corpus has two CSVs
   that would catch that.
