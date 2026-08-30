# Data File Viewer

A VS Code extension that opens `.duckdb`, `.parquet`, `.csv`, `.dta` (Stata),
`.arrow`/`.arrows`/`.feather` (Arrow IPC), `.xlsx` (Excel), `.db`/`.sqlite` (SQLite), and kdb+ table files
with a table list ("sheets") in the sidebar,
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
| `.arrow` / `.arrows` | Yes |
| `.xlsx` | Yes |
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
machine (cached locally after that). Opening a `.dta` or `.arrow`/`.arrows`
file has the same one-time internet-on-first-use requirement, for DuckDB's
`dta` and `arrow` community extensions respectively — as does an `.xlsx` file,
for DuckDB's `excel` extension.

### `.arrow`, `.arrows` and `.feather`

Arrow IPC comes in two encodings that share a name and don't share a format.
Both open here, by different routes.

The **stream** encoding is read directly, through DuckDB's `arrow` extension —
what `COPY … TO … (FORMAT arrow)`, `polars.DataFrame.write_ipc_stream()` and
pyarrow's `RecordBatchStreamWriter` produce. This is the cheaper path: DuckDB
streams it off disk and never holds the table in memory.

The **file** encoding — Feather V2, the one starting with the `ARROW1` magic,
produced by `pyarrow.feather.write_feather()`, `polars.DataFrame.write_ipc()`
and `pandas.DataFrame.to_feather()` — DuckDB cannot read at all. There is no
`read_feather`, and `read_arrow()` fails on it whether or not it is compressed.
So the viewer converts it to a stream first, using the `apache-arrow` library,
and opens the conversion. Two consequences worth knowing:

- **The whole table goes through memory**, unlike every other format here.
  Fine for a search-result export; not what you want for something enormous.
- **`.feather` files are view-only.** Writing an edit back would mean
  re-encoding the other way, and `COPY … (FORMAT arrow)` would silently put a
  *stream* inside a file named `.feather`.

Which encoding a file actually is comes from its first six bytes, not its
name — both turn up under both extensions in the wild, and guessing wrong is
not a clean failure: a Feather file ends with its own `ARROW1` footer rather
than the stream's end-of-stream marker, so the truncation check below would
call it damaged.

Two things are handled during the conversion because they otherwise bite:

**Utf8View.** polars writes strings as Arrow `Utf8View` by default, and
`read_arrow()` rejects that type outright — "Unrecognized Field type with value
24", 24 being `Utf8View` exactly. Converting the container is not enough, so
string columns are brought down to plain `Utf8` on the way through. (On the
write side, `compat_level=pl.CompatLevel.oldest()` is the same fix from the
other direction, and is still worth passing.)

**Compression.** `apache-arrow` ships no IPC codecs, so a *compressed* Feather
file cannot be converted and is refused by name:

> `"data.feather"` is a COMPRESSED Feather file, which cannot be opened. The
> converter this viewer uses to read Feather has no decompression codecs.
> Re-write it uncompressed (`polars write_ipc(path, compression=None)`,
> `pyarrow write_feather(df, path, compression="uncompressed")`), or write an
> Arrow IPC stream instead — a zstd-compressed `.arrows` stream opens here
> without any conversion.

That last clause is not a consolation prize: `read_arrow()` genuinely does read
zstd-compressed *streams*. The limitation is the converter's, not DuckDB's.

A truncated `.arrows` file is refused rather than opened. It has to be checked
explicitly, because `read_arrow()` does not notice: an Arrow stream is a schema
followed by record batches, and a file that simply stops looks the same to it
as one that ended. A 50-row stream cut to 90%, 50% or 25% comes back as **zero
rows and no error** — the schema survives, so you get the right column headers
over an empty grid, which reads as "the export produced nothing" rather than
"this file is damaged". The viewer therefore checks for the 8-byte
end-of-stream marker before reading. A table that genuinely has no rows still
carries that marker, so an empty dataset opens normally.

`.parquet`/`.csv`/`.dta`/`.arrow` files aren't databases with multiple tables, so
they're exposed as a single view named after the file — the sidebar will
show just that one entry, and clicking it previews the file's data like any
other table.

### Excel workbooks

`.xlsx` is the one flat format here that *is* multi-table, so it gets the
`.duckdb` treatment instead: **one view per sheet**, named after the sheet and
listed in the sidebar in the order the workbook declares them. Click a sheet to
preview it, or join across sheets in the query box like any other tables.

Sheet names are read out of the workbook package directly (`xl/workbook.xml`
plus its `.rels`), because DuckDB's `read_xlsx()` addresses a sheet by name but
offers no way to ask which names exist. A sheet that can't be read — a chart
sheet, a macro sheet, an empty one — is skipped rather than failing the whole
workbook; the file only errors if *none* of its sheets can be read.

