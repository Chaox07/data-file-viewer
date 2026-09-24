import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateQueryMessage, validateTableFilters } from '../src/queryMessages';
import { QueryPolicyError } from '../src/queryPolicy';
import { DuckDbFile } from '../src/duckdbConnection';
import { xlsxFile } from './stress/generators/_write';

// SEC-14–20 and REL-01–12 of docs/sql-filtering-plan.md. Fuzz campaigns use a
// fixed, recorded seed so a failure reproduces; DFV_FUZZ_SEED / DFV_FUZZ_RUNS
// widen a campaign (npm run test:fuzz) without changing what CI runs.

const SEED = Number(process.env.DFV_FUZZ_SEED ?? 20260923);
const RUNS = Number(process.env.DFV_FUZZ_RUNS ?? 4000);

function rng(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const COMMANDS = ['ready', 'cancelQuery', 'diffQuery', 'queryCatalog', 'queryTarget', 'queryTargetSql', 'runQuery', 'sortQuery',
  'runCombinedQuery', 'toggleSafeMode', 'columnStats', 'toggleLiveRefresh', 'setLiveRefreshInterval', 'chartQuery',
  'sheetTableQuery', 'sheetTableStats', 'sheetTableChart', 'sheetTableSql', 'updateCell', 'unknown', '', 'constructor', '__proto__'];
const FIELDS = ['sql', 'column', 'direction', 'table', 'targetId', 'generation', 'requestId', 'cursor', 'limit', 'filters', 'sort',
  'safeMode', 'backupBeforeWrite', 'checkForChanges', 'statsKind', 'enabled', 'intervalMs', 'xColumn', 'xIsText', 'xIsCategory',
  'yColumns', 'rowValues', 'newValue', 'sheetPreview', '__proto__', 'constructor', 'prototype'];

function hostile(r: () => number, depth = 0): unknown {
  const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  switch (Math.floor(r() * (depth > 3 ? 8 : 11))) {
    case 0: return pick([null, undefined, true, false]);
    case 1: return pick([0, -0, -1, 1, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 2, 2 ** 64, 1e308]);
    case 2: return pick(['', ' ', 'select 1', 'asc', 'desc', 'numeric', 'gte', 'x"; drop table t; --', "'", '"', '\u0000', '<img src=x onerror=alert(1)>', 'é'.repeat(5000), 'x'.repeat(300_000)]);
    case 3: return pick(['equals', 'between', 'isBlank', 'contains', 'DROP', 'Date', '1990-01-01']);
    case 4: return Math.floor(r() * 1e6);
    case 5: return pick(COMMANDS);
    case 6: return String.fromCharCode(...Array.from({ length: Math.floor(r() * 40) }, () => Math.floor(r() * 0xFFFF)));
    case 7: return pick([[], {}, [[]], { __proto__: null }]);
    case 8: return Array.from({ length: Math.floor(r() * (r() < 0.05 ? 200 : 5)) }, () => hostile(r, depth + 1));
    case 9: {
      const o: Record<string, unknown> = {};
      for (let i = Math.floor(r() * 5); i > 0; i--) o[pick(['column', 'operator', 'value', 'valueTo', 'direction', 'extra', '__proto__'])] = hostile(r, depth + 1);
      return o;
    }
    default: return JSON.parse(`{"${pick(['a', '__proto__', 'constructor'])}": ${JSON.stringify(pick(['x', 1, null]))}}`);
  }
}

test('SEC-14–17: seeded message fuzz — every input is either a typed refusal or well-formed', () => {
  const r = rng(SEED);
  let accepted = 0;
  for (let run = 0; run < RUNS; run++) {
    const message: Record<string, unknown> = { command: COMMANDS[Math.floor(r() * COMMANDS.length)] };
    for (let i = Math.floor(r() * 6); i > 0; i--) message[FIELDS[Math.floor(r() * FIELDS.length)]] = hostile(r);
    let ok = false;
    try { validateQueryMessage(message); ok = true; } catch (error) {
      assert.ok(error instanceof QueryPolicyError, `seed ${SEED} run ${run}: non-policy failure ${String(error)} for ${JSON.stringify(message)?.slice(0, 300)}`);
    }
    if (!ok) continue;
    accepted++;
    // Anything accepted must satisfy the invariants consumers rely on.
    // Global keys are checked for every command; the others only where a consumer reads them.
    const numeric = ['requestId', 'generation',
      ...(message.command === 'queryCatalog' ? ['cursor'] : []),
      ...(['toggleLiveRefresh', 'setLiveRefreshInterval'].includes(message.command as string) ? ['intervalMs'] : [])];
    for (const key of numeric) {
      if (message[key] !== undefined) assert.ok(Number.isSafeInteger(message[key]), `${key} accepted as ${String(message[key])}`);
    }
    assert.ok(!Object.hasOwn(message, '__proto__') && !Object.hasOwn(message, 'constructor') && !Object.hasOwn(message, 'prototype'));
    // Only runQuery's handler reads `sql`; other commands ignore the field.
    if (message.command === 'runQuery') assert.ok(typeof message.sql === 'string' && Buffer.byteLength(message.sql) <= 256 * 1024);
    if (message.command === 'sortQuery') assert.ok(['asc', 'desc'].includes(String(message.direction)));
    if (message.command === 'chartQuery') assert.ok(Array.isArray(message.yColumns) && message.yColumns.every(v => typeof v === 'string'));
    if (message.command === 'updateCell' && message.newValue !== undefined) {
      assert.ok(message.newValue === null || ['string', 'boolean'].includes(typeof message.newValue) || Number.isFinite(message.newValue));
    }
  }
  assert.ok(accepted > 0, 'the fuzzer reached accepting paths too (not deny-everything)');
});

test('SEC-14–17: non-JSON transport values, cycles and depth bombs are typed refusals', () => {
  const cyclic: Record<string, unknown> = { command: 'ready' }; cyclic.self = cyclic;
  let deep: unknown = 'x'; for (let i = 0; i < 20000; i++) deep = [deep];
  for (const message of [cyclic, { command: 'ready', big: 10n }, { command: 'sheetTableQuery', table: 't', filters: deep, limit: 1 }, { command: 'sheetTableQuery', table: 't', filters: [deep], limit: 1 },
    { command: 'queryTarget', targetId: 'x'.repeat(129), generation: 1 }, { command: 'ready', requestId: 0 },
    { command: 'ready', requestId: 1.5 }, { command: 'ready', generation: -0.5 },
    { command: 'updateCell', column: 'a', rowValues: { a: NaN }, newValue: 1 },
    { command: 'updateCell', column: 'a', rowValues: {}, newValue: Infinity },
    { command: 'updateCell', column: 'a', rowValues: Object.fromEntries(Array.from({ length: 10001 }, (_, i) => [`c${i}`, 1])), newValue: 1 },
    { command: 'chartQuery', xColumn: 'x', xIsText: false, yColumns: Array(101).fill('y') },
    { command: 'columnStats', column: 'x', statsKind: 'numeric', limit: 1001 },
    { command: 'setLiveRefreshInterval', intervalMs: 249 },
  ]) assert.throws(() => validateQueryMessage(message), QueryPolicyError);
  validateQueryMessage({ command: 'ready', requestId: 1, generation: 0 });
  validateQueryMessage({ command: 'updateCell', column: 'a', rowValues: { a: 1, b: null, c: 'x' }, newValue: false });
});

test('SEC-17: filter and sort objects accept exactly their own keys', () => {
  const ok = { column: 'a', operator: 'equals', value: 'x' };
  validateTableFilters([ok], undefined, 0);
  for (const bad of [
    [{ ...ok, extra: 1 }], [JSON.parse('{"column":"a","operator":"equals","__proto__":{"value":"x"}}')],
    [{ ...ok, operator: 'toString' }], [{ ...ok, operator: 'constructor' }], [{ ...ok, value: 1 }], [{ ...ok, column: ['a'] }],
    [null], ['a'], [[ok]],
  ]) assert.throws(() => validateTableFilters(bad, undefined, 0), QueryPolicyError);
  assert.throws(() => validateTableFilters([ok], { column: 'a', direction: 'asc', x: 1 }, 0), QueryPolicyError);
  assert.throws(() => validateTableFilters([ok], ['a', 'asc'], 0), QueryPolicyError);
});

/** Sheets are prepared lazily; asking for the raw sheet's columns prepares it. */
async function detected(file: DuckDbFile, sheet: string) {
  const raw = (await file.getQueryCatalog()).find(r => r.name === sheet);
  assert.ok(raw, `sheet ${sheet} listed`);
  await file.getQueryColumns(raw.catalog, raw.schema, raw.name);
  return file.getDetectedSheetTables(sheet)[0];
}

// Hostile but legal worksheet headers and values. Each must round-trip as data.
const HOSTILE_HEADERS = ['Date', 'a"b', "it's", '); drop table x; --', '<img src=x onerror=alert(1)>', 'İstanbul ü', 'SELECT', 'x y'];
const HOSTILE_VALUES = [`O'Brien"; --`, '<script>alert(1)</script>', '%_\\', "'); copy t to 'x'; --", 'İ', ''];

test('SEC-18–20 / REL-09–12: hostile names and values keep exact semantics through filter, sort and SQL handoff', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dfv-hostile-'));
  let file: DuckDbFile | undefined;
  try {
    const rows: unknown[][] = [HOSTILE_HEADERS];
    HOSTILE_VALUES.forEach((v, i) => rows.push([`2020-01-0${i + 1}`, v, i, v, v, v, i * 10, v]));
    const path = await xlsxFile(join(dir, 'hostile.xlsx'), [{ name: "Sheet 'q\"", rows }]);
    const before = await readFile(path);
    file = await DuckDbFile.open(path, undefined, { restrictedReads: true });
    const table = await detected(file, "Sheet 'q\"");
    assert.ok(table, 'detected table exists');
    assert.deepEqual(table.columns, HOSTILE_HEADERS);
    for (const header of HOSTILE_HEADERS.slice(1)) {
      for (const [i, value] of HOSTILE_VALUES.entries()) {
        if (value === '' || header === "it's" || header === 'SELECT') continue; // numeric columns
        const sql = await file.buildDetectedTableQuery(table.name, [{ column: header, operator: 'equals', value }], { column: header, direction: 'desc' }, 100);
        const result = await file.runQuery(sql);
        const at = result.columns.indexOf(header);
        assert.ok(at >= 0, `column ${header} present`);
        assert.deepEqual(result.rows.map(row => String(row[at])), [value], `exact match for ${header} = ${value} (row ${i})`);
        // The generated SQL is itself valid restricted user SQL (the handoff).
        assert.equal(await file.countMatchingRows(sql), 1);
      }
    }
    // contains uses literal matching, not LIKE wildcards.
    const pct = await file.buildDetectedTableQuery(table.name, [{ column: 'a"b', operator: 'contains', value: '%_' }], undefined, 0);
    assert.equal((await file.runQuery(pct)).rows.length, 1);
    await assert.rejects(file.buildDetectedTableQuery(table.name, [{ column: 'missing"; --', operator: 'equals', value: 'x' }]), /does not exist/);
    await assert.rejects(file.buildDetectedTableQuery(table.name, [], { column: 'nope', direction: 'asc' }), /does not exist/);
    // Round trip: sort + limit + projection + CTE + join over the handed-off SQL.
    const base = await file.buildDetectedTableQuery(table.name, [], { column: 'SELECT', direction: 'asc' }, 3);
    const quoted = `"${table.name.replace(/"/g, '""')}"`;
    for (const sql of [base, `select "a""b" as v from (${base}) t`, `with t as (${base}) select count(*) from t`,
      `select a."x y" from ${quoted} a join ${quoted} b on a."SELECT" = b."SELECT" order by 1 limit 2 offset 1`]) {
      assert.ok((await file.runQuery(sql)).rows.length > 0, sql);
    }
    file.dispose(); file = undefined;
    assert.deepEqual(await readFile(path), before, 'read-only workflow leaves the workbook bytes unchanged');
  } finally { file?.dispose(); await rm(dir, { recursive: true, force: true }); }
});

