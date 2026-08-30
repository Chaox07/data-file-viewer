import { DuckDbFile } from '../../../src/duckdbConnection';
import { caseDir } from '../paths';
import type { Case, CaseContext, Severity } from '../expect';
import { compareTables, readTable } from './inspect';

export interface Finding {
  severity: Severity;
  message: string;
}

export type Status = 'pass' | 'fail' | 'skip' | 'xfail' | 'xpass';

export interface Outcome {
  name: string;
  family: string;
  status: Status;
  findings: Finding[];
  note: string;
  knownBug?: string;
  skipReason?: string;
  ms: number;
}

/**
 * Run one case: build its input, drive the viewer at it, and collect findings.
 *
 * The declarative half of the Expectation runs first and gives every case the
 * silent-misread detector for free -- what the generator said it wrote has to
 * be what comes back. A `check` then adds whatever that cannot express.
 *
 * Findings are collected rather than thrown. A case that gets three things
 * wrong should report three things: stopping at the first is how a suite ends
 * up being fixed one assertion at a time across three runs.
 */
export async function runCase(c: Case): Promise<Outcome> {
  const started = Date.now();
  const findings: Finding[] = [];
  const finish = (status: Status, skipReason?: string): Outcome => ({
    name: c.name,
    family: c.family,
    status,
    findings,
    note: c.expect.note,
    knownBug: c.expect.knownBug,
    skipReason,
    ms: Date.now() - started,
  });

  const skip = await c.skipIf?.();
  if (skip) return finish('skip', skip);

  const ctx: CaseContext = {
    dir: await caseDir(c.name),
    fail: (severity, message) => findings.push({ severity, message }),
  };

  let built;
  try {
    built = await c.build(ctx);
  } catch (err) {
    findings.push({ severity: 'crash', message: `the generator itself failed: ${describe(err)}` });
    return settle(finish, findings, c);
  }

  // A refusal case has to be driven through open AND read. For the flat kinds
  // `open()` only creates a view, and DuckDB does not touch the file to do
  // that, so a damaged file routinely opens clean and fails on first query.
  // Asserting on open alone would pass for the wrong reason.
  let file: DuckDbFile | undefined;
  try {
    file = await DuckDbFile.open(built.path);
    const table = await readTable(file, built.tableName);

    if (c.expect.refuses) {
      findings.push({
        severity: 'silent-misread',
        message:
          `expected this file to be refused, but it opened and returned ` +
          `${table.rows.length} row(s) over [${table.columns.join(', ')}]`,
      });
    } else {
      await applyExpectations(c, file, built, table, findings);
      if (c.check) await c.check(file, ctx, built);
    }
  } catch (err) {
    const message = describe(err);
    if (c.expect.refuses) {
      const pattern = c.expect.refuses;
      const matched =
        pattern === true
          ? true
          : pattern instanceof RegExp
            ? pattern.test(message)
            : message.toLowerCase().includes(pattern.toLowerCase());
      if (!matched) {
        findings.push({
          severity: 'bad-message',
          message: `refused, but for the wrong reason: expected ${String(pattern)}, got "${message}"`,
        });
      }
    } else if (!c.expect.mayRefuse) {
      findings.push({ severity: 'crash', message });
    }
    // mayRefuse: a refusal is one of the two acceptable outcomes, so there is
    // nothing to report. The other outcome is checked above, on the path where
    // the file actually opened.
  } finally {
    // Guarded: the roundtrip family has to close the file before reopening it
    // (a .duckdb holds a write lock), so by the time the runner gets here the
    // handle is often already closed. A throw out of teardown would report as
    // a crash in whichever case ran next.
    try {
      file?.dispose();
    } catch {
      /* already closed by the check */
    }
  }

  return settle(finish, findings, c);
}

async function applyExpectations(
  c: Case,
  file: DuckDbFile,
  built: { table?: { columns: string[]; rows: unknown[][] } },
  table: { columns: string[]; rows: unknown[][] },
  findings: Finding[]
): Promise<void> {
  const expected = built.table ?? c.expect.table;
  if (expected) {
    for (const diff of compareTables(expected, table)) {
      findings.push({ severity: 'silent-misread', message: diff });
    }
  }

  if (c.expect.rows !== undefined && table.rows.length !== c.expect.rows) {
    findings.push({
      severity: 'silent-misread',
      message: `expected ${c.expect.rows} row(s), read back ${table.rows.length}`,
    });
  }

  for (const name of c.expect.hasColumns ?? []) {
    if (!table.columns.includes(name)) {
      findings.push({ severity: 'silent-misread', message: `column "${name}" is missing` });
    }
  }
  for (const name of c.expect.lacksColumns ?? []) {
    if (table.columns.includes(name)) {
      findings.push({ severity: 'silent-misread', message: `column "${name}" should not be here` });
    }
  }

  if (c.expect.tables) {
    const actual = await file.listTables();
    const missing = c.expect.tables.filter((t) => !actual.includes(t));
    const extra = actual.filter((t) => !c.expect.tables!.includes(t));
    if (missing.length || extra.length) {
      findings.push({
        severity: 'silent-misread',
        message: `tables: expected [${c.expect.tables.join(', ')}], got [${actual.join(', ')}]`,
      });
    }
  }

  // Warnings are drained here rather than asserted per-check, because
  // takeLateWarnings empties the list -- reading it twice loses it.
  if (c.expect.says?.length) {
    const said = [...file.openWarnings, ...file.takeLateWarnings()];
    for (const want of c.expect.says) {
      const matched = said.some((line) =>
        want instanceof RegExp ? want.test(line) : line.toLowerCase().includes(want.toLowerCase())
      );
      if (!matched) {
        findings.push({
          severity: 'silent-misread',
          message: `nothing told the user about ${String(want)}; it said: ${said.length ? said.join(' | ') : '(nothing)'}`,
        });
      }
    }
  }
}

/** knownBug turns a failure into an xfail, and a clean run into an xpass. */
function settle(
  finish: (status: Status, skipReason?: string) => Outcome,
  findings: Finding[],
  c: Case
): Outcome {
  if (c.expect.knownBug) return finish(findings.length ? 'xfail' : 'xpass');
  return finish(findings.length ? 'fail' : 'pass');
}

export function describe(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.split('\n')[0].trim();
}

export async function runCases(
  cases: Case[],
  onProgress?: (outcome: Outcome) => void
): Promise<Outcome[]> {
  const out: Outcome[] = [];
  // Serial on purpose. Several families open the same file from two
  // connections or race a save against a refresh, and a parallel runner would
  // turn those into flakes that look like the very bugs being hunted.
  for (const c of cases) {
    const outcome = await runCase(c);
    out.push(outcome);
    onProgress?.(outcome);
  }
  return out;
}