**Workbooks are view-only.** DuckDB can write an `.xlsx`, but a workbook is many
sheets and that writes a file containing one — saving an edit to a single sheet
would silently destroy every other sheet in the book. (Excel also has no integer
type, so a round trip turns `1` into `1.0` throughout.) Rather than do either
quietly behind a double-click, cell editing is simply not offered for `.xlsx`,
the same as for kdb+ tables.

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

### Opening a file

The first table is previewed as soon as a file opens — the sidebar's top entry
is selected and `SELECT * FROM "<table>" LIMIT 100` runs against it, exactly as
if you had clicked it. For the single-table formats there is only ever one
entry, so that click was the last thing standing between opening a file and
seeing it; for a `.duckdb` or `.xlsx` the first entry is whatever the writer put
first, which is normally the data rather than a metadata table.

Turn it off with `dataFileViewer.previewFirstTableOnOpen` (in Settings) if
opening a very large file should stay instant — a preview is a query, and on a
big enough table that is a wait rather than a blink.

### Sorting, stats, and cell editing

Every results grid — table previews and hand-written queries alike — gets:

- **Sort**: click a column header's sort button to sort by that column,
  ascending; click it again to reverse to descending, and so on. If the
  underlying query has a `LIMIT`, sorting always re-sorts the *full*
  matching data set on the server first, not just whatever rows happened to
  already be on screen — so "top 10 by X" is always the true top 10, not an
  arbitrary 10 rows re-ordered.

  Sorting follows the column's actual type rather than the text on screen.
  That matters more than it sounds: DuckDB hands large integers, decimals
  and timestamps to the view as text, so sorting them as text would put `9`
  after `10` and `2024-03` next to `2023-12` only by luck. Numbers sort as
  numbers (exactly, even past the range a JavaScript number can hold
  precisely), dates and timestamps sort chronologically, and empty (`NULL`)
  values always collect at the end regardless of direction. Text sorts by
  the alphabet rather than by internal character codes — so `apple` comes
  before `Zebra`, Turkish letters like `ç`, `ı`, `ö`, `ş` and `ü` sort where
  you'd expect rather than after `z`, and names such as `item9`/`item10`
  come out in counting order.
- **Column stats**: a button in each header computes, on demand and across
  the *entire* column (not just the visible rows): for numeric/date columns,
  the minimum, maximum, average, and 5th/95th percentiles; for everything
  else, null count, distinct count, and the 20 most frequent values.

  The average and the two percentiles are shown to at most four decimal
  places. The minimum and maximum are not rounded: those two are values that
  are actually in the data, while the other three are computed (and the
  percentiles are approximate to begin with — the label says so).
- **Plot**: a 📈 button appears in the header of every numeric column that
  the result has an x axis for, and clicking it opens that column as a line
  chart in its own VS Code tab beside the grid. Plotting a second column
  redraws the same tab rather than opening another one.

  The chart is always of the **whole** series. A preview runs `LIMIT 100`,
  and charting those hundred rows of a longer series would draw a line that
  stops early and looks exactly like a series that ends early — so the
  trailing `LIMIT` is stripped for the chart. Past
  `dataFileViewer.chartMaxPoints` (200,000 by default) it refuses and tells
  you the real count instead of drawing a prefix.

  Which column becomes the x axis, in order:

  1. the first `DATE`/`TIMESTAMP` column;
  2. otherwise a text column *named* `Date` or `Datetime` — this is what
     makes ETL output chartable, since ETL stores dates as `VARCHAR` ISO
     text in every one of its output formats. If those strings parse as
     timestamps they become a real time axis; if they do not (period labels
     like `1996-1Q`) they become a **category** axis, drawn with the labels
     exactly as stored and the rows in the table's own order — no sorting,
     because sorting `1996-1Q` strings would produce an order that merely
     looks chronological.

  A result with neither gets no plot buttons at all. That is deliberate:
  plotting numbers against arbitrary text draws the order the table happens
  to hold its rows in, dressed up as a chart. It is also why `sheet_metadata`
  — text columns and a count — offers nothing to plot.
- **NULL values** are shown dimmed and in italics in the results grid, so
  they're easy to tell apart from a real value like an empty string or a
  literal `0`.
