# Data File Viewer

A VS Code extension that opens `.duckdb`, `.parquet`, `.csv`, `.dta` (Stata),
`.arrow`/`.arrows`/`.feather` (Arrow IPC), `.xlsx` (Excel), `.db`/`.sqlite` (SQLite), and kdb+ table files
with a table list ("sheets") in the sidebar,
an editable SQL query box, and a results grid — modeled on
[caioricciuti/vs-duckdb-viewer](https://github.com/caioricciuti/vs-duckdb-viewer).
DuckDB is the engine reading most of these formats under the hood; kdb+
files are parsed directly in their own real format (see the kdb+ section
below).

### 0.0.19: Worksheet preview button removed

Query table lists only the open sheet, so the button only reloaded the sheet
already on screen. To return to a sheet after a SQL result, click it in the
sidebar.

The 0.0.19 regression review also hardens workbook archive validation, stale
workbook edit detection, query queue accounting and CSV startup resource limits.
Windows fixes release capped-query file locks and avoid reinstalling loaded
DuckDB extensions during concurrent opens.
See [0.0.19 review results](docs/review-0.0.19.md) for checks and remaining limitations.

### 0.0.18: Query table follows the open sheet

Query table now lists only the worksheet that is open: its whole sheet under
"Worksheet" and its detected tables under "Tables". Choosing the whole sheet
outlines its used range, from the first used cell to the last. Every other
column is shaded, like the rows, so wide grids are easier to read across.

### 0.0.17: Excel-style worksheet grid

A worksheet preview now numbers its rows 1, 2, 3… down the left and centres the
column letters across the top, as Excel does, so a range such as `B4:D9` can be
found by eye. Choosing a table in Query table outlines it in yellow on the
worksheet shown; nothing scrolls or re-runs. The column-type line under Query
table is gone; SQL autocompletion still knows the types.

### 0.0.16: faster opening

A large workbook's data table now appears in about 3 s instead of about 5.4 s
on a 21 MB file: the check that reads number columns holding Excel error
markers runs on several cores at once, and the sheet reaches table detection
faster. The query reader now uses half of the machine's cores, worked out
automatically. A second file opens in 10–20 ms while another is open, because a
reader process is kept ready. Refreshing, cancelling or making a backup no
longer repeats that check on an unchanged workbook: its decisions are kept in
memory until the tab closes, never on disk. CSV files open about 20% faster.
Results are unchanged.

### 0.0.15: faster edits and opens

Editing one cell of a large workbook no longer re-derives the table in a
second process or re-compresses the whole file: on a 21 MB workbook the edit
went from about 10 s to about 1.3 s. Workbooks open faster (the safety scan
uses native zlib), CSV queries, sorts and statistics read an in-memory copy
instead of re-parsing the file, and SQLite files with many tables open about
four times faster. Results are unchanged; after an edit, a reading notice is no
longer shown twice.

### 0.0.14: choose SQL tables, restricted queries

A **Query table** selector lists the document's tables with their SQL types,
and a detected Excel table can hand its current filters to the SQL editor.
Queries now run in a separate, restricted reader process: SQL cannot read
other files, reach the network, change settings or write, and a runaway query
is stopped by a deadline. Type errors such as `"Date" >= 1990` on a date
column now explain the fix. See *SQL table selection* below.

### 0.0.13: crosshair in dense charts

Dense charts now show a crosshair for estimating positions against the axes,
without a data popup or floating value labels. Zooming in still enables the
point markers and exact hover values introduced in 0.0.12.

### 0.0.12: inspect points after zooming

Zooming to at most 3,000 visible, non-null points reveals line markers and
hover values. The count follows the actual observations and visible series,
including irregular dates and category axes. Tooltips retain all digits of
the plotted number and include the timestamp in UTC. Drag zoom, wheel zoom,
reset and line/scatter switching keep the detail state consistent.

### 0.0.11: restore table preview controls

Automatic and sidebar previews of DuckDB and other non-Excel tables again
show sorting, statistics and eligible plot buttons. Only actual Excel
worksheets use worksheet header controls, including when table detection is off.


### SQLite columns without declared types

The viewer reads untyped text, integer and real columns using their stored value
classes. Real numbers retain their binary floating-point value. A column mixing
real numbers with integers outside the safe double range is shown as exact text,
with a notice, so the integers are not rounded. These numeric untyped columns
remain read-only; editing them would change their storage class.

Live refresh rechecks untyped columns after file changes, including changes to
stored classes without a schema change. Cell edits are refused when a user
column named `rowid` hides SQLite's internal row identifier, or when the table
has no usable row identifier. Every successful edit must update exactly one row;
an unexpected count rolls back the write.

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
and opens the conversion.

**The conversion is a record batch at a time**, in both directions. The file
encoding puts its footer at the end and is therefore random-access, which is
exactly what `apache-arrow`'s `AsyncRecordBatchFileReader` wants: handed a file
handle it seeks to the footer, reads the batch index, and yields batches on
demand, each one re-encoded and written straight out. Peak memory is one batch
rather than the whole dataset — measured at 59 MB on a 12 MB / 400,000-row
polars file that previously had to hold the decoded table, its re-encoded copy
and the file's own buffer at once.

**`.feather` files are editable.** Saving goes the other way through the same
machinery: DuckDB writes an Arrow *stream* to a temp file, that stream is
re-encoded batch-by-batch into the *file* encoding, and the result is moved into
place. The two-step matters — writing `COPY … (FORMAT arrow)` straight into the
path would put stream bytes inside a file named `.feather`. This viewer would
reopen it (it sniffs magic bytes, not the extension) and `pyarrow` and `pandas`
would both refuse it.

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

A worksheet is a page, not a table: a title, maybe a legend, one or more tables,
and footnotes under them. So a workbook gives you **two kinds of object**.

**The sheet itself, exactly as the file holds it.** Every declared row and
column, read from A1, all values as text, columns named after their Excel
letters. Grid row 7 *is* row 7 of the spreadsheet. Nothing is promoted to a
header, nothing above or below a table is excluded, and a footnote stays under
the table it annotates. If you want to know what is in the file, this answers
that question and no other.

**The tables found inside it**, in their original worksheet cells. Their
promoted header cells gain independent sort, text-filter, statistics and plot
controls; operating on one table never moves or filters its neighbour. The
sidebar therefore stays a list of real sheets rather than duplicating every
detected rectangle as another entry. Detected tables are typed — numbers are
numbers — and remain addressable by SQL as `Sheet · Table 1`, `Sheet · Table 2`.
A sheet is cut on blank rows *and* blank columns, so two tables sitting side by
side are two tables rather than one wide one whose header belongs to neither.
Titles, captions and footnotes remain on the untouched sheet. The classification
is ported from the ETL pipeline function by function. `dataFileViewer.sheetTables`
turns the column split off (`rows`), or detection off entirely (`off`).

Sheet names are read out of the workbook package directly (`xl/workbook.xml`
plus its `.rels`), because DuckDB's `read_xlsx()` addresses a sheet by name but
offers no way to ask which names exist. A sheet that can't be read — a chart
sheet, a macro sheet, an empty one — is skipped rather than failing the whole
workbook; the file only errors if *none* of its sheets can be read.

**Opening is fast because opening does no sheet reading.** Binding a view over a
sheet costs about 3 ms; reading one costs 240–640 ms. So every sheet gets its view
when the workbook opens, and materialising it plus finding its tables waits until
you actually click that sheet. Detected tables are then bound without another
read and materialise only when first used: even a tiny range costs a full
workbook parse, so eagerly loading every detected table made the raw-sheet
preview scale with the number of tables. A ten-sheet workbook here opens in 26
ms and a 21 MB two-sheet one in about 152 ms. On that 21 MB workbook, the first
raw-sheet preview fell from about 1.02 s to 0.44 s while repeated previews remain
about 5 ms. Their controls appear on the detected header cells the moment the
sheet is opened.

**Cells Excel could not compute** — `#DIV/0!`, `#N/A`, `#REF!`, `#VALUE!` — used
to cost you the whole sheet. `read_xlsx()` types a column from its values and
then refuses the lot over one of them: *"Failed to parse cell 'E122': Could not
convert string '#DIV/0!' to DOUBLE"*, and a 121-row sheet would not open. The
sheet is read as text, so it always opens; in the tables read out of it, such a
cell is read as empty and the column keeps its real type — which is what the
value means: Excel saying it has no number there. The sheet is named in a warning,
since a cell quietly becoming blank is worth saying out loud.

**Workbooks are editable, one cell at a time.** Nothing is regenerated. DuckDB
*can* write an `.xlsx`, and saving through it was never an option: it writes a
file containing one sheet, so an edit would have destroyed every other sheet in
the book, along with the edited sheet's formulas and number formats — and Excel
having no integer type, `1` would have come back as `1.0` throughout.

Instead the workbook is unzipped, the single `<c>` element the edit targets is
rewritten inside the worksheet XML, and the package is zipped back up. Measured
on a real ten-sheet workbook: one part changed, one row in it, one cell in that
row; all 242 formulas (including an external reference and a shared formula) and
all 640 style attributes byte-identical.

Finding which cell is the hard half, because an edit identifies its row by the
row's *values* — DuckDB has no stable rowid across the shapes this viewer opens
— while the file needs a row *number*. Comparing DuckDB's typed values against
raw XML in JS would mean re-implementing its comparison against dates stored as
serial numbers and floats stored at Excel's precision; getting that subtly wrong
is not an error, it is an edit to the wrong cell of your workbook. So DuckDB
does the matching in its own types and reports the row's ordinal, the header row
is *found* (the first row carrying every column name) rather than counted to,
and the cell about to be overwritten must currently hold what the grid was
showing. Two independent readings have to agree; when they do not, the edit is
refused and the file is untouched.

Counting to the header is the mistake worth naming, since it looks correct:
rows-in-file minus rows-in-table is right only for a sheet with nothing below
its data. The first real workbook this ran against had 136 rows for 121 rows of
data — notes underneath — which put the "header" fourteen rows into the data.

Two things it does not preserve, both deliberate. A formula in the edited cell
is replaced by the value you typed (keeping it would mean Excel recomputing your
edit away on the next open), and a string is written as an inline string rather
than appended to the shared-string table, which every sheet in the book points
into.

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

For an Excel worksheet, the A/B/C grid headers intentionally have no data-table
actions: they describe the page, not a table. Each detected table instead gets
the same actions directly on its own header row. Its sort and contains-filter
rewrite only that rectangle; its statistics show both the displayed rows and
the complete table; its chart uses exactly the filtered, display-limited rows.

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

  The chart opens showing the whole series, and you **drag across the plot**
  to zoom into a range — the scroll wheel zooms too, and **double-clicking**
  the plot (or ⟲ in the top right) puts it back. There is no slider along the
  bottom: that is a second, smaller
  copy of the chart you have to aim at before you can look at the real one.

  At **3,000 visible points or fewer**, individual line markers and hover
  values appear automatically. Hover shows the category or UTC timestamp and
  the plotted numeric value without rounding to four significant digits.
  Zooming out hides detail again, while a crosshair remains available for
  estimating positions against the axes without a data popup or value labels.

  **∴ beside ⟲ switches the line to a scatter**, and pressing it again switches
  back — one button, because the only other state is the one you came from. It
  redraws the mark alone: the range you have zoomed into and any series you have
  hidden in the legend survive the toggle. Every new plot starts as a line
  again, so a scatter is always something you asked for about the series in
  front of you. The two marks are `long_run_3.R`'s own `raw_type <- "line"` /
  `"scatter"`, down to the 1.4 stroke and the 7.2 points.
  The tab is white whatever your editor theme is, since a chart is a figure —
  it ends up in screenshots and documents, where a dark one reads as a
  negative of itself.

  **The chart is of the query on screen**, whole and unedited — its `WHERE`,
  its joins, and its `LIMIT`. The `LIMIT` used to be stripped, on the argument
  that a chart should be of the entire series; that made the chart a picture of
  a query nobody had written, and silently, since a grid showing `limit 100`
  plotted twenty years of daily data. Every other clause was already honoured,
  so `LIMIT` was the one part of what you asked for that the chart overrode.

  The limit is applied *inside* the chart's subquery, which is what makes the
  plotted rows the rows in the grid: `select … from (your query limit 100)
  order by date` draws the hundred rows on screen, while re-appending the limit
  after the ordering would draw the earliest hundred rows of the whole table —
  the same count, a different hundred.

  `dataFileViewer.chartMaxPoints` (200,000 by default) is the viewer's own
  ceiling for a query with no limit of its own. Past it the chart refuses and
  tells you the real count, rather than drawing a prefix.

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

  **The chart is a port of the R plotting scripts** in
  `Kod/R/Time_Series_Plotting` (`helpers_echarts.R`, `helpers_core.R`, and
  `long_run_3.R`'s ECharts branch), so the same series read here and read
  there is one figure rather than two charts of the same numbers. Taken from
  them: the white ground, black axis rules, hairline gridlines with lighter
  minor ones between them, serif labels, the white tooltip with its black
  crosshair, 2%/4% padding on the time axis and 3% on the value axis, eight
  pinned y ticks, the line and scatter marks with their widths and point sizes,
  three-significant-digit axis labels and four-significant-digit
  tooltip values, and the tooltip that switches itself off above 3,000 points
  in view and back on when you zoom in — hovering a line that has thousands of
  points overplotted into a few pixels reports a value that isn't the one your
  eye is on. The ported numbers are pinned by tests in
  `test/chartSpec.test.ts`, because two implementations in two languages in
  two repositories drift silently otherwise.

  **If the table declares a frequency**, the axis and tooltip use it for
  wording: `2020 Q1`, `2020 H2`, `Jan 2020`. It's read from `sheet_metadata`,
  which ETL and macro_project both write, and it is entirely optional — a file
  with no such table, no row for this table, or a cadence not in the known
  list charts exactly the same, with plain dates. Day-to-day and weekly
  cadences deliberately keep ECharts' own adaptive tick labels, which read
  better across a long span than the same full date stamped onto every tick.
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

SQL queries always remain read-only, including when Safe Mode is off for cell
editing. The whole statement is checked, not just its first word. `select 1; drop table x` is
blocked for containing a second statement, and `with x as (…) delete from t`
is blocked for the `delete`, even though both open with a safe keyword.
Comments, text values and quoted column names are ignored when deciding, so
an ordinary query over a column containing `;` or the word `update` still
runs.

### SQL table selection

The **Query table** selector lists document relations and their SQL types.
For Excel, raw worksheets expose letter columns (`A`, `B`, `C`); detected
tables expose their headers and typed values. Selecting a table leaves your
query unchanged. **Use in SQL** inserts a quoted query, and **Restore draft**
returns to the previous text. The **SQL** button on a detected table carries
its current filters, sorting and row limit into the editor. Press **Run** to
execute it. Drafts stay in memory for the current view.

A numeric year is not a date boundary. For a DATE column, use
`WHERE "Date" >= DATE '1990-01-01'`. For ISO date text, use
`WHERE CAST("Date" AS DATE) >= DATE '1990-01-01'`. Invalid date text remains an
error; the viewer does not silently discard it or change source types.

Queries run in a separate reader process with a 30-second deadline, bounded
queues, 512 MB DuckDB memory limit and disabled disk spill. SQL is limited to
256 KiB, individual result values to 4 MiB, and result payloads to 32 MiB.
Cancel stops the reader; the next query rebuilds its caches. At most four
reader processes are retained, with idle readers released when needed.

The reader blocks SQL file/network access, extension loading, configuration
changes, internal catalogs and user-defined macros. These restrictions also
apply through stored views. Ordinary document SELECT queries, CTEs, joins,
aggregates, EXPLAIN, DESCRIBE and SUMMARIZE are supported. Cell saves use a
separate host-controlled path. Opening data requires Workspace Trust.

Functions are allowed only if every DuckDB function of that name is a plain
scalar or aggregate. A few ordinary text functions share their name with a
table function and are therefore unavailable; `repeat('x', 3)` is one — use
`rpad('', 3, 'x')` instead. A burst of **Run** clicks keeps only the newest
query; superseded ones are dropped rather than queued.

A worksheet DuckDB cannot read at all — for example one holding a cell larger
than Excel's 32,767-character limit — is reported as such, including when a
query names one of its detected tables. Other sheets stay available.

Workbook archives are checked before native parsing: 256 MiB compressed,
512 MiB inflated, 256 MiB per part, 10,000 entries and 10 million declared
cells per sheet. Unsafe archive paths and XML entity declarations are rejected.
Worker temporary files use private directories removed after worker exit;
an abrupt extension-host or OS crash can leave a private directory behind.
The worker and engine limits are not an operating-system sandbox for native
library vulnerabilities, and native parser memory can exceed the DuckDB limit.

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
npm run test:security   # SQL containment, message boundary, trust, edit integrity
npm run test:browser    # real webview DOM in Chrome (Playwright)
npm run test:host       # the packaged VSIX in an isolated VS Code host
npm run test:resources  # deadlines, zip bombs, 200k rows, 500 tables (slow)
# Speed work (slow; needs `conda run -n myproject python test/resources/build_profile_corpus.py` first):
# test:resources also runs profile.test.ts (PROFILE lines per format and stage) and
# equivalence.test.ts, which compares everything a user can observe against a
# recorded baseline -- record one with DFV_EQUIV_RECORD=1 before changing code.
npm run test:fuzz -- --seed 12345 --runs 20000   # reproducible fuzz campaign
npm run test:package    # inspect the newest VSIX against allow/deny rules
```

The security tests use throwaway files, local listeners and synthetic
sentinels only. `test:resources` is kept out of `npm test` because it burns CPU
and memory on purpose; it prints `PERF` lines worth recording when limits or
the engine change.

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
code --install-extension data-file-viewer-0.0.14.vsix
```

`@duckdb/node-api` ships platform-specific native binaries resolved at
`npm install` time. **A `.vsix` built on one OS will not work on another** —
do not copy it across machines. Build separately per platform, or use the
GitHub Actions workflow below to get both automatically.

**If `vsce` packages 9 files and 460 KB instead of ~1500 files and ~42 MB,
check the path you are building from.** That build has no `node_modules`, so
the extension installs and then fails on first use with a missing
`@duckdb/node-api`. `vsce` locates dependencies by running `npm ls --parseable`
and globbing each path it prints; if anything rewrites that output — a sandbox
that redacts part of the working directory, for instance — every path it is
handed does not exist, every glob returns nothing, and it reports no error,
because zero files is not a failure to it. `vsce ls` is the quick check: it
should print about 1500 lines. `vsce ls --no-dependencies` printing 7 while
`vsce ls` prints 0 is the signature. Build from an ordinary path.

A correct package contains `extension/dist/extension.js`, a
`extension/node_modules/@duckdb/node-bindings-*/duckdb.node`, and no
`extension/test/` or `extension/out-test/` entries at all:

```sh
unzip -l data-file-viewer-*.vsix | grep -c "extension/out-test/"   # must be 0
npm run test:package   # the same checks and more, on the newest VSIX
```

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
