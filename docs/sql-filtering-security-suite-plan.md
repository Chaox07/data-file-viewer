# SQL filtering: security, reliability and full test-suite plan

Date: 2026-09-23. Application baseline: 0.0.13 (`46ae830`).
Functional plan: [SQL filtering and detected Excel tables](sql-filtering-plan.md).

**Planning only.** This document specifies proposed changes and acceptance tests.
It does not implement containment or certify the current extension as secure.
The functional and security plans form one delivery scope.

## 1. Findings and evidence limits

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

## 2. Threat model and security contract

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

## 3. Required controls

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

## 4. Full suite: tests and observable outcomes

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

## 5. Test layers and files

| Layer | Proposed implementation/test locations | Execution scope |
| --- | --- | --- |
| Policy/validation | new `src/queryPolicy.ts`, `src/queryMessages.ts`; corresponding unit tests; existing `src/sqlSafety.ts` / `test/sqlSafety.test.ts` | Fast deterministic validation, scanner/parser differential cases and policy decisions. |
| Query ownership/isolation | `src/duckdbConnection.ts`, `src/duckdbEditorProvider.ts`; query worker module if prototype confirms its interface | Real DuckDB/Excel integration, external-access canaries, timeouts, trusted setup and teardown. |
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

## 6. Execution phases and gates

1. **Baseline and threat verification:** reproduce F-01 and the functional errors;
   enumerate all execution sinks and establish canary/egress observations. Record
   exact dependency versions, existing skips/TODOs and fresh connection settings.
2. **Containment prototype:** establish source-scoped execution, trusted format
   setup and worker lifecycle. Prove external denial plus successful local reads
   on DuckDB and Excel before building the new UI. Reject designs that depend
   solely on SQL text scanning or a trusted webview.
3. **Validated catalog and handoff:** add runtime message schemas, relation IDs,
   generations, safe SQL generation and bounded discovery. Then add controls,
   completion, drafts and sanitized diagnostics from the functional plan.
4. **Reliability and preservation:** complete race, cancellation, load and independent
   output checks. Resolve shared-path defects exposed by the addition.
5. **Release acceptance:** typecheck and complete suite; security/containment and
   browser jobs on every relevant PR; macOS/Windows installed-host tests. Broader
   seeded fuzz/load runs nightly and before release; failures attach only sanitized
   minimal fixtures, metrics and seeds. A scheduled run must not substitute for
   a missing pre-release gate.

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

## 7. Delivery, rollback and remaining decisions

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

**Current delivery remains these planning documents only.** No production security
setting, package version, installed extension or source dataset is changed here.
