import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { unzipSync } from 'fflate';
import { ViewerFile } from '../../src/viewerFile';
import { foreignDir, workDir } from '../stress/paths';
import { xlsxFile } from '../stress/generators/_write';

// Step 2 of the speed plan: the "don't break anything" gate. Everything a user
// can observe is snapshotted per file; a speed change must reproduce it exactly.
//   DFV_EQUIV_RECORD=1 npm run test:resources   -> records the baseline
//   npm run test:resources                      -> compares against it
// A workbook's bytes after an edit are compared member by member (decompressed):
// how a ZIP is re-encoded is not observable, what it holds is.

const baselinePath = join(workDir, 'equivalence', 'baseline.json');
const profileDir = join(workDir, 'profile');
const big = (_k: string, v: unknown) => typeof v === 'bigint' ? `${v}n` : v;
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

async function snapshotBytes(path: string): Promise<unknown> {
  const bytes = await readFile(path);
  if (!path.endsWith('.xlsx')) return sha(bytes);
  const members = unzipSync(new Uint8Array(bytes));
  return Object.fromEntries(Object.keys(members).sort().map(name => [name, sha(members[name])]));
}

interface Edit { table: string; column: string; value: unknown }

async function snapshot(path: string, edit?: Edit): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const file = await ViewerFile.open(path);
  try {
    const tables = await file.listTables();
    out.tables = tables;
    out.openWarnings = [...file.openWarnings];
    const relations: string[] = [];
    for (const t of tables) {
      relations.push(t);
      if (file.isWorksheet(t)) {
        await file.runQuery(`select * from "${t.replace(/"/g, '""')}" limit 0`);
        const detected = file.getDetectedSheetTables(t);
        out[`detected:${t}`] = detected;
        relations.push(...detected.map(d => d.name));
      }
    }
    const catalog = await file.getQueryCatalog(0);
    out.catalog = catalog;
    for (const r of catalog.slice(0, 40)) out[`columns:${r.name}`] = await file.getQueryColumns(r.catalog, r.schema, r.name);
    for (const rel of relations.slice(0, 40)) {
      const base = `select * from "${rel.replace(/"/g, '""')}"`;
      const result = await file.runQuery(base);
      const hash = sha(Buffer.from(JSON.stringify({ c: result.columns, r: result.rows }, big)));
      out[`rows:${rel}`] = { columns: result.columns, n: result.rows.length, hash, truncated: result.truncated ?? false };
      out[`count:${rel}`] = await file.countMatchingRows(base);
      const first = result.columns[0];
      if (first !== undefined) {
        const sorted = await file.runSortedQuery(base, first, 'desc', 50);
        out[`sort:${rel}`] = sha(Buffer.from(JSON.stringify(sorted.rows, big)));
        out[`top:${rel}`] = JSON.parse(JSON.stringify(await file.getColumnTopValues(base, first).catch(e => String(e)), big));
      }
      out[`editable:${rel}`] = await file.checkEditableSelect(base).catch(e => String(e));
    }
    out.lateWarnings = file.takeLateWarnings();
    if (edit && !file.isReadOnly()) {
      // A detected table is named by position; pick the one holding the column.
      if (edit.table.endsWith('*')) {
        const sheet = edit.table.slice(0, -1);
        const column = edit.column;
        const owner = file.getDetectedSheetTables(sheet).find(d => d.columns.includes(column));
        edit = { ...edit, table: owner?.name ?? edit.table };
        out.editTable = edit.table;
      }
      const row = await file.runQuery(`select * from "${edit.table.replace(/"/g, '""')}" limit 1 offset 1`);
      const values = Object.fromEntries(row.columns.map((c, i) => [c, row.rows[0][i]]));
      out.editResult = await file.updateCell(edit.table, edit.column, edit.value, values).then(String, e => `error: ${String(e).slice(0, 120)}`);
      const after = await file.runQuery(`select * from "${edit.table.replace(/"/g, '""')}"`);
      out.afterEditRows = sha(Buffer.from(JSON.stringify(after.rows, big)));
      out.afterEditBytes = await snapshotBytes(path);
      out.afterEditWarnings = file.takeLateWarnings();
    }
  } finally { file.dispose(); }
  return JSON.parse(JSON.stringify(out, big));
}

