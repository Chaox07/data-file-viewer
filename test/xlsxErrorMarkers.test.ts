import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DuckDbFile } from '../src/duckdbConnection';
import { xlsxFile } from './stress/generators/_write';

/**
 * End-to-end, against real workbooks and the real DuckDB.
 *
 * textColumns.test.ts covers the decision in isolation; this covers what the
 * user sees, which is the part that was wrong: a column of numbers with `NA`
 * in it typed as text and vanished from the chart's column picker without a
 * word. See interpretTextColumns in duckdbConnection.ts.
 */

function scratchDir(): string {
  return mkdtempSync(join(tmpdir(), 'markers-'));
}

async function openSheet(
  rows: unknown[][],
  options?: { nullText?: readonly string[] }
): Promise<{ file: DuckDbFile; dir: string }> {
  const dir = scratchDir();
  const path = await xlsxFile(join(dir, 'book.xlsx'), [{ name: 'data', rows }]);
  const file = await DuckDbFile.open(path, undefined, options);
  return { file, dir };
}

/**
 * The object these tests are about: the TABLE detected inside the sheet.
 *
 * The sheet's own object is verbatim -- every row and column as the file holds
 * them, all text, columns named after their Excel letters -- so a question
 * about column TYPES cannot be asked of it. `NA` becoming a null in a numeric
 * column is a property of the table read out of the sheet, which is also the
 * object the chart plots, which is where the defect that prompted all this
 * showed up.
 *
 * Querying the sheet is what makes it find its tables; detection is deferred
 * until first use.
 */
const drained = new WeakMap<DuckDbFile, string[]>();

/**
 * Everything the file has told the user, from both channels.
 *
 * Interpreting a sheet's columns happens when the sheet is first USED, not when
 * the workbook opens -- reading every sheet of a workbook to open one of them is
 * what made opening slow -- so these notices arrive on the late channel rather
 * than in `openWarnings`. `takeLateWarnings` empties as it reads, so what it
 * gives back is accumulated here and a test may ask more than once.
 */
function noticesOf(file: DuckDbFile): string[] {
  const seen = drained.get(file) ?? [];
  seen.push(...file.takeLateWarnings());
  drained.set(file, seen);
  return [...file.openWarnings, ...seen];
}

async function tableOf(file: DuckDbFile, sheet = 'data'): Promise<string> {
  await file.runQuery(`select * from "${sheet}" limit 1`);
  const found = (await file.listTables()).find((t) => t.startsWith(`${sheet} \u00b7 Table `));
  assert.ok(found, `no table was detected inside sheet "${sheet}"`);
  return found;
}

/**
 * Numeric rows with the markers placed wherever the caller asks.
 *
 * One decimal place, deliberately. "1.001" is genuinely ambiguous — 1001 read
 * as Turkish, 1.001 read as English — so a column of those is refused by W1's
 * arbitration before this module's question is even reached. Correct, but it
 * would test the wrong refusal.
 */
function seriesWithMarkers(total: number, markerRows: (i: number) => boolean, note?: [number, string]) {
  const rows: unknown[][] = [['id', 'ratio']];
  for (let i = 0; i < total; i++) {
    rows.push([i, markerRows(i) ? 'NA' : String((i + 1) * 0.5)]);
  }
  if (note) rows[note[0] + 1][1] = note[1];
  return rows;
}

