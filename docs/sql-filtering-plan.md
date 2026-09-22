# SQL filtering and detected Excel tables: unified implementation plan

Date: 2026-09-23. Investigated application: 0.0.13 (`46ae830`).

**Status: planning only. No application changes or security restrictions are implemented by this document.**

This is the single plan for SQL table selection, date-filter guidance, security,
reliability testing and release. It replaces the two prior planning documents.
All functional requirements, S1–S7 controls and test-family IDs remain in scope.

## 1. Verified evidence and existing implementation

### Date-filter failures

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

### Security findings and evidence limits

| ID | Status | Finding and implication |
| --- | --- | --- |
| F-01 | Reproduced with a synthetic local fixture | `destructiveReason()` accepts a SELECT over `read_text`; the current `DuckDbFile.runQuery()` can read a temporary file outside the opened database. A no-write SQL check is not a confidentiality boundary. |
| F-02 | Confirmed by source inspection | `ensureExtension()` installs/loads format extensions; cold installation can use the network. Query-driven external access and trusted format bootstrap need separate policies. |
| F-03 | Confirmed by source inspection | Webviews restrict resource roots to packaged dist/media and use a nonce CSP. Error rendering uses textContent. Retain these controls when adding schema completion, names and diagnostic UI. |
| F-04 | Confirmed by source inspection | Several incoming commands rely on a TypeScript message union plus command-specific checks. New messages require runtime validation; TypeScript types do not validate webview input. This is an audit requirement, not a claim that every existing command is exploitable. |
| F-05 | Confirmed by source inspection | The inline query builder bounds input using slice operations. New handoff paths must reject oversize inputs visibly instead of silently changing predicates or dropping filters. |
| F-06 | Requires targeted reproduction | Network access, malicious stored views/macros, cross-document leakage, cancellation races, parser bypasses and malformed-workbook exhaustion must be tested. They are not reported as demonstrated exploits here. |

F-01 was tested only on files created by the investigation and removed afterward.
No personal file, credential store or external network endpoint was probed.
Earlier functional reproductions verified the two reported date-filter failures;
those remain separate from the security findings.

### Existing implementation to reuse

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

## 2. Scope and security contract

This plan combines the feature, security controls and validation into one scope.
No new configuration is needed for table selection or date guidance; security
compatibility decisions follow S1/S5, and internal limits stay out of user settings.
Preserve Safe Mode, query cancellation, result caps, existing editability checks,
full-query sorting and exact query-based plotting. Do not extend arbitrary SQL
editability, replace the SQL engine/parser, or change upstream projects, source
workbooks or database schemas.

Protect source rows, column/table names, SQL literals, query drafts, absolute paths,
backup contents, credentials reachable from the host, and the integrity of saved
files. Source files, cells, headers, SQL text and all webview messages are untrusted
inputs. A local file may contain hostile names, formulas, metadata, views or macros.

Trust boundaries to enforce:

1. File/catalog metadata to host query construction.
2. Webview messages to host document operations.
3. User SQL and stored database objects to DuckDB file/network capabilities.
4. Host results to the correct document, view, generation and request.
5. Displayed content to DOM, logs, clipboard, persisted state and release artifacts.
6. Query completion to edits, backup publication, refresh and disposal.

The default SQL feature may query the opened document's approved dataset relations.
It must not implicitly access arbitrary local files, remote URLs, credential stores,
unrelated attached catalogs or another document. A WHERE filter is a query choice,
not a row-level authorization system; users who can query an approved table can
write another query over that table. Do not advertise per-row access control.

Query selection, schema completion and diagnostics must not write source data or
execute SQL automatically. Edits remain explicit existing operations, governed by
Safe Mode, reliable row identity and transactional/atomic publication.

Workspace Trust, CSP, a read-only database connection and SQL keyword scanning
each address only part of this model. None is a complete sandbox for native code.
Compromise of the host OS or arbitrary other extensions is outside the claimed
protection; vulnerable native parsers still require dependency fixes and isolation.

## 3. Phased implementation roadmap

All phases are **not started**. The reproduced findings above are planning evidence,
not completed implementation phases. Implementation requires a subsequent explicit
assignment. Once assigned, gates below are evidence-based completion conditions,
not a requirement to request permission again after every phase.