test('EQUIVALENCE: observable behaviour per file matches the recorded baseline', async () => {
  assert.ok(existsSync(join(profileDir, 'wide.csv')), 'build the corpus first: conda run -n myproject python test/resources/build_profile_corpus.py');
  const dir = await mkdtemp(join(tmpdir(), 'dfv-equiv-'));
  const user = join(homedir(), 'Desktop', 'scatter');
  const userHash = existsSync(join(user, 'YieldCurve_Data.xlsx')) ? sha(await readFile(join(user, 'YieldCurve_Data.xlsx'))) : undefined;
  const copy = async (p: string) => { const d = join(dir, basename(p)); await copyFile(p, d); return d; };
  const results: Record<string, unknown> = {};
  try {
    const hostile = await xlsxFile(join(dir, 'hostile.xlsx'), [
      { name: "Sheet 'q\"", rows: [['notes'], [], ['Date', 'a"b', 'n'], ['2020-01-01', `O'Brien`, 1], ['2020-01-02', '#N/A', 2], ['2020-01-03', '1,5', 3]] },
      { name: 'Side', rows: [['k', 'v'], ['x', 1], [], [null, 'id', 'amt'], [null, 1, '#DIV/0!'], [null, 2, '3.25'], [null, 3, '4'], [null, 4, '5']] },
    ]);
    const cases: [string, string, Edit?][] = [
      ...(userHash ? [['YieldCurve.xlsx', await copy(join(user, 'YieldCurve_Data.xlsx')), { table: 'Raw_Data*', column: 'BETA0', value: 1.5 }] as [string, string, Edit]] : []),
      ...(existsSync(join(user, 'YieldCurve_Data.duckdb')) ? [['YieldCurve.duckdb', await copy(join(user, 'YieldCurve_Data.duckdb'))] as [string, string]] : []),
      ['strings.xlsx', await copy(join(profileDir, 'strings.xlsx')), { table: 'Data*', column: 'score', value: 99.5 }],
      ['hostile.xlsx', hostile, { table: "Sheet 'q\"*", column: 'n', value: 7 }],
      ['openpyxl-trailing-notes.xlsx', await copy(join(foreignDir, 'openpyxl-trailing-notes.xlsx'))],
      ['openpyxl-merged-title.xlsx', await copy(join(foreignDir, 'openpyxl-merged-title.xlsx'))],
      ['wide.csv', await copy(join(profileDir, 'wide.csv')), { table: 'wide', column: 'label', value: 'edited' }],
      ['pandas.csv', await copy(join(foreignDir, 'pandas.csv'))],
      ['wide.parquet', await copy(join(profileDir, 'wide.parquet'))],
      ['wide.arrows', await copy(join(profileDir, 'wide.arrows'))],
      ['wide.feather', await copy(join(profileDir, 'wide.feather'))],
      ['wide.dta', await copy(join(profileDir, 'wide.dta'))],
      ['wide.duckdb', await copy(join(profileDir, 'wide.duckdb')), { table: 'wide', column: 'label', value: 'edited' }],
      ['many.sqlite', await copy(join(profileDir, 'many.sqlite')), { table: 'big', column: 'b', value: 'edited' }],
    ];
    for (const [name, path, edit] of cases) {
      results[name] = await snapshot(path, edit).catch(e => ({ error: String(e).slice(0, 200) }));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
    if (userHash) assert.equal(sha(await readFile(join(user, 'YieldCurve_Data.xlsx'))), userHash);
  }
  if (process.env.DFV_EQUIV_RECORD === '1') {
    await mkdir(join(workDir, 'equivalence'), { recursive: true });
    await writeFile(baselinePath, JSON.stringify(results, null, 1));
    console.log(`EQUIVALENCE baseline recorded: ${Object.keys(results).length} files -> ${baselinePath}`);
    return;
  }
  assert.ok(existsSync(baselinePath), 'record a baseline first with DFV_EQUIV_RECORD=1');
  const baseline = JSON.parse(await readFile(baselinePath, 'utf8'));
  const differences: string[] = [];
  for (const name of new Set([...Object.keys(baseline), ...Object.keys(results)])) {
    const a = baseline[name] ?? {}, b = (results[name] ?? {}) as Record<string, unknown>;
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      // The pre-0.0.17 baseline predates worksheet highlight bounds. Keep
      // comparing every old catalog field; queryCatalog/sheetHighlight tests
      // independently verify the new geometry. Do not rewrite the baseline.
      let current = b[key];
      if (key === 'catalog' && Array.isArray(a[key]) && Array.isArray(current) &&
          a[key].every((entry: Record<string, unknown>) => !Object.hasOwn(entry, 'bounds'))) {
        current = current.map(({ bounds: _bounds, ...entry }: Record<string, unknown>) => entry);
      }
      if (JSON.stringify(a[key]) !== JSON.stringify(current)) differences.push(`${name} :: ${key}\n  was ${JSON.stringify(a[key])?.slice(0, 300)}\n  now ${JSON.stringify(b[key])?.slice(0, 300)}`);
    }
  }
  console.log(`EQUIVALENCE compared ${Object.keys(results).length} files: ${differences.length} differences`);
  assert.deepEqual(differences, []);
});
