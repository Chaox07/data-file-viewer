# SQL filtering and detected Excel tables: implementation plan

Date: 2026-09-23. Investigated version: 0.0.13, commit `46ae830`.

**Status: planning only. No application changes are implemented by this document.**

The required security controls, test matrix and release gates are specified in
[the security and reliability suite plan](sql-filtering-security-suite-plan.md).
That companion is part of this implementation scope, including the existing
shared SQL paths exercised by the new controls. It supersedes weaker error,
configuration and release assumptions below; the feature must not ship without
its security gates.

## 1. Verified problem

The reported query was:

```sql
SELECT * FROM "Raw_Data"
WHERE "Date" >= 1990
LIMIT 100;
```

The two supplied files fail for different reasons. They were investigated through
the current `DuckDbFile` implementation using temporary copies; original SHA-256
hashes were unchanged afterward. Temporary copies were removed. Source data and
workbooks are not included in this repository.

| File format | Verified schema | Actual failure |
| --- | --- | --- |
| DuckDB | `Raw_Data.Date` is `VARCHAR` | DuckDB rejects a comparison between `VARCHAR` and `INTEGER_LITERAL`. |
| Excel worksheet | `Raw_Data` exposes the verbatim sheet as `A`, `B`, etc. | `Date` is not a column of that worksheet relation. |
| Excel detected data table | `Raw_Data · Table 2` exposes `Date` as `DATE` | This is the correct SQL target; the comparison must use a date literal. |

The workbook also contains `Raw_Data · Table 1`, a small series-definition table.
Selecting the first detected table automatically would therefore select the wrong
data. The main table starts at B11, including its header, and has 16,803 data rows.
Both formats' main data tables contain 16,803 rows; all non-null Date values passed
a full-column date-conversion check.

These queries were verified to return 100 matching rows:

```sql
-- Supplied DuckDB file: dates stored as text.
SELECT * FROM "Raw_Data"
WHERE CAST("Date" AS DATE) >= DATE '1990-01-01'
LIMIT 100;

-- Supplied Excel file: query the detected data table.
SELECT * FROM "Raw_Data · Table 2"
WHERE "Date" >= DATE '1990-01-01'
LIMIT 100;
```

Synthetic DATE, TIMESTAMP and VARCHAR columns also reject `>= 1990`; an INTEGER
year column accepts it. This is type checking, not evidence that WHERE or LIMIT
is broken. The viewer's usability defects are that it does not make queryable
Excel tables and their types discoverable, or explain these errors in context.
The displayed/charted date appearance does not establish its SQL storage type.

## 2. Existing implementation to reuse

- `src/duckdbConnection.ts`: `listTables()` already includes detected tables;
  `listSidebarTables()` intentionally hides them to preserve worksheet navigation.
  `getDetectedSheetTables()` supplies their names, bounds and headers.
- `ensureSheetPrepared()` registers detected relations lazily;
  `ensureDerivedPrepared()` prepares their values and types when used.
  `pendingSheetFor()` currently prepares at most one pending sheet per query.
- `buildDetectedTableQuery()` already generates SQL for inline filters, sort and
  limit. `runDetectedTableQuery()` returns that SQL with the results.
- `src/webview.ts`: inline tables have filter, sort, stats and plot controls, but
  no action to open their SQL. Their full SQL names are largely confined to a
  hover title. CodeMirror uses `sql()` without table/column schema completion.
- `src/duckdbEditorProvider.ts`: manual SQL is forwarded to `runQuery()` unchanged;
  failures are sent back as the engine's message. Worksheet coordinates are
  correctly omitted from manually filtered/reordered results.
- `src/webviewState.ts`: the result state and effects already distinguish ordinary
  query results from verbatim worksheet previews and inline table results.

## 3. Intended user behavior

### A. Make SQL targets explicit

Add a compact **Query table** selector beside the SQL editor. For Excel, group
detected tables under their worksheet and show the real SQL name, range and
header summary. Label the whole-sheet choice **Raw worksheet (A, B, C…)**.
For normal databases, list their actual relations and qualified names as needed.

Selecting a target shows its columns and actual SQL types. It must not silently
change an existing SQL draft, execute a query, or choose a table based on the
first match for a column called Date. Offer an explicit **Use in SQL** action.

Keep the existing sidebar's worksheet navigation and inline plot controls.
Discover a sheet's tables when that sheet is selected; do not read every workbook
sheet merely to populate a dropdown. Represent unprepared sheets as such.

### B. Open a detected table's current filter in SQL

Add one **SQL** button to each detected table's leading header controls.
It opens the SQL editor for that exact detected table:

1. Ask the host to build SQL from the current inline filters, sort and display
   limit using the existing query builder. Do not rebuild predicates in the DOM.
2. Seed the editor with that query and show the selected table's types.
3. Preserve the previous editor draft with an explicit restore action; never
   silently discard user SQL when switching from worksheet controls.
4. The user edits the query and presses Run through the existing execution path.
5. Display the result as an ordinary query grid, with eligible sorting, stats and
   plotting. A worksheet preview action returns to the original sheet.

Keep the inline display limit visible and editable in the SQL. In the supplied
workbook, the action must target `Raw_Data · Table 2`, not the definitions table
or the raw worksheet. Do not paint arbitrary SQL results into worksheet cells:
joins, projections and ORDER BY invalidate worksheet coordinates.

### C. Explain date/type and worksheet-target errors

Preserve the engine error category and useful location, redact credentials,
unrequested cell values and unrelated paths as defined in the security plan,
and add a short contextual explanation:

- `VARCHAR` compared with an integer: explain that the stored column is text.
  For date intent, present an explicit date-cast example; do not rewrite SQL.