| Phase | Outcome | Depends on | Primary requirements | Exit evidence |
| --- | --- | --- | --- | --- |
| 1 | Reproducible baseline and agreed execution boundaries | Implementation assignment | Functional failures, F-01–F-06 and threat model | Baseline report, canaries, sink inventory and settled worker/file policy. |
| 2 | Restricted query runtime and reliable cancellation | Phase 1 | S1, S6, host-side S5 | Authorized local queries pass; outside access and writes are blocked; worker lifecycle verified. |
| 3 | Validated catalog, table identity and SQL handoff | Phase 2 | S2, S3, S4 metadata rules; functional D | Exact target/schema, lazy preparation, generation checks and safe SQL construction pass. |
| 4 | Table selection, SQL editor integration and useful diagnostics | Phase 3 | Functional A–D; S4, webview S5 | Visible end-to-end workflows, safe rendering, draft preservation and sanitized errors pass. |
| 5 | Full security, reliability and preservation acceptance | Phases 2–4 | S1–S7 and complete test matrix | All required families executed; no blocking leaks, corruption, races or resource failures. |
| 6 | Documentation, GitHub release and installed-package verification | Phase 5 | Packaging/release gates | CI, platform assets and installed-host checks verified; clean scoped delivery. |

### Phase 1 — Baseline and execution design

- Reproduce the supplied date-filter failures and the synthetic F-01 outside-file
  read; preserve original dataset hashes. Turn each into a minimal regression.
- Inventory every SQL execution sink, including counts, stats, plots, previews,
  inline filters, live refresh, stored views and diagnostic/schema probes.
- Record exact dependencies, fresh connection capabilities, existing known cases,
  cold/warm timings, memory, bytes and file/network observations.
- Settle worker/connection ownership, per-format approved-file access, trusted
  extension bootstrap, Restricted Mode behavior and cancellation budgets.
- Define request/generation identity and which state is private to each document.

**Files/deliverables:** baseline fixtures and harnesses, security-policy design,
execution-sink inventory and a test-family traceability record. No user-data files
or extracted rows are committed.

**Gate:** evidence distinguishes reproduced defects from hypotheses; the proposed
runtime can support local DuckDB/Excel workflows without silently widening access.
Unresolved capability design blocks Phase 2 implementation, not further investigation.

### Phase 2 — Query restrictions and resource control

- Implement S1 and S6 through the shared execution layer, including secondary
  queries. Separate trusted initialization/save operations from restricted reads.
- Establish worker ownership, deadlines, cleanup and a bounded queue. Preserve
  explicit edits and save transactions outside the killable read worker.
- Enforce host trust and Safe Mode at execution time, including queued operations,
  refresh/reconnect, bootstrap failure and cancellation.
- Verify external-file/network denial and authorized local reads together. Resolve
  confirmed format/bootstrap compatibility issues before UI integration.

**Files:** new policy/worker modules as settled in Phase 1;
`src/duckdbConnection.ts`, `src/duckdbEditorProvider.ts`, `src/sqlSafety.ts`,
`src/extension.ts`, and trust declarations in `package.json` if needed.

**Gate:** SEC-01–10, SEC-24–26 and relevant DOS/cancellation cases demonstrate
actual side-effect prevention and successful local workflows. A child process or
SQL scanner alone is not accepted as a data-access sandbox.

### Phase 3 — Catalog, identity and SQL generation

- Implement runtime message validation, document-bound relation IDs, request IDs,
  catalog generations and stale-response rejection (S2).
- Separate navigation from SQL-catalog metadata. Return only approved names,
  actual types, origins/bounds and bounded counts; keep discovery lazy (S4).
- Reuse the existing typed query builder for inline filter/sort/limit handoff;
  enforce exact quoting, parameterization, input rejection and relation identity
  (S3). No SQL rewriting or silent truncation.
- Verify cold first use, failed-query discovery, name collisions, refreshed
  regions and multi-relation queries. Fix preparation defects only after reproduction.

**Files:** `src/duckdbConnection.ts`, `src/duckdbEditorProvider.ts`,
`src/webviewState.ts`, new message validators and focused connection/provider tests.

**Gate:** SEC-11–17, REL-05–12 and lifecycle checks prove that the exact requested
relation is prepared and handed off, with no cross-document/internal-catalog access.

### Phase 4 — User workflow and diagnostics

- Add Query table selection, a column/type display, schema completion and one
  inline SQL action per detected table. Distinguish raw worksheets clearly.
