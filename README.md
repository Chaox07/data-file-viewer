# Data File Viewer

A VS Code extension that opens `.duckdb`, `.parquet`, `.csv`, `.dta` (Stata),
`.db`/`.sqlite` (SQLite), and kdb+ table files with a table list ("sheets") in the sidebar,
an editable SQL query box, and a results grid — modeled on
[caioricciuti/vs-duckdb-viewer](https://github.com/caioricciuti/vs-duckdb-viewer).
DuckDB is the engine reading most of these formats under the hood; kdb+
files are parsed directly in their own real format (see the kdb+ section
below).

## Opening files

| Format | Opens automatically on double-click? |
| --- | --- |
| `.duckdb` | Yes |
| `.parquet` | Yes |
| `.csv` | Yes |
| `.dta` | Yes |
| `.sqlite` | Yes |
| `.db` | **No** — see below |
| kdb+ table files (inside a `..._kdb/` folder) | Yes, inside VS Code — see below |

`.db` is deliberately **not** automatic: it's a generic extension used by
many unrelated file formats, so claiming it by default would risk hijacking
files that have nothing to do with this extension. To open one, right-click
it → "Open With..." → "Data File Viewer (SQLite)", or use the Command
Palette's "Reopen Editor With..." on an already-open one. Opening a
`.db`/`.sqlite` file also requires DuckDB to load its `sqlite` extension,
which needs an internet connection the *first* time it's used on a given
machine (cached locally after that). Opening a `.dta` file has the same
one-time internet-on-first-use requirement, for DuckDB's `dta` community
extension.

`.parquet`/`.csv`/`.dta` files aren't databases with multiple tables, so
they're exposed as a single view named after the file — the sidebar will
show just that one entry, and clicking it previews the file's data like any
other table.

### kdb+ tables

If you export data as kdb+ (a fast, compact on-disk table format used by
kdb+/q), this extension reads the real file directly — there's no
conversion step, and the on-disk file is never modified. Point it at one of
the individual table files a kdb+ export produces (for example `Raw_Data`
or `used_YieldCurve` inside a folder like `MyData_kdb/`); double-clicking one
of these files anywhere inside VS Code opens it straight into the viewer,
the same as the other formats above. You can also right-click such a file
and choose "Open in Data File Viewer" explicitly.

Two things are different for kdb+ compared to every other format here:

- **View-only.** You can browse, sort, run SQL queries, and check column
  stats, but you can't edit cells or save changes — there's no way yet to
  write a change back into kdb+'s own file format.
- **Double-clicking from Finder/Explorer** (as opposed to double-clicking
  inside VS Code's own sidebar) still requires a one-time step, because kdb+
  table files have no file extension for the operating system to recognize.
  On macOS: right-click the file in Finder → Get Info → "Open with:" →
  choose Visual Studio Code. Since there's no extension to generalize the
  association from, this has to be done per file (or redone whenever the
  export is regenerated) — dragging the file onto VS Code's Dock icon works
  just as well and needs no setup at all.

### Sorting, stats, and cell editing

Every results grid — table previews and hand-written queries alike — gets:

- **Sort**: click a column header's sort button to sort by that column,
  ascending; click it again to reverse to descending, and so on. If the
  underlying query has a `LIMIT`, sorting always re-sorts the *full*
  matching data set on the server first, not just whatever rows happened to
  already be on screen — so "top 10 by X" is always the true top 10, not an
  arbitrary 10 rows re-ordered.
- **Column stats**: a button in each header computes, on demand and across
  the *entire* column (not just the visible rows): for numeric/date columns,
  the minimum, maximum, average, and 5th/95th percentiles; for everything
  else, null count, distinct count, and the 20 most frequent values.
- **NULL values** are shown dimmed and in italics in the results grid, so
  they're easy to tell apart from a real value like an empty string or a
  literal `0`.
- **Cell inspector**: double-click any cell to view its full value (JSON
  syntax-highlighted when the value is an object/array or JSON-looking
  text). If the result is a plain `SELECT * FROM one_table` (no joins,
  aggregates, or computed columns), the format supports editing, *and*
  Safe Mode is off, the same panel lets you edit and save the cell back to
  the source file/table. `.csv`/`.parquet`/`.dta` are lazily converted from a
  read-only view into a real editable table the first time you actually
  edit a cell in that session — pure browsing stays as fast as before, and
  the panel shows a short status message ("Preparing file for editing…",
  "Saving…") while that happens. Edits match rows by comparing every
  column's value (there's no universal row-id across table kinds), so a
  table with fully duplicate rows will update all of them together.

### Live mode: watching a file another process is still writing

For files being actively written by an external process — most notably the
hot/cold pattern used by `web_table_scraper.py` and `alpaca_extractor.py`
(a small `*_hot.sqlite` file overwritten on every poll, paired with a
`*.duckdb` file that accumulates the finalized/closed rows) — this extension
can keep the results grid updating on its own instead of requiring a manual
re-run of the query.

- **Combined hot+cold view.** Opening either half of such a pair (a
  `<name>.duckdb` next to a `<name>.sqlite`/`<name>_hot.sqlite`, or vice
  versa) auto-attaches the other file and adds a `<table>_combined` entry to
  the sidebar. Clicking it runs a synthesized, read-only query that unions
  the cold (finalized) rows with the hot (still-forming) rows — tagging each
  with an `is_hot` column — ordered by whatever time column it can detect,
  most-recent rows last. No hand-written SQL needed to see both halves as
  one continuous table.
- **Static / Live toggle.** The toolbar above the results grid has a
  Static/Live switch. Live only works against a read-only query (a `SELECT`
  or `WITH` — including the auto-generated combined query above); trying to
  turn it on against anything else is rejected with an explanation instead
  of silently doing nothing. Turning Live on also locks out cell editing
  until it's turned back off, since it keeps the document's connection
  read-only so it can safely reconnect on every tick.
- **Refresh interval.** Editable next to the toggle, in seconds (quarter-second
  steps, minimum 0.25s). If the table being viewed has a `sheet_metadata`
  row with a `live_poll_seconds` hint in its `extra_json` — which
  `alpaca_extractor.py` publishes automatically, set to its own
  `LIVE_POLL_SECONDS` — that value is used to pre-fill the interval instead
  of the extension's own default (`dataFileViewer.liveRefreshIntervalMs` in
  Settings, default 2000ms), so the viewer polls at the same cadence as the
  process writing the file. You can still override it by hand.
