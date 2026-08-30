import type { DuckDbFile } from '../../src/duckdbConnection';

/**
 * What a case claims should happen, and the registry of cases.
 *
 * Ported from etl_stress/expect.py. An Expectation is a small declarative
 * statement of the truth a case asserts, and `knownBug` pins a case that is
 * expected to fail today -- it still runs and is still reported, but it does
 * not count as a regression, and it turns into an XPASS the moment the defect
 * is fixed.
 *
 * The one structural difference from the Python original: an ETL case is
 * always "run the pipeline and compare the output", so its Expectation can be
 * purely declarative. Here the *interaction* varies by family -- shapes only
 * reads, roundtrip edits and reopens, damage expects a refusal -- so a Case
 * may carry a `check` that drives the file itself. The declarative part still
 * runs first and covers the common ground, which is how a new case gets the
 * silent-misread detector for free without writing any assertions.
 */

/** A table as the generator declared it, in getRowsJson() space. See inspect.ts. */
export interface CanonicalTable {
  columns: string[];
  rows: unknown[][];
}

export interface Expectation {
  /** The table the file should read back as. The generic silent-misread check. */
  table?: CanonicalTable;

  /** Column names that must be present, and ones that must not. */
  hasColumns?: readonly string[];
  lacksColumns?: readonly string[];

  /** Row count, when the case cares about the count but not the values. */
  rows?: number;

  /** Table names `listTables()` must report. */
  tables?: readonly string[];

  /**
   * The file must be REFUSED. The string or pattern must appear in the error.
   * A bare `true` accepts any refusal, but prefer naming the reason: "it threw"
   * passes just as well for a message that tells the user nothing.
   */
  refuses?: string | RegExp | true;

  /**
   * Warnings the user must be SHOWN -- openWarnings plus takeLateWarnings().
   * For the cases whose whole point is that something was said out loud. A
   * blanked #DIV/0! cell is indistinguishable from an empty cell in the grid;
   * the evidence the viewer behaved well is the value's absence PLUS a line
   * explaining it, and without this the absence alone looks identical to a bug.
   */
  says?: readonly (string | RegExp)[];

  /** Free text: what this input is and what should happen to it. */
  note: string;

  /** A defect this case documents but which is not fixed yet. */
  knownBug?: string;
}

/** What a generator hands back after writing its files. */
export interface BuildResult {
  /** The file to open. */
  path: string;
  /**
   * Overrides expect.table when the table is easier to compute than to declare
   * (a 1,000-column case should not spell its expectation out by hand).
   */
  table?: CanonicalTable;
  /** Which table to read; defaults to the first one listTables() reports. */
  tableName?: string;
}

export interface CaseContext {
  /** This case's own scratch directory, already emptied. */
  dir: string;
  /** Report a finding from inside a check. Severity ranks it in the report. */
  fail(severity: Severity, message: string): void;
}

/**
 * How quietly a thing went wrong, worst first -- the ranking etl_stress uses,
 * adapted to a viewer. The order matters: it is the report's sort key, and it
 * encodes that a wrong number shown confidently is worse than a crash.
 */
export type Severity =
  /** A save changed bytes it had no business touching. */
  | 'silent-corruption'
  /** The file opened, the grid drew, the values are wrong, nothing was said. */
  | 'silent-misread'
  /** Save reported success; the value is not there on reopen. */
  | 'lost-edit'
  | 'crash'
  | 'bad-message';

export const SEVERITY_ORDER: readonly Severity[] = [
  'silent-corruption',
  'silent-misread',
  'lost-edit',
  'crash',
  'bad-message',
];

export type BuildFn = (ctx: CaseContext) => Promise<BuildResult>;

/** Optional extra driving, for families the declarative part cannot express. */
export type CheckFn = (file: DuckDbFile, ctx: CaseContext, built: BuildResult) => Promise<void>;

export interface Case {
  name: string;
  family: string;
  expect: Expectation;
  build: BuildFn;
  check?: CheckFn;
  /**
   * Set when the case needs a file the Node writers cannot produce (Tier B) or
   * a DuckDB community extension. Returning a string means "skip, for this
   * reason" -- never a failure, so `npm test` stays green without Python.
   */
  skipIf?: () => Promise<string | undefined>;
}

export const REGISTRY = new Map<string, Case>();

export function registerCase(c: Case): void {
  if (REGISTRY.has(c.name)) {
    throw new Error(`duplicate stress case name: ${c.name}`);
  }
  REGISTRY.set(c.name, c);
}

export function allCases(opts: { family?: string; pattern?: string } = {}): Case[] {
  let out = [...REGISTRY.values()];
  if (opts.family) out = out.filter((c) => c.family === opts.family);
  if (opts.pattern) {
    const rx = new RegExp(opts.pattern, 'i');
    out = out.filter((c) => rx.test(c.name));
  }
  return out.sort((a, b) => a.family.localeCompare(b.family) || a.name.localeCompare(b.name));
}

export function families(): string[] {
  return [...new Set([...REGISTRY.values()].map((c) => c.family))].sort();
}