- Preserve/restore the existing editor draft; never auto-run generated SQL or
  replace the draft silently. Keep the query's filters, ordering and limit visible.
- Add type-aware date guidance and worksheet-target suggestions without guessing
  locale, year meaning or a target among multiple detected tables.
- Implement sanitized diagnostic fields, safe DOM/completion rendering, narrow
  resources and volatile document-owned drafts (S4/S5).
- Keep ordinary filtered results separate from worksheet coordinates; verify
  plotting, stats and returning to the worksheet through real UI interaction.

**Files:** `src/webview.ts`, `src/webviewState.ts`, `media/main.css`,
new `src/queryDiagnostics.ts`, provider messages, browser and reducer tests.

**Gate:** functional A–D, SEC-18–23 and REL-01–04 pass at the visible UI boundary;
the correct Excel data table can be filtered without manually guessing its SQL name.

### Phase 5 — Full-suite acceptance

- Execute the complete matrix and functional acceptance scenarios in section 6,
  including out-of-order results, two-document races and repeated target changes.
- Retain S7 editability, precision and publication guarantees; use independent
  readers for persisted output and verify source hashes for read-only workflows.
- Run bounded seeded fuzz, native-parser/resource tests and recorded cold/warm
  load comparisons. Minimize each confirmed defect into a regression and fix it.
- Add security/containment and browser jobs to relevant PRs. Run broader fuzz/load
  campaigns nightly and before release; publish only sanitized fixtures and metrics.
- Report passed, failed, skipped, TODO and unexecuted distinctly. Apply all release
  blockers below; a scheduled job is not a substitute for pre-release evidence.

**Files:** focused tests, existing integrity/format suites, browser/host harnesses,
package checks, planned npm test entry points and `.github/workflows/*`.

**Gate:** all required feature/security families executed on release platforms;
no unresolved blocking issue, unacceptable performance regression or missing evidence.

### Phase 6 — Release and verified installation

- Update README to describe actual behavior and compatibility restrictions; bump
  the version beyond 0.0.13 only when the changes are implemented and tested.
- Build from a clean checkout, inspect VSIX contents and run package checks. Push
  to GitHub, verify CI and macOS/Windows release assets, then install the package.
- Verify the installed VS Code host and visible workflows use the tested build.
  Include trust transitions, SQL selection/filtering, stats, plotting and recovery.
- Remove only task-owned obsolete artifacts; preserve user data and backups.
  Record residual risks and the explicit rollback procedure in section 7.

**Gate:** released and installed artifacts match the approved commit, all host and
package checks pass, and the repository is clean. A green source suite alone is
not completion of deployment.

## 4. Functional requirements

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

## 5. Security and reliability controls

### S1. Constrain SQL execution and external access

Add a central host-owned execution policy used by manual Run, previews, inferred
schema probes, counts, stats, plots, inline filters and live refresh. Protect
secondary SQL execution too: SUMMARIZE, EXPLAIN, CTEs, macros and stored views can
exercise capabilities even when their leading keyword appears harmless.