- **How a tick works.** Each tick watches the file plus its WAL/SHM sidecar
  files (where the actual writes land under WAL mode) and only does
  anything once those change on disk. When they do, it opens a fresh
  read-only connection — DuckDB's own connection doesn't observe another
  process's commits otherwise — reruns the last query, and reposts the
  result only if it actually differs from what's already on screen (so a
  poll that produced no new rows doesn't cause a visible flicker). A status
  line next to the toggle shows how long ago the last update landed, and
  switches to "stale" after three consecutive failed ticks (file locked,
  temporarily missing mid-write, etc.) without turning Live off — it keeps
  retrying with backoff and clears the stale state itself once a tick
  succeeds again.
- Turning Live back off reconnects normally (read-write), so editing works
  again immediately.

### Safe Mode and backups

Safe Mode is on by default. Turning it off makes a timestamped backup copy
of the file before letting you edit anything, and — the next time you
re-enable Safe Mode — compares the live data against that backup so you can
see which tables changed. After running a query, matching rows/cells
changed since the backup are highlighted directly in the results grid, too;
above a configurable row count (`dataFileViewer.diffRowThreshold` in
Settings, default 50,000) this automatic highlighting is skipped for
performance and replaced with a manual "Diff anyway" button.

While Safe Mode is on, a query is only allowed to run if the whole thing is
read-only — not just its first word. That means `select 1; drop table x` is
blocked for containing a second statement, and `with x as (…) delete from t`
is blocked for the `delete`, even though both open with a safe keyword.
Comments, text values and quoted column names are ignored when deciding, so
an ordinary query over a column containing `;` or the word `update` still
runs.

### Large results

By default every matching row is sent to the view. If very large results feel
slow, set `dataFileViewer.maxResultRows` (in Settings) to a row count and the
viewer stops reading past it, noting in the footer that the result was capped.
Sorting still happens across the full result before the cap applies, so what
you see is the true top N by that column rather than an arbitrary N re-ordered.

## Local development

```sh
npm install
npm run build      # one-off build (esbuild -> dist/extension.js, dist/webview.js)
npm run watch       # rebuild on file changes
```

Press `F5` in VS Code (with this folder open) to launch an Extension Development
Host, then open any `.duckdb`/`.parquet`/`.csv`/`.dta`/`.db`/`.sqlite`/kdb+ file in
that window.

## Packaging

```sh
npm run package     # builds, then runs vsce package -> data-file-viewer-x.x.x.vsix
code --install-extension data-file-viewer-0.0.1.vsix
```

`@duckdb/node-api` ships platform-specific native binaries resolved at
`npm install` time. **A `.vsix` built on one OS will not work on another** —
do not copy it across machines. Build separately per platform, or use the
GitHub Actions workflow below to get both automatically.

## CI (GitHub Actions)

`.github/workflows/build.yml` builds a macOS and a Windows `.vsix` on every
push, using GitHub-hosted runners — no local Node/npm/vsce needed on a machine
that only needs to *install* the extension.

Every push to `main` also publishes both `.vsix` files to a rolling
[**`latest` release**](https://github.com/Chaox07/data-file-viewer/releases/tag/latest)
— one permanent URL that's always overwritten with the newest build, so you
don't have to dig through the Actions tab or worry about the 90-day artifact
expiry below. Download the platform-tagged `.vsix` (`...-macos-latest.vsix` /
`...-windows-latest.vsix`) for your machine, then:

```sh
code --install-extension <downloaded-file>.vsix
```

If you need a specific run's build instead of always-latest: open the repo's
**Actions** tab, pick that run, and download its `vsix-macos-latest` /
`vsix-windows-latest` artifact. Unlike the `latest` release above, these
per-run artifacts expire after 90 days by default.

## Making files open in VS Code on double-click from Finder/Explorer

This section is about the operating system's own file association — a
separate, one-time setting per machine, independent of anything this
extension can configure on its own:

- **macOS**: right-click a `.duckdb`/`.parquet`/`.csv`/`.dta`/`.sqlite` file →
  Get Info → "Open with" → select Visual Studio Code → "Change All…".
- **Windows**: right-click a `.duckdb`/`.parquet`/`.csv`/`.dta`/`.sqlite` file →
  "Open with" → "Choose another app" → Visual Studio Code → check "Always
  use this app to open this file type".

Once set, double-clicking any of those file types anywhere launches VS Code
directly into this custom editor. `.db` files are opened manually via
right-click as described above — no OS file-association step needed (or
wanted) for those, since `.db` is intentionally not a default association.
kdb+ table files have no extension for the OS to associate by — see the
kdb+ section above for the per-file equivalent.
