import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { ViewerFile } from '../../src/viewerFile';
import { DuckDbFile } from '../../src/duckdbConnection';
import { preflightWorkbook } from '../../src/xlsxBudget';
import { listSheets, readSheetDimensionsChecked } from '../../src/xlsxSheets';
import { foreignDir, workDir } from '../stress/paths';
import { xlsxFile } from '../stress/generators/_write';

// Step 1 of the speed plan: where does the time go, per format and stage?
// Prints `PROFILE {json}` lines; asserts nothing about speed. Corpus:
//   conda run -n myproject python test/resources/build_profile_corpus.py
// The user's workbook is used only as a temporary copy, hash-checked.

const profileDir = join(workDir, 'profile');
const report = (data: Record<string, unknown>) => console.log(`PROFILE ${JSON.stringify(data)}`);
const ms = (t: number) => Math.round(performance.now() - t);
const sha = async (p: string) => createHash('sha256').update(await readFile(p)).digest('hex');

/** Attribute in-process time to SQL statements and to row conversion. */
function trace(file: DuckDbFile) {
  const connection = (file as unknown as { connection: Record<string, (...a: unknown[]) => Promise<any>> }).connection;
  const spans: { sql: string; ms: number }[] = [];
  let getRowsMs = 0;
  for (const method of ['run', 'runAndReadAll']) {
    const original = connection[method].bind(connection);
    connection[method] = async (...args: unknown[]) => {
      const t = performance.now();
      try {
        const result = await original(...args);
        if (result && typeof result.getRows === 'function') {
          const getRows = result.getRows.bind(result);
          result.getRows = () => { const g = performance.now(); try { return getRows(); } finally { getRowsMs += performance.now() - g; } };
        }
        return result;
      } finally { spans.push({ sql: String(args[0]).replace(/\s+/g, ' ').slice(0, 70), ms: performance.now() - t }); }
    };
  }
  return {
    top(n = 6) {
      const byKey = new Map<string, { ms: number; count: number }>();
      for (const s of spans) {
        const key = s.sql.replace(/'[^']*'/g, "'…'").replace(/"[^"]*"/g, '"…"').slice(0, 60);
        const e = byKey.get(key) ?? { ms: 0, count: 0 };
        e.ms += s.ms; e.count++; byKey.set(key, e);
      }
      return [...byKey].sort((a, b) => b[1].ms - a[1].ms).slice(0, n).map(([sql, e]) => ({ sql, ms: Math.round(e.ms), n: e.count }));
    },
    total: () => Math.round(spans.reduce((a, s) => a + s.ms, 0)),
    getRowsMs: () => Math.round(getRowsMs),
    reset() { spans.length = 0; getRowsMs = 0; },
  };
}

interface Case { name: string; path: string; relation?: string; column: string; editable?: { table: string; column: string; value: unknown } }

async function mainRelation(file: ViewerFile | DuckDbFile, c: Case): Promise<string> {
  if (c.relation) return c.relation;
  const tables = await file.listTables();
  const sheets = tables.filter(t => file.isWorksheet(t));
  if (!sheets.length) return tables[0];
  // Workbook: prepare the first sheet, then take its largest detected table.
  await file.runQuery(`select * from "${sheets[0].replace(/"/g, '""')}" limit 1`);
  const detected = file.getDetectedSheetTables(sheets[0]);
  return [...detected].sort((a, b) => (b.bottom - b.top) - (a.bottom - a.top))[0]?.name ?? sheets[0];
}

async function profileViewer(c: Case) {
  const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
  const out: Record<string, unknown> = { format: c.name, bytes: (await readFile(c.path)).length };
  let t = performance.now();
  const file = await ViewerFile.open(c.path);
  out.open = ms(t);
  try {
    t = performance.now();
    const rel = await mainRelation(file, c);
    out.firstUse = ms(t);
    const base = `select * from ${q(rel)}`;
    t = performance.now(); await file.runQuery(`${base} limit 100`); out.firstQuery = ms(t);
    const warm: number[] = [];
    for (let i = 0; i < 5; i++) { t = performance.now(); await file.runQuery(`${base} limit 100`); warm.push(performance.now() - t); }
    out.warmQuery = Math.round(warm.sort((a, b) => a - b)[2]);
    // The provider's Run: runQuery, then checkEditableSelect, then (limited) a count.
    t = performance.now();
    await file.runQuery(`${base} limit 1000`); await file.checkEditableSelect(`${base} limit 1000`); await file.countMatchingRows(`${base} limit 1000`);
    out.runRoundTrip = ms(t);
    t = performance.now(); await file.countMatchingRows(base); out.count = ms(t);
    t = performance.now(); await file.runSortedQuery(base, c.column, 'desc', 1000); out.sort = ms(t);
    t = performance.now(); await file.getColumnDescriptiveStats(base, c.column, 'numeric').catch(() => undefined); out.stats = ms(t);
    t = performance.now(); await file.getColumnTopValues(base, c.column).catch(() => undefined); out.topValues = ms(t);
    if (c.editable && !file.isReadOnly()) {
      const row = await file.runQuery(`${base} limit 1`);
      const values = Object.fromEntries(row.columns.map((col, i) => [col, row.rows[0][i]]));
      t = performance.now();
      await file.updateCell(c.editable.table === '*' ? rel : c.editable.table, c.editable.column, c.editable.value, values).catch(e => { out.editError = String(e).slice(0, 80); });
      out.edit = ms(t);
      t = performance.now(); await file.runQuery(`${base} limit 100`); out.queryAfterEdit = ms(t);
    }
  } finally { file.dispose(); }
  report({ kind: 'viewer', ...out });
}