- `DATE`/`TIMESTAMP` compared with an integer: show a typed boundary such as
  `DATE '1990-01-01'`. A bare numeric year is not a date literal.
- Missing Date in an Excel raw-sheet query: explain the A/B/C worksheet columns
  and offer the detected tables that actually contain Date.

Diagnostics must use known relation/column metadata, not assume that every
column named Date contains dates or that every integer is a year. Where the SQL
target is ambiguous, show the schema and sanitized engine error without guessing.
Use a separate small helper such as `src/queryDiagnostics.ts` for classification
and messages; the host remains responsible for metadata and execution.

Do not automatically use TRY_CAST to make an error disappear: invalid values
would become NULL and could silently disappear from WHERE results. The verified
example uses CAST and fails visibly if a later source contains invalid dates.
Do not convert the stored column, change source files, or change producers.

### D. Support discovery across query and refresh state

Expose separate navigation and query-catalog metadata through the provider and
`webviewState.ts`. Use actual host-validated identifiers, exact column names,
types, sheet origin and region bounds. Quote identifiers through the existing
SQL quoting helpers; escape names rendered in HTML.

Feed known relations and columns to CodeMirror's schema completion. Refresh this
metadata after detection, reconnect and source changes, including when a failed
query nevertheless caused a sheet to be prepared. Do not require a successful
query before newly discovered tables become selectable.

Verify saved SQL can reference a detected table immediately after reopening,
without first previewing its worksheet. For multi-relation queries, inspect the
current single-pending-sheet limitation and reproduce it before changing it.
If it prevents valid queries, prepare all explicitly referenced sheets before
binding; do not broadly materialize unrelated sheets or invent a regex SQL parser.

Revalidate a selected relation against refreshed bounds/header metadata. If a
detected table disappears or changes identity after source edits, show the change
and require target reselection before generating replacement SQL.

## 4. Scoped files and implementation order

| Step | Intended files | Completion requirement |
| --- | --- | --- |
| 1. Catalog and SQL handoff | `src/duckdbConnection.ts`, `src/duckdbEditorProvider.ts`, `src/webviewState.ts` | Typed query targets and generated SQL available through validated messages; lazy loading retained. |
| 2. User controls | `src/webview.ts`, `media/main.css` | Query selector, column/type display, one inline SQL action, draft preservation and schema completion. |
| 3. Error guidance | new `src/queryDiagnostics.ts`, provider/state/view files | Original errors plus accurate, non-mutating guidance for reproduced cases. |
| 4. Lifecycle corrections, if reproduced | connection/provider/state files | Cold first use, failed-query discovery and refreshed targets work without changing SQL meaning. |
| 5. Validation and documentation | focused tests, browser harness, `README.md` | Verified user workflows, known failures reported, documentation matches behavior. |

No new configuration is needed for table selection or date guidance. Security
policy and any necessary compatibility choices follow the companion plan;
internal limits must not become a collection of user-facing settings.
Preserve Safe Mode, query cancellation,
result caps, editability checks, full-query sorting and exact query-based plotting.
Do not extend arbitrary SQL editability or undertake SQL-engine/parser replacement.
No changes to other projects, source workbooks or database schemas are included.

## 5. Validation and acceptance

Use synthetic fixtures in committed tests; use temporary copies of the supplied
files for local acceptance. Never commit those files or extracted row data.

- **Type matrix:** native DATE, TIMESTAMP, text ISO dates and numeric years;
  the original and corrected predicates; 1989/1990 boundary, NULL, invalid date
  text, mixed period labels and empty results. Invalid SQL must not be rewritten.
- **Workbook layout:** the supplied layout (preamble/definitions plus main table
  starting below and to the right of A1), side-by-side tables, multiple sheets,
  repeated column names, no headers, quoted/Unicode names and detection disabled.
- **SQL behavior:** filtered SELECT *, projection/alias, ORDER BY, LIMIT/OFFSET,
  CTE and join smoke tests. The selected table must not include neighboring
  tables, headings or footnotes. Unsupported edits remain read-only.
- **Lifecycle:** direct first-use SQL, reopen, failed-query discovery, detection
  changes, source refresh, cancellation, queued requests and stale responses.
- **Visible UI:** select the correct table without typing its generated name;
  open its current inline filter as SQL; retain/restore the previous draft;
  run the date filter; inspect 100 matching rows; plot and show stats from that
  exact result; return to the unchanged worksheet. Verify editor completion and
  date/type explanations in the installed VS Code webview, not just host state.
- **Load:** large/multi-sheet workbook, a 200,000-row synthetic dataset and 100
  repeated target/filter switches. Measure cold/warm preparation and memory;
  verify catalog refresh does not reread or materialize every table each time.
- **Preservation:** hashes of original files unchanged after read-only workflows;
  separate existing edit/save regressions continue to pass.

Run typecheck, focused connection/provider/reducer tests, proportionate browser
checks and the complete existing suite. Report skipped and known cases separately.
The companion plan additionally requires adversarial, containment, cross-document,
fuzz, packaging and installed-host checks with explicit pass/fail conditions.

## 6. Delivery gate

This change delivers the plan only. Implementation requires a subsequent explicit
assignment. When implemented and verified, update the README, bump the version
beyond 0.0.13, push to GitHub as requested, verify CI and platform release assets,
then install and verify the new VS Code package. Do not label this plan as a fix
or replace the installed extension during the planning task.

## References

- [DuckDB DATE literals](https://duckdb.org/docs/current/sql/data_types/date)
- [DuckDB explicit casting](https://duckdb.org/docs/current/sql/expressions/cast)
- [DuckDB comparison rules](https://duckdb.org/docs/current/sql/expressions/comparison_operators)