- **Cell inspector**: double-click any cell to view its full value (JSON
  syntax-highlighted when the value is an object/array or JSON-looking
  text). If the result is a plain `SELECT * FROM one_table` (no joins,
  aggregates, or computed columns), the format supports editing, *and*
  Safe Mode is off, the same panel lets you edit and save the cell back to
  the source file/table. `.csv`/`.parquet`/`.dta`/`.arrow` are lazily converted from a
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
- **How a tick works.** Each tick watches the folder holding the file, so it
  notices changes to the file itself and to the WAL/SHM sidecar files where
  the actual writes land under WAL mode — including sidecars that don't
  exist yet when Live starts, and files a writer replaces wholesale rather
  than editing in place. A tick only does real work once something has
  actually changed on disk. When it has, the connection is refreshed as
  cheaply as that format allows — a `.duckdb` file needs a fresh connection
  to observe another process's commits, a `.sqlite` file only needs
  reattaching, and `.csv`/`.parquet`/`.dta`/`.arrow` re-read themselves on every
  query anyway — then the last query is rerun and the result reposted only
  if it actually differs from what's on screen (so a poll that produced no
  new rows doesn't cause a visible flicker).
- **When something goes wrong.** A status line next to the toggle shows how
  long ago the last update landed, and switches to "stale" while ticks are
  failing — hover it to see the underlying error. Live is never turned off
  for you: it keeps retrying, backing off further after each consecutive
  failure, and clears the stale state itself once a tick succeeds. A tick
  that hangs outright (typically waiting on a lock the writing process is
  holding) is given up on after a timeout rather than being waited on
  forever, so a single stuck query can't quietly end live updates for the
  rest of the session. If updates stop arriving for any reason at all, the
  view marks itself stale on its own rather than showing an old grid as if
  it were current.
- **Ticks yield to you.** If a tick comes due while one of your own queries,
  sorts, or column-stat lookups is still running, it steps aside and waits
  for the next one instead of competing for the same connection.
- Turning Live back off reconnects normally (read-write), so editing works
  again immediately — unless the writing process still holds the write lock,
  in which case the file stays open read-only and the status line says so,
  rather than leaving editing mysteriously disabled.

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

### How many rows are there really?

The footer reads `146 of 146 rows shown` — how many you can see, and how many
your query matches in total. Both numbers are given even when they agree,
because that is the case where the count on its own is ambiguous: write
`limit 200` against a 146-row table and you get 146 back, which looks
identical to a table holding a million rows whose limit cut it at 146.

The total ignores your trailing `LIMIT` but respects your `WHERE` — it answers
"how many rows does my query match", not "how many rows are in the file", so
filtering down to 20 rows reports 20. A `LIMIT` nested inside a subquery is
part of what the query means and is left alone.

It is computed after the rows are already on screen, so a limited query against
a huge table still appears instantly and the total fills in behind it. During
live refresh the total is dropped rather than carried, since the data it
described has just changed.

### Large results

By default every matching row is sent to the view. If very large results feel
slow, set `dataFileViewer.maxResultRows` (in Settings) to a row count and the
viewer stops reading past it, noting in the footer that the result was capped.
Sorting still happens across the full result before the cap applies, so what
you see is the true top N by that column rather than an arbitrary N re-ordered.

## Local development

```sh
npm install
npm run build       # one-off build (esbuild -> dist/extension.js, dist/webview.js)
npm run watch       # rebuild on file changes
npm run typecheck   # tsc --noEmit
npm test            # node --test
```

`npm test` covers the parts that are hard to check by hand: the live-refresh
scheduler (driven by a fake clock, so a 30-second backoff is tested in
milliseconds), row ordering — asserted to agree with what DuckDB itself
produces for the same column, which is what keeps sorting consistent between
the client-side and server-side paths — and the read-only/Safe Mode SQL
scanner. It uses Node's built-in test runner, so there's no test framework to
install; it does need Node 22 or newer, which is only a requirement for
running the tests, not for building or using the extension.

Both run in CI on every push, and a failing suite blocks the `latest` release
below from being published.

Press `F5` in VS Code (with this folder open) to launch an Extension Development
Host, then open any `.duckdb`/`.parquet`/`.csv`/`.dta`/`.arrow`/`.xlsx`/`.db`/`.sqlite`/kdb+ file in
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

- **macOS**: right-click a `.duckdb`/`.parquet`/`.csv`/`.dta`/`.arrow`/`.xlsx`/`.sqlite` file →
  Get Info → "Open with" → select Visual Studio Code → "Change All…".
- **Windows**: right-click a `.duckdb`/`.parquet`/`.csv`/`.dta`/`.arrow`/`.xlsx`/`.sqlite` file →
  "Open with" → "Choose another app" → Visual Studio Code → check "Always
  use this app to open this file type".

Once set, double-clicking any of those file types anywhere launches VS Code
directly into this custom editor. `.db` files are opened manually via
right-click as described above — no OS file-association step needed (or
wanted) for those, since `.db` is intentionally not a default association.
kdb+ table files have no extension for the OS to associate by — see the
kdb+ section above for the per-file equivalent.