test('a numeric column with NA in it becomes numeric, and the NA cells become empty', async () => {
  const { file, dir } = await openSheet([
    ['id', 'ratio'],
    [1, 'NA'],
    [2, '1.5'],
    [3, '#N/A'],
    [4, '2.5'],
  ]);
  try {
    const r = await file.runQuery(`select * from "${await tableOf(file)}"`);
    assert.equal(r.columnStatsKind[1], 'numeric', 'the column must be plottable');
    assert.deepEqual(
      r.rows.map((row) => row[1]),
      [null, 1.5, null, 2.5]
    );
    assert.ok(
      noticesOf(file).some((w) => /read as numbers/.test(w) && /2 Excel error markers/.test(w)),
      `the count is the evidence; got: ${noticesOf(file).join(' | ')}`
    );
  } finally {
    await file.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('no row is lost — the count is the same before and after', async () => {
  const { file, dir } = await openSheet([
    ['id', 'ratio'],
    [1, 'NA'],
    [2, '1.5'],
    [3, '#N/A'],
    [4, '2.5'],
  ]);
  try {
    const r = await file.runQuery(`select count(*) as n from "${await tableOf(file)}"`);
    assert.equal(Number(r.rows[0][0]), 4);
  } finally {
    await file.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a column whose FIRST 2,000 rows are all markers still converts', async () => {
  // The head of a time series is the least representative part of it. Measured
  // on YieldCurve_Data.xlsx: its long-maturity columns are "NA" for the first
  // 3,274 rows because those maturities did not exist in 1961, and a `limit
  // 2000` sample concluded "nothing but markers" for all 70 of them.
  const { file, dir } = await openSheet(seriesWithMarkers(3000, (i) => i < 2500));
  try {
    const r = await file.runQuery(`select * from "${await tableOf(file)}" limit 1`);
    assert.equal(r.columnStatsKind[1], 'numeric');
    const counts = await file.runQuery(
      `select count(*) as n, count("ratio") as filled from "${await tableOf(file)}"`
    );
    assert.equal(Number(counts.rows[0][0]), 3000);
    assert.equal(Number(counts.rows[0][1]), 500);
  } finally {
    await file.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('one written note far past the sample keeps the whole column as text', async () => {
  // The sample cannot see row 2,800, so this is the whole-column check doing
  // the work. Converted, that note would have become NULL and been
  // indistinguishable from the markers.
  const { file, dir } = await openSheet(
    seriesWithMarkers(3000, (i) => i % 7 === 0, [2800, 'under review'])
  );
  try {
    const r = await file.runQuery(`select * from "${await tableOf(file)}" limit 1`);
    assert.equal(r.columnStatsKind[1], 'other', 'the column must keep its text');
    const kept = await file.runQuery(`select count(*) as n from "${await tableOf(file)}" where "ratio" = 'under review'`);
    assert.equal(Number(kept.rows[0][0]), 1, 'the note itself must survive');
    assert.ok(
      noticesOf(file).some((w) => /"ratio" was left as text/.test(w)),
      `the refusal must be said out loud; got: ${noticesOf(file).join(' | ')}`
    );
  } finally {
    await file.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('nullText: [] reads the file literally', async () => {
  const { file, dir } = await openSheet(
    [
      ['id', 'ratio'],
      [1, 'NA'],
      [2, '1.5'],
    ],
    { nullText: [] }
  );
  try {
    const r = await file.runQuery(`select * from "${await tableOf(file)}"`);
    assert.deepEqual(
      r.rows.map((row) => row[1]),
      ['NA', '1.5']
    );
    assert.equal(noticesOf(file).length, 0, 'nothing was interpreted, so there is nothing to report');
  } finally {
    await file.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a workbook with no markers is untouched and says nothing', async () => {
  const { file, dir } = await openSheet([
    ['id', 'label'],
    [1, 'alpha'],
    [2, 'beta'],
  ]);
  try {
    const r = await file.runQuery(`select * from "${await tableOf(file)}"`);
    assert.deepEqual(
      r.rows.map((row) => row[1]),
      ['alpha', 'beta']
    );
    assert.equal(r.columnStatsKind[1], 'other');
    assert.equal(noticesOf(file).length, 0);
  } finally {
    await file.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a column of nothing but markers empties but keeps its type', async () => {
  const { file, dir } = await openSheet([
    ['id', 'ratio'],
    [1, 'NA'],
    [2, '#N/A'],
  ]);
  try {
    const r = await file.runQuery(`select * from "${await tableOf(file)}"`);
    assert.deepEqual(
      r.rows.map((row) => row[1]),
      [null, null]
    );
    assert.ok(
      noticesOf(file).some((w) => /nothing but error markers/.test(w)),
      `got: ${noticesOf(file).join(' | ')}`
    );
  } finally {
    await file.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a sheet whose header is not row 1 opens at its own first column, with no phantom', async () => {
  // Anchoring the range at "A" instead of the sheet's declared first column
  // gave every shaped sheet a leading all-NULL column called C0.
  const dir = scratchDir();
  const path = await xlsxFile(join(dir, 'book.xlsx'), [
    {
      name: 'data',
      leadingBlankColumns: 1,
      rows: [
        ['Some workbook', null, null],
        [null, null, null],
        ['Date', 'a', 'b'],
        ['2020-01-01', 1, 2],
        ['2020-01-02', 3, 4],
      ],
    },
  ]);
  const file = await DuckDbFile.open(path);
  try {
    const r = await file.runQuery(`select * from "${await tableOf(file)}"`);
    assert.deepEqual(r.columns, ['Date', 'a', 'b']);
    assert.equal(r.rows.length, 2);
  } finally {
    await file.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the text-column probe split across side connections decides exactly as one query does', async () => {
  const { PROBE_SPLIT, probeGroups } = await import('../src/duckdbConnection');
  assert.deepEqual(probeGroups([1, 2, 3], 4, 16), [[1, 2, 3]], 'too little to split');
  assert.deepEqual(probeGroups(Array.from({ length: 66 }, (_, i) => i), 4, 16).map(g => g.length), [17, 17, 16, 16]);
  assert.deepEqual(probeGroups(Array.from({ length: 66 }, (_, i) => i), 4, 16).flat(), Array.from({ length: 66 }, (_, i) => i));

  const dir = scratchDir();
  try {
    // 30 columns of every kind the probe decides between, 3,000 rows so the
    // sample (2,000) does not see everything.
    const kinds = [
      (r: number) => (r % 97 === 0 ? '#N/A' : String(r * 1.25)),              // numeric with markers
      (r: number) => (r % 50 === 0 ? '#DIV/0!' : String(r)),                  // integral with markers
      (r: number) => (r === 2900 ? 'see note' : r % 40 === 0 ? '#N/A' : String(r)), // note past the sample
      (r: number) => (r % 3 === 0 ? '#N/A' : '#VALUE!'),                        // markers only
      (r: number) => (r === 2999 ? '5' : '#N/A'),                               // markers only in the sample
      (r: number) => (r % 30 === 0 ? '#N/A' : `00${r}`),                        // leading zeros
      (r: number) => (r % 30 === 0 ? '#N/A' : `${r}00000000000000000000`),      // wider than bigint
      (r: number) => `name ${r}`,                                               // text
      (r: number) => (r % 25 === 0 ? '#REF!' : `${r},5`),                       // decimal comma
      (r: number) => (r % 25 === 0 ? '#NUM!' : `1${'0'.repeat(40)}${r}`),       // wider than hugeint
    ];
    const header = Array.from({ length: 30 }, (_, c) => `c${c}`);
    const rows = [header, ...Array.from({ length: 3000 }, (_, r) => header.map((_, c) => kinds[c % kinds.length](r + c)))];
    const xlsx = await xlsxFile(join(dir, 'book.xlsx'), [{ name: 'data', rows }]);
    const csv = join(dir, 'book.csv');
    require('node:fs').writeFileSync(csv, rows.map(r => r.map(v => `"${v}"`).join(',')).join('\n') + '\n');

    const observe = async (path: string, restrictedReads: boolean) => {
      const file = await DuckDbFile.open(path, undefined, { restrictedReads, forceReadOnly: true });
      try {
        const out: Record<string, unknown> = { open: [...file.openWarnings] };
        for (const table of await file.listTables()) {
          await file.runQuery(`select * from "${table}" limit 0`);
          for (const name of [table, ...file.getDetectedSheetTables(table).map(t => t.name)]) {
            const result = await file.runQuery(`select * from "${name.replace(/"/g, '""')}"`);
            out[name] = { columns: result.columns, types: result.columnStatsKind, rows: JSON.stringify(result.rows, (_k, v) => typeof v === 'bigint' ? `${v}n` : v) };
          }
        }
        out.late = file.takeLateWarnings();
        return out;
      } finally { file.dispose(); }
    };
    const automatic = PROBE_SPLIT.maxGroups;
    for (const path of [xlsx, csv]) {
      for (const restricted of [false, true]) {
        PROBE_SPLIT.maxGroups = Math.max(4, automatic);
        const split = await observe(path, restricted);
        PROBE_SPLIT.maxGroups = 1;
        const single = await observe(path, restricted);
        PROBE_SPLIT.maxGroups = automatic;
        assert.deepEqual(split, single, `${path} restricted=${restricted}`);
        assert.ok(JSON.stringify(single).includes('read as numbers'), 'the probe did convert columns');
      }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('text-column decisions reused by a restarted reader give exactly the cold result, and bad ones are ignored', async () => {
  const { textDecisionsOf } = await import('../src/duckdbConnection');
  const { DuckDBConnection } = await import('@duckdb/node-api');
  const dir = scratchDir();
  const seen: string[] = [];
  const original = DuckDBConnection.prototype.runAndReadAll;
  DuckDBConnection.prototype.runAndReadAll = function (this: InstanceType<typeof DuckDBConnection>, sql: string, ...rest: unknown[]) {
    seen.push(sql);
    return (original as (...a: unknown[]) => ReturnType<typeof original>).call(this, sql, ...rest);
  } as typeof original;
  try {
    const rows = [['notes'], [], ['id', 'amount', 'marks', 'label', 'code'],
      ...Array.from({ length: 300 }, (_, r) => [r, r % 7 === 0 ? '#N/A' : String(r * 1.5), '#N/A', `x${r}`, r % 9 === 0 ? '#REF!' : `00${r}`])];
    const path = await xlsxFile(join(dir, 'book.xlsx'), [{ name: 'data', rows }]);
    const observe = async (textDecisions?: unknown) => {
      const file = await DuckDbFile.open(path, undefined, { restrictedReads: true, forceReadOnly: true, openedSha256: 'bytes-1', textDecisions: textDecisions as never });
      try {
        await file.runQuery('select * from "data" limit 0');
        const table = file.getDetectedSheetTables('data')[0].name;
        seen.length = 0;
        const result = await file.runQuery(`select * from "${table}"`);
        const sampled = seen.some(sql => /using sample reservoir/.test(sql));
        return { table, sampled, decisions: textDecisionsOf(file),
          observed: { columns: result.columns, kinds: result.columnStatsKind, rows: JSON.stringify(result.rows, (_k, v) => typeof v === 'bigint' ? `${v}n` : v), late: file.takeLateWarnings() } };
      } finally { file.dispose(); }
    };
    const cold = await observe();
    assert.equal(cold.sampled, true);
    assert.ok(cold.decisions && cold.decisions.sha256 === 'bytes-1');
    assert.ok(JSON.stringify(cold.observed.late).includes('read as numbers'), 'the table was interpreted');

    const warm = await observe(cold.decisions);
    assert.equal(warm.sampled, false, 'the restarted reader skipped the sample and probe');
    assert.deepEqual(warm.observed, cold.observed);

    const decision = cold.decisions!.tables[cold.table] as { converted: { column: string; target: string }[]; columns: string[] };
    const tamper = (change: (d: any) => void) => {
      const copy = structuredClone(cold.decisions!);
      change(copy.tables[cold.table]);
      return copy;
    };
    for (const [why, cache] of [
      ['other bytes', { ...cold.decisions!, sha256: 'bytes-2' }],
      ['unknown target', tamper(d => { d.converted[0].target = 'varchar); drop table x; --'; })],
      ['unknown column', tamper(d => { d.converted[0].column = 'nope'; })],
      ['other shape', tamper(d => { d.columns = [...d.columns].reverse(); })],
      ['other markers', tamper(d => { d.tokens = ['#N/A']; })],
      ['duplicate column', tamper(d => { d.blanked = [d.converted[0].column]; })],
      ['not an object', { sha256: 'bytes-1', tables: { [cold.table]: 'x' } }],
    ] as const) {
      const result = await observe(cache);
      assert.equal(result.sampled, true, `${why}: ignored, so the reader decided again`);
      assert.deepEqual(result.observed, cold.observed, why);
    }
    assert.ok(decision.converted.length > 0);
  } finally {
    DuckDBConnection.prototype.runAndReadAll = original;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ViewerFile hands a restarted reader its decisions only for unchanged bytes, and forgets them on close', async () => {
  const { ViewerFile } = await import('../src/viewerFile');
  const dir = scratchDir();
  try {
    const rows = [['id', 'amount'], ...Array.from({ length: 200 }, (_, r) => [r, r % 5 === 0 ? '#N/A' : String(r / 4)])];
    const path = await xlsxFile(join(dir, 'book.xlsx'), [{ name: 'data', rows }]);
    const file = await ViewerFile.open(path);
    try {
      await file.runQuery('select * from "data" limit 0');
      const table = file.getDetectedSheetTables('data')[0].name;
      const first = await file.runQuery(`select * from "${table}"`);
      const cache = () => (file as unknown as { textDecisions?: { tables: Record<string, unknown> } }).textDecisions;
      assert.ok(cache()?.tables[table], 'the host holds the decision');
      file.interruptCurrentQuery();
      await file.runQuery('select * from "data" limit 0');
      const again = await file.runQuery(`select * from "${table}"`);
      assert.deepEqual(JSON.stringify(again, (_k, v) => typeof v === 'bigint' ? `${v}n` : v), JSON.stringify(first, (_k, v) => typeof v === 'bigint' ? `${v}n` : v));
      await file.refreshInPlace();
      assert.deepEqual((await file.runQuery(`select * from "${table}"`)).rows.length, first.rows.length);
      file.dispose();
      assert.equal(cache(), undefined, 'closing the tab drops the cache');
    } finally { file.dispose(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
