import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { DuckDBInstance } from '@duckdb/node-api';
import { DuckDbFile } from '../src/duckdbConnection';
import { xlsxFile } from './stress/generators/_write';
import { referencedQueryTables } from '../src/queryPolicy';

// Phase 1 evidence: synthetic inputs only. These tests exercise the installed
// engine's controls directly, independently of the extension's SQL scanner.
test('SEC baseline: locked engine denies outside files, URLs and configuration changes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dfv-policy-'));
  const approved = join(dir, 'approved.csv');
  const outside = join(dir, 'outside.txt');
  const escaped = (s: string) => `'${s.replace(/'/g, "''")}'`;
  let requests = 0;
  const server = createServer((_req, res) => { requests++; res.end('SYNTHETIC_REMOTE'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const instance = await DuckDBInstance.create(':memory:');
  const c = await instance.connect();
  try {
    await writeFile(approved, 'id,value\n1,10\n2,20\n');
    await writeFile(outside, 'SYNTHETIC_OUTSIDE');
    await c.run(`create view approved as select * from read_csv(${escaped(approved)})`);
    await c.run(`create view hostile as select content from read_text(${escaped(outside)})`);
    await c.run(`set allowed_paths = [${escaped(approved)}]`);
    await c.run('set autoinstall_known_extensions = false');
    await c.run('set autoload_known_extensions = false');
    await c.run('set enable_external_access = false');
    await c.run('set lock_configuration = true');
    assert.deepEqual((await c.runAndReadAll('select sum(value)::integer from approved')).getRows(), [[30]]);
    for (const sql of [
      `select content from read_text(${escaped(outside)})`,
      'select * from hostile',
      `with x as (select * from read_text(${escaped(outside)})) select * from x`,
      `select * from read_csv('http://127.0.0.1:${address.port}/?token=SYNTHETIC_TOKEN')`,
      'set enable_external_access = true',
      `set allowed_paths = [${escaped(outside)}]`,
      'set lock_configuration = false',
      'install httpfs',
    ]) await assert.rejects(c.runAndReadAll(sql));
    assert.equal(requests, 0, 'even an unsuccessful network attempt is forbidden');
    assert.equal(await readFile(outside, 'utf8'), 'SYNTHETIC_OUTSIDE');
  } finally {
    c.closeSync();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

test('REL baseline: numeric year and date boundary have different SQL types', async () => {
  const instance = await DuckDBInstance.create(':memory:');
  const c = await instance.connect();
  try {
    for (const type of ['DATE', 'TIMESTAMP', 'VARCHAR']) {
      await c.run(`create or replace table t as select cast('1990-01-01' as ${type}) as "Date"`);
      await assert.rejects(c.runAndReadAll('select * from t where "Date" >= 1990'));
      assert.equal((await c.runAndReadAll('select * from t where cast("Date" as date) >= DATE \'1990-01-01\'')).getRows().length, 1);
    }
    assert.equal((await c.runAndReadAll('select 1990 where 1990 >= 1990')).getRows().length, 1);
  } finally { c.closeSync(); }
});

test('REL baseline: engine relation extraction ignores literals and comments and finds cold joins', async () => {
  const instance = await DuckDBInstance.create(':memory:');
  const c = await instance.connect();
  try {
    assert.deepEqual([...c.getTableNames(`select 'Unused' from "First · Table 1" a join "Second · Table 1" b on true /* from Third */`, false)].sort(), ['First · Table 1', 'Second · Table 1']);
    await c.run('create view existing as select 1 as i');
    assert.deepEqual([...c.getTableNames('select * from existing', false)], []);
    assert.deepEqual([...await referencedQueryTables(c, 'select * from existing')], ['existing']);
  } finally { c.closeSync(); }
});

test('REL baseline: offset worksheet data remains a separate typed relation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dfv-sql-layout-'));
  let file: DuckDbFile | undefined;
  try {
    const path = await xlsxFile(join(dir, 'layout.xlsx'), [{ name: 'Raw_Data', rows: [
      ['Notes', 'Description'], ['source', 'synthetic'], [],
      [null, 'Date', 'Value'], [null, '1989-12-31', 1], [null, '1990-01-01', 2],
    ] }]);
    const before = await readFile(path);
    file = await DuckDbFile.open(path);
    await assert.rejects(file.runQuery('select * from "Raw_Data" where "Date" >= 1990 limit 100'));
    const table = file.getDetectedSheetTables('Raw_Data').find(t => t.columns.includes('Date'));
    assert.ok(table);
    const sql = `select * from "${table.name}" where cast("Date" as date) >= DATE '1990-01-01' limit 100`;
    const result = await file.runQuery(sql);
    assert.equal(result.rows.length, 1);
    assert.equal(Number(result.rows[0][1]), 2);
    assert.deepEqual(await readFile(path), before);
  } finally { file?.dispose(); await rm(dir, { recursive: true, force: true }); }
});
