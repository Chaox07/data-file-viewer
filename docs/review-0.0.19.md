# 0.0.19 regression review — 2026-09-24

Reviewed the local 0.0.19 working tree on `feat/sql-filtering-security`, based on
`ce7845b`, including the opening/editing optimizations and worksheet UI changes.
The earlier `review-handoff.md` describes the 0.0.16 checkpoint, not this result.

## Confirmed defects corrected

| Defect | Correction and regression |
| --- | --- |
| Fast ZIP preflight trusted central-directory metadata even when local compression differed or local members were omitted. This could bypass inflation/XML checks. | Require consistent, complete local/central layouts for the fast path. The fallback checks the same bytes that were hashed. Two hostile archive regressions in `xlsxBudget.test.ts`. |
| A local ZIP64 header could enter the narrow ZIP rewriter even when central-directory sizes fit in 32 bits, leaving stale ZIP64 fields after an edit. | Decline ZIP64 extras/sentinels and inconsistent descriptors; retain the existing fallback. Regression in `zipPatch.test.ts`. |
| Multiple queued jobs sharing one supersession predicate counted as one live job. | Give each queued job its own wrapper identity. Regression in `queryLifecycle.test.ts`. |
| Eager CSV caching began before native memory, thread and spill limits were applied. | Apply restricted-reader limits when creating the native instance. `openingLimits.test.ts` checks limits at cache creation and successful ordinary reads. |
| Lazy worksheet rows could come from replacement bytes with the original size/mtime, then supply wrong-row edit coordinates after the original file was restored. | Verify opening content hashes around cold worksheet/table preparation; invalidate the reader and its reusable decisions on mismatch. `editIntegrity.test.ts` reproduces the same-stamp replacement and verifies the original row identity. Host edit paths also remain host-owned when merging worker metadata. |

The content checks close the reproduced stale-cache defect. They are not an
immutable filesystem snapshot and do not claim protection against a privileged
process changing and restoring bytes within an individual native read.

## Current UI and test maintenance

- Browser and packaged-host tests now verify worksheet outlines and row numbers
  instead of waiting for the type display intentionally removed in 0.0.17.
- Browser coverage checks typed completion for a qualified table alias, draft
  preservation/restoration, detected-table SQL, exact date filtering, safe metadata
  rendering, and absence of the removed preview control.
- The text-decision cache fixture now supplies its actual opening SHA-256.
- The preservation comparison explicitly accommodates only the new `bounds`
  catalog field when comparing a baseline that predates it. Every previous catalog
  field and all data/edit snapshots remain compared; the baseline is not rewritten.
  Catalog and outline tests separately verify the new geometry.

## Validation

- `npm run typecheck`: passed.
- `npm test`: 800 tests, 796 passed, zero failed/skipped, four existing TODO cases.
- `npm run test:security`: 44 passed.
- `npm run test:browser`: SQL workflow and 200,000-point chart checks passed.
- `npm run test:fuzz -- --seed 20260924 --runs 20000`: six tests passed;
  zero scanner misses in 20,000 differential cases.
- `npm run test:resources`: eight passed, zero failed/skipped; 14-file
  preservation comparison passed with zero unexpected differences. Includes
  cancellation deadlines, archive/result budgets and 1,000 table switches.
- `npm run stress`: 277 passed, zero failed/skipped, four existing known cases.
- Built `/tmp/data-file-viewer-0.0.19-review.vsix`; package checks passed:
  1,488 files, 44,616,157 bytes, version 0.0.19.
- That package passed the SQL workflow in a disposable macOS VS Code profile,
  including the exact date boundary, 100 returned rows and unchanged source bytes.
  The normal installed extension was not overwritten.

A sequential profile run on a temporary copy of the 21,575,146-byte YieldCurve
workbook measured: open 247 ms, first worksheet use 1,651 ms, first table query
1,335 ms, warm query 6 ms, edit 1,223 ms, query after edit 3,448 ms. These are one-run
measurements, not a controlled before/after benchmark or a cross-machine guarantee.

After local review, publication was authorized on 2026-09-24. The reviewed
changes and README are being committed together; the superseded build clone is
archived before deletion. GitHub Actions provides platform validation for the
published commit. The local results above are macOS results.

The four existing known/TODO cases concern blank CSV files (two cases), quoted
empty CSV strings becoming null, and text edits in numeric XLSX columns reading
back as null. They remain unresolved; the passing totals do not imply otherwise.

## Publication checks

GitHub's Windows run additionally exposed a capped native stream retaining its
connection after document disposal, and concurrent Excel extension installation
colliding with a loaded DLL. Capped streams are now interrupted and finished;
existing extensions are loaded before attempting installation, with recovery
when another process wins the install race. Two extension-loading regressions
cover the latter behavior. The host test also waits for a browser context during
startup and stops its own VS Code process before closing CDP, keeping its hard
deadline active throughout teardown.

The obsolete `/private/tmp/dfv-build` clone was archived at
`archive/20260924-pre-review-build` (`b8893bf`). All 134 source files were SHA-256
verified against a fresh GitHub clone before both temporary clones were removed.
The current workspace remains `/Users/macc/Desktop/Kod/data-file-viewer`.