test('REL-01–04: date/type matrix — explicit errors, never silent conversion', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dfv-types-'));
  let file: DuckDbFile | undefined;
  try {
    const path = await xlsxFile(join(dir, 'types.xlsx'), [{ name: 'T', rows: [
      ['Text date', 'Year', 'Mixed', 'Amount'],
      ['1989-12-31', 1989, '1990Q1', 1.5],
      ['1990-01-01', 1990, '1990-02', -0.000001],
      [null, null, 'blank row stays inside the table', null],
      ['1990-06-30', 1991, 'not a date', 1e15],
    ] }]);
    file = await DuckDbFile.open(path, undefined, { restrictedReads: true });
    const table = await detected(file, 'T');
    assert.ok(table);
    const q = async (column: string, operator: string, value: string, valueTo?: string) =>
      (await file!.runQuery(await file!.buildDetectedTableQuery(table.name, [{ column, operator: operator as 'gte', value, valueTo }]))).rows.length;
    assert.equal(await q('Year', 'gte', '1990'), 2, 'numeric year boundary');
    assert.equal(await q('Year', 'between', '1989', '1990'), 2);
    assert.equal(await q('Text date', 'gte', '1990-01-01'), 2, 'ISO text/date boundary is inclusive and excludes NULL');
    assert.equal(await q('Text date', 'lt', '1990-01-01'), 1);
    assert.equal(await q('Amount', 'lt', '0'), 1, 'precision extreme kept');
    assert.equal(await q('Amount', 'gt', '999999999999999'), 1);
    assert.equal(await q('Mixed', 'equals', 'not a date'), 1, 'mixed period labels are text, compared exactly');
    // Typed filters on a typed column refuse text rather than dropping rows.
    await assert.rejects(file.buildDetectedTableQuery(table.name, [{ column: 'Year', operator: 'gte', value: 'nineteen ninety' }]).then(sql => file!.runQuery(sql)));
    // User SQL with the classic wrong predicate is an explicit error, and is not rewritten.
    await assert.rejects(file.runQuery(`select * from "${table.name.replace(/"/g, '""')}" where "Text date" >= 1990`));
  } finally { file?.dispose(); await rm(dir, { recursive: true, force: true }); }
});