async function profileInProcess(c: Case) {
  let t = performance.now();
  const extra: Record<string, unknown> = {};
  if (c.path.endsWith('.xlsx')) {
    t = performance.now(); await preflightWorkbook(c.path); extra.preflight = ms(t);
    t = performance.now(); const sheets = await listSheets(c.path); extra.listSheets = ms(t);
    t = performance.now(); await readSheetDimensionsChecked(c.path, sheets.map(s => s.path)); extra.dimensions = ms(t);
  }
  t = performance.now();
  const file = await DuckDbFile.open(c.path, undefined, { restrictedReads: true, forceReadOnly: true });
  const open = ms(t);
  const tr = trace(file);
  try {
    t = performance.now();
    const rel = await mainRelation(file, c);
    await file.runQuery(`select * from "${rel.replace(/"/g, '""')}" limit 100`);
    const firstUse = ms(t);
    report({ kind: 'inprocess', format: c.name, ...extra, open, firstUse, sqlMs: tr.total(), getRowsMs: tr.getRowsMs(), top: tr.top() });
  } finally { file.dispose(); }
}

test('PROFILE: every format, end to end and by stage', async () => {
  assert.ok(existsSync(join(profileDir, 'wide.csv')), 'build the corpus first: conda run -n myproject python test/resources/build_profile_corpus.py');
  const dir = await mkdtemp(join(tmpdir(), 'dfv-profile-'));
  const user = join(homedir(), 'Desktop', 'scatter', 'YieldCurve_Data.xlsx');
  const userHash = existsSync(user) ? await sha(user) : undefined;
  try {
    const copy = async (p: string) => { const d = join(dir, basename(p)); await copyFile(p, d); return d; };
    const wideBook = await xlsxFile(join(dir, 'fifty.xlsx'), Array.from({ length: 50 }, (_, s) => ({
      name: `Sheet${s}`, rows: Array.from({ length: 10 }, (_, t) => [['id', `v${t}`], ...Array.from({ length: 40 }, (_, i) => [i, `s${s}t${t}r${i}`]), []]).flat(),
    })));
    const cases: Case[] = [
      ...(userHash ? [{ name: 'xlsx YieldCurve (21 MB)', path: await copy(user), column: 'BETA0', editable: { table: '*', column: 'BETA0', value: 1.5 } }] : []),
      { name: 'xlsx strings (40k rows)', path: await copy(join(profileDir, 'strings.xlsx')), column: 'score', editable: { table: '*', column: 'score', value: 1.5 } },
      { name: 'xlsx 50 sheets/500 tables', path: wideBook, column: 'id' },
      { name: 'xlsx openpyxl foreign', path: await copy(join(foreignDir, 'openpyxl.xlsx')), column: 'id' },
      { name: 'csv 200k', path: await copy(join(profileDir, 'wide.csv')), column: 'amount', editable: { table: 'wide', column: 'label', value: 'edited' } },
      { name: 'parquet 200k', path: await copy(join(profileDir, 'wide.parquet')), column: 'amount' },
      { name: 'arrows 200k', path: await copy(join(profileDir, 'wide.arrows')), column: 'amount' },
      { name: 'feather 200k', path: await copy(join(profileDir, 'wide.feather')), column: 'amount' },
      { name: 'dta 200k', path: await copy(join(profileDir, 'wide.dta')), column: 'amount' },
      { name: 'duckdb 200k', path: await copy(join(profileDir, 'wide.duckdb')), relation: 'wide', column: 'amount', editable: { table: 'wide', column: 'label', value: 'edited' } },
      { name: 'sqlite 200 tables + 200k untyped', path: await copy(join(profileDir, 'many.sqlite')), relation: 'big', column: 'a', editable: { table: 'big', column: 'b', value: 'edited' } },
    ];
    for (const c of cases) {
      // In-process first, on a pristine copy; the viewer run may edit it.
      await profileInProcess(c).catch(e => report({ kind: 'inprocess', format: c.name, error: String(e).slice(0, 120) }));
      await profileViewer(c).catch(e => report({ kind: 'viewer', format: c.name, error: String(e).slice(0, 120) }));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
    if (userHash) assert.equal(await sha(user), userHash, 'the user\'s workbook is unchanged');
  }
});