Implement and test engine-level restrictions using the installed DuckDB version's
supported controls, including `enable_external_access`, narrowly scoped
`allowed_paths`, extension auto-install/load restrictions and `lock_configuration`.
Establish restrictions before evaluating file-defined views or SQL. Treat these
as defense in depth and verify their actual behavior on each supported platform,
including canonical paths and aliases. See [DuckDB's security guidance](https://duckdb.org/docs/current/operations_manual/securing_duckdb/overview).

Keep user query execution separate from trusted initialization and save operations:

- The host derives allowed dataset paths from the document, never from webview
  strings. Prefer materialized in-memory relations for query access where already
  used by Excel; do not expose ingestion or staging paths as public query targets.
- If a format must reread its source, permit only the precise canonical source
  path and the required operation. A path allowlist alone does not enforce
  read-versus-write permissions; use read-only connections/handles and enforce
  the write policy independently. Do not allow the whole parent directory.
- Existing hot/cold pairs and backup comparisons require explicit host-scoped
  access. Hide internal catalogs from discovery and test access via qualified SQL
  names as well; hiding a dropdown entry is not access control.
- Load only host-selected, required format extensions through trusted bootstrap;
  prevent user SQL, metadata or error retries from choosing repositories, native
  libraries, extensions or credentials. Separate cold dependency download from
  dataset query traffic. Keep unsigned loading disabled. Verify pinned-version
  behavior against [DuckDB extension controls](https://duckdb.org/docs/current/operations_manual/securing_duckdb/securing_extensions).
- Lock capability settings against SQL changes. Audit callable side effects and
  nested/comment/dollar-quoted statement forms; keep the existing scanner as
  guidance, not the sole security enforcement mechanism.
- If an allowed table is a view requiring an external resource, return a clear
  blocked-resource explanation. Do not fetch it or weaken the policy on error.

This narrows currently possible arbitrary external SQL reads. Document that
compatibility change explicitly. Do not add a permissive fallback or automatically
grant external access when Safe Mode is unchecked. Supporting intentional external
SQL access would require a separately specified, explicit grant model; it is not
part of this feature. No routine approval dialog is needed for normal local SQL.

### S2. Runtime message validation and document ownership

Introduce reusable validators for new catalog, SQL handoff and diagnostic messages;
audit the shared Run/filter/stats/chart handlers they call. Validate command,
primitive types, finite integers, enums, array lengths and UTF-8 payload sizes.
Reject unknown commands, malformed objects and invalid values before native calls.

Use document-bound opaque relation IDs plus a catalog generation for UI requests.
The host resolves IDs to catalog/schema/table identity and current region metadata;
never accept a client-supplied path, connection, SQL type or table-origin coordinate
as authority. Verify column membership and reject prototype-key tricks such as
`__proto__`, including in completion dictionaries and diagnostic metadata.

Every response carries document/view, request and generation identity. Validate
ownership on the host; discard stale responses in the reducer. IDs are correlation
mechanisms, not authentication by themselves. The callback's bound document is the
authority. Validate Safe Mode and trust again when a queued operation executes.

Proposed starting limits: 256 KiB SQL text, 100 filters, 4,000 characters per filter
value and 1 MiB per catalog response with pagination. Treat these as design targets
to validate, not existing guarantees. Reject oversize inputs clearly; never truncate
SQL, identifiers or predicates silently. Keep internal limits out of user config.

### S3. Exact SQL construction and relation identity

Resolve and quote catalog/schema/table/column components separately. Do not split
quoted names on periods. Preserve case, Unicode and duplicate-name distinctions.
Use parameter binding for executed generated predicates where supported; when
showing editable SQL, use the existing tested literal/identifier serialization.
Allow operators and sort directions only from fixed host enums. Do not interpolate
unvalidated SQL types or diagnostic suggestions into executable text.

Do not rewrite arbitrary user SQL, infer a date locale, remove a LIMIT, cast the
stored column, silently use TRY_CAST, or interpret a numeric identifier as a year.
Prevent catalog name collisions from merging tables or selecting an adjacent
Excel region. On refresh, validate relation identity, header and bounds before
generating SQL or permitting edits. Multi-sheet preparation must resolve actual
references rather than treating names inside literals/comments as authority.

### S4. No passive data leakage

Catalog messages carry only the needed names, types, bounds and counts; completion
must not sample row values or send source paths, view definitions, credentials or
unrelated databases. If exact counts are expensive, label them unknown until ready.
Only the explicit query result carries requested rows, subject to result caps.

Keep drafts in the owning view's volatile memory by default. Restore them within
that view without syncing them to settings, shared global state or another document.
Clear drafts and cached metadata on disposal. If persistence is later requested,
define retention and deletion explicitly; do not silently introduce query history.

Keep useful engine error category and caret location while removing credential
values, URL user-info/query tokens, unrelated absolute paths and unrequested cell
contents echoed by conversion failures. Report counts/types instead. Treat file
names, schema names and rows as sensitive in logs too. Log event category, timing
and opaque request IDs; raw SQL, row values and full errors are off by default and
must not leak merely because live-refresh debug logging is enabled.
Construct diagnostics from allowlisted fields; do not rely on a few secret-pattern
regexes to make arbitrary raw errors safe. Unknown errors get a generic category
and opaque diagnostic ID, without automatically publishing their raw text.

No automatic telemetry, clipboard writes, crash attachments, external links or
uploads are introduced. Explicit copying of the user's query/results remains a
user action. Tests and public reports use synthetic markers, never real secrets.

### S5. Webview and workspace boundary

Render names, values and errors through textContent or equivalent safe rendering.
Completion labels are text, not trusted HTML/Markdown. Avoid command URIs and
arbitrary openExternal calls from table metadata. Retain the nonce CSP, narrow
dist/media resource roots, and a private VS Code API handle; do not add remote
scripts, fonts or connections. Verify network/image/navigation attempts using
hostile names in the actual webview. Follow [VS Code webview guidance](https://code.visualstudio.com/api/extension-guides/webview).

Declare and enforce the supported Restricted Mode behavior on the host. In an
untrusted workspace, block custom SQL and write operations; offer only a preview
path whose file and network restrictions have been verified. If that cannot be
established, explain why preview is unavailable. Trust changes must update queued
operations and visible controls. Workspace trust is not proof that a database
view is safe. See [Workspace Trust integration](https://code.visualstudio.com/api/extension-guides/workspace-trust).

### S6. Resource bounds, cancellation and cleanup

Apply bounded catalog discovery, query-result bytes, per-cell transport handling,
query memory, threads and execution time. A row limit does not bound joins, scans,
sorting or one enormous cell. Do not silently clip cell text: reject over-budget
results or expose an explicit omitted-value state without presenting it as complete.

Use a cancellable query worker with a parent-enforced deadline for untrusted SQL
and expensive parsing. Prototype worker ownership before wiring new endpoints;
if a native call ignores interrupt, terminate/recreate its worker, not the VS Code
extension host. Do not run writes in a killable read worker. Bound the shared queue,
coalesce superseded catalog requests and suppress duplicate automatic retries.
A child process alone still has its parent's file/network privileges; it is an
availability boundary, not an OS sandbox. Any claim of protection against native
parser/extension compromise requires separately verified OS restrictions. If a
query path cannot be constrained, block it rather than claim worker isolation
has solved the access problem.

Preflight workbook ZIP/XML size, entry count and decompression budgets; test entity
expansion, path traversal, malformed dimensions and external workbook links. Do
not follow links, evaluate formulas or execute macros. Set private temporary-file
permissions and remove only session-owned artifacts after completion/cancellation.
Treat DuckDB spill data as potentially sensitive; do not promise all plaintext
intermediates vanish until crash and spill behavior has been checked.

Suggested acceptance targets: cancel acknowledgement within 250 ms at the UI;
cooperative completion within 2 s, followed by a hard worker deadline no later
than 5 s; no use-after-dispose or stale result after cancellation. Calibrate these
against a recorded test machine and publish any revision before acceptance.

### S7. Preserve edits, saved files and consumer behavior

Ordinary filtered SELECT * may retain only the existing verified editability;
joins, aggregates, ambiguous identities and computed projections stay read-only.
Reject client-provided row coordinates after sorting, filtering or source refresh.
Preserve exactly-one-row updates, rollback on mismatched counts, and atomic file
publication. Keep existing wide-integer, decimal/text, Unicode, NULL and workbook
cell-type regressions. Query metadata must not promote or rewrite source headers.

Stats, plots, row totals, selection labels and grid rows must all refer to the same
query generation. Distinguish matching-row totals from rows displayed by LIMIT.
Never show an old successful table's rows beneath a new target or error label.

## 6. Verification and release gates

### Functional acceptance scenarios

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
The complete matrix below adds adversarial, containment, cross-document, fuzz,
packaging and installed-host checks with explicit pass/fail conditions.

### Full test matrix

All adversarial tests use throwaway documents, fake credentials and local listeners.
Do not probe real home directories, credential stores, cloud metadata services or
public exfiltration endpoints. Restriction tests must observe the attempted side
effect, not just a reassuring error or empty result.

| IDs | Suite and cases | Required observation |
| --- | --- | --- |
| SEC-01–04 | Synthetic outside-file reads via direct SELECT, table functions, nested queries and persisted views/macros; absolute/relative/quoted paths, glob, symlink, sibling-prefix and Windows path variants | No outside marker reaches the result, diagnostic, log or webview. Allowed document queries still work. |
| SEC-05–07 | HTTP/HTTPS, redirects and credential-bearing fake URLs; localhost listeners and isolated DNS/network instrumentation; stored external views during auto-preview | No unauthorized outbound attempt, including failed connection attempts or redirect follow-ups. Trusted format bootstrap is tested separately. |
| SEC-08–10 | Writes/DDL, COPY/ATTACH, settings changes, extension loading and side-effecting CALL/function forms under Safe Mode; CTE, comments, nested comments, dollar quoting and multi-statement variants | Fixture hashes/catalog remain unchanged; no file created, extension loaded or policy weakened. Accepted read syntax retains correct results. |
| SEC-11–13 | Catalog discovery across two documents, internal attachments/backups, same table names in separate schemas; hidden target queried by qualified name | Only authorized document relations appear or are accessible; internal catalogs do not become accessible through naming tricks. |
| SEC-14–17 | Invalid message types, null/arrays, invalid enums, NaN/Infinity, negative counts, oversize payloads, unknown/replayed IDs and prototype keys | Typed failure before native access; no crash, mutation, silent truncation or cross-document response. |
| SEC-18–20 | Hostile table/column/filter/error strings: quotes, SQL punctuation, Unicode, markup, SVG/image handlers, command/javascript URIs | Exact identifier/value semantics; no DOM execution, resource fetch, navigation or extra statement. |
| SEC-21–23 | Fake secret/path/row sentinels in engine failures, connection errors, drafts, debug output and release artifacts | No sentinel in unintended sinks; explicit authorized query output/copy remains correct. |
| SEC-24–26 | Restricted Mode, trust revocation, Safe Mode toggled while queued, reconnection and extension-bootstrap failure | Host rejects unauthorized operations at execution time; no permissive fallback. |
| REL-01–04 | DATE/TIMESTAMP/VARCHAR/numeric years; 1989/1990 boundary; NULL, invalid dates, mixed periods, Unicode and precision extremes | Correct result or explicit error; no implicit year conversion, discarded invalid rows or changed source type. |
| REL-05–08 | Workbook preamble/definitions/data, offset headers, side-by-side tables, no headers, duplicate/colliding names, detection off and missing tables | Exact chosen region; no adjacent table or footnote included; identity changes are visible. |
| REL-09–12 | SQL handoff with filters/sort/LIMIT/OFFSET, projection, CTE and joins; quoted names and direct cold first use | Generated SQL round-trips; manual SQL unchanged; all required sheets prepared once, unrelated sheets remain lazy. |
| REL-13–16 | Interleaved results/counts/stats/chart/catalog/draft messages from old requests, two documents, refresh and disposal | Stale data rejected; target, rows, counts and actions stay in one generation. |
| REL-17–20 | Cancel while queued/preparing/executing/counting; repeated Run; close during native work; injected I/O error and worker exit | Timely cancellation, bounded retries, no crash/use-after-close, locks released and next query succeeds. |
| INT-01–04 | Filtered-result edits, duplicates/shadowed row IDs, stale workbook bounds, partial write/backup failure | Exactly one intended cell/row changes or operation rolls back; independent persisted-file readers agree. |
| PERF-01–04 | 200,000 rows, 50 sheets/500 detected tables, one large cell, 1,000 rapid target changes; cold/warm/50 refresh cycles | Recorded p50/p95, peak RSS, bytes, reads and queue depth; bounded work and no continuing memory growth. |
| DOS-01–04 | Cartesian join/recursive SQL, oversized ZIP/XML, malformed/huge dimensions and parser stalls under parent deadlines | Budgets stop work and UI survives; no uncontrolled decompression, disk growth or orphan worker. |
| PKG-01–04 | Lockfile/dependency review, clean-checkout build, VSIX file inspection, installed host on macOS/Windows | Same tested code ships; no fixtures, backups, SQL drafts, fake secrets or local-only dependencies in artifacts. |

Parameterize these families; the IDs are coverage requirements, not a claim that
exactly this many tests exist. Add a regression for every confirmed defect before
fixing it. Pair negative cases with successful authorized operations so a blanket
"deny everything" implementation cannot pass.

### Test layers, files and runnable entry points

| Layer | Proposed implementation/test locations | Execution scope |
| --- | --- | --- |
| Policy/validation | new `src/queryPolicy.ts`, `src/queryMessages.ts`; corresponding unit tests; existing `src/sqlSafety.ts` / `test/sqlSafety.test.ts` | Fast deterministic validation, scanner/parser differential cases and policy decisions. |
| Query ownership/isolation | `src/duckdbConnection.ts`, `src/duckdbEditorProvider.ts`; query worker module designed in Phase 1 | Real DuckDB/Excel integration, external-access canaries, timeouts, trusted setup and teardown. |
| Catalog/diagnostics | new `src/queryDiagnostics.ts`, connection/provider tests | Actual types, redaction, exact relation identity and cold/lazy preparation. |
| State/UI | `src/webviewState.ts`, `src/webview.ts`, `media/main.css`; reducer and browser tests | Out-of-order messages, drafts, DOM injection, completion, selector and inline SQL action. |
| Saved-output compatibility | `test/integrityFindings.test.ts`, `test/sqliteUntypedColumns.test.ts`, `test/xlsxWrite.test.ts`, existing format/stress cases | Existing precision, row-identity and publication guarantees retained; independent readers. |
| Runtime/release | `src/extension.ts`, `package.json`, `.github/workflows/*`, `.vscodeignore`; installed-host and package checks | Trust integration, dependency policy, executable security tests and artifact hygiene. |

Fuzz identifiers, values, quoting, message shapes and bounded workbook layouts with
fixed recorded seeds. Compare the SQL safety scanner with DuckDB statement parsing
where available; a scanner/parser disagreement is triaged rather than assumed safe.
Minimize failing inputs into permanent regressions. Run resource-hazard cases in
subprocesses with enforced time/RSS/disk budgets, never uncontrolled in the test host.

Proposed runnable entry points, to be added during implementation:

| Command | Purpose |
| --- | --- |
| `npm run typecheck` and `npm test` | Existing compile and regression gates. |
| `npm run test:security` | Deterministic policy, canary, runtime message and engine containment tests. |
| `npm run test:browser` | Real DOM, cross-document state, no-popup/data exposure and SQL workflows. |
| `npm run test:host` | Packaged extension activation, trust transitions, SQL and controls in VS Code. |
| `npm run test:fuzz -- --seed <seed>` | Bounded reproducible fuzz campaign; persist minimized failures only. |
| `npm run test:resources` | Isolated load, cancellation, parser limits and cleanup tests. |
| `npm run test:package` | Inspect the produced VSIX against file and synthetic-secret allow/deny rules. |

These new commands do not exist yet. Pin required browser/test dependencies and
fixtures in the project or documented test bootstrap; do not depend on packages
left in a developer's temporary directory. Keep test-only files out of the VSIX.

### Mandatory release gates

Critical/high confidentiality, unauthorized write/code execution, cross-document
leakage or preservation failures block release. Security tests skipped because a
fixture/listener/extension is unavailable count as **unexecuted**, not passed.
Require all feature-specific cases executed on release platforms. Existing known
cases must be individually triaged; a relevant known leak/corruption case cannot
be waived merely because it predates this feature.

Performance targets: publish cold/warm baselines on a recorded machine, then flag
more than 20% p95 latency or peak-RSS regression for investigation. With no valid
baseline, establish one before acceptance rather than claiming a pass. Resource
caps, cancellation deadlines and correct output are hard gates independently of
relative timing. Report passed, failed, skipped, TODO and unexecuted separately.

## 7. Delivery, rollback and unresolved design decisions

Deliver feature code, security controls, reproducible fixtures, traceability from
each test family to its tests/results, and a concise risk/compatibility report.
Document external SQL restrictions, trust behavior, query limits and sanitized
errors in README. Bump the version only with implemented, tested changes; push
to GitHub, verify CI/release assets, install and test the actual VSIX, then remove
task-owned obsolete builds and fixtures while preserving user data/backups.

Implementation review must settle the precise worker/connection ownership and
per-format approved-file policy before UI integration. Prefer secure defaults;
if a legacy workflow cannot fit them, document the incompatibility rather than
silently widening access. No broad application rewrite, upstream producer change
or third-party security service integration is authorized by this plan.

Rollback means an explicit recovery decision with the old version's known
limitations stated. Do not automatically downgrade from a security fix to a
version with the reproduced external-read gap. Keep user files and schema
unchanged so deployment rollback does not require data restoration.

**Current delivery remains this unified plan only.** No production security
setting, package version, installed extension or source dataset is changed here.

## References

- [DuckDB DATE literals](https://duckdb.org/docs/current/sql/data_types/date)
- [DuckDB explicit casting](https://duckdb.org/docs/current/sql/expressions/cast)
- [DuckDB comparison rules](https://duckdb.org/docs/current/sql/expressions/comparison_operators)
