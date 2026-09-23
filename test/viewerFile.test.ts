import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DuckDBInstance } from '@duckdb/node-api';
import { ViewerFile } from '../src/viewerFile';
import { xlsxFile, sqliteFile, duckdbFile, parquetFile, arrowStreamFile, featherFile } from './stress/generators/_write';

for (const format of ['csv', 'duckdb', 'xlsx', 'sqlite', 'parquet', 'arrows', 'feather']) test(`read/write handoff: ${format} saves exactly one row and keeps backup comparison`, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dfv-handoff-'));
  let file: ViewerFile | undefined;
  try {
    const path = join(dir, `data.${format}`);
    if (format === 'csv') await writeFile(path, 'id,value\n1,10\n2,20\n');
    if (format === 'xlsx') await xlsxFile(path, [{ name: 'data', rows: [['id', 'value'], [1, 10], [2, 20]] }]);
    const spec = { name: 'data', columns: [{ name: 'id', type: 'INTEGER' }, { name: 'value', type: 'INTEGER' }], rows: [[1, 10], [2, 20]] };
    if (format === 'sqlite') await sqliteFile(path, [spec]);
    if (format === 'parquet') await parquetFile(path, spec);
    if (format === 'arrows' || format === 'feather') {
      const columns = [{ name: 'id', encoding: 'int32' as const, values: [1, 2] }, { name: 'value', encoding: 'int32' as const, values: [10, 20] }];
      await (format === 'feather' ? featherFile : arrowStreamFile)(path, columns);
    }
    if (format === 'duckdb') {
      const instance = await DuckDBInstance.create(path);
      const c = await instance.connect();
      await c.run('create table data as select 1 as id, 10 as "value" union all select 2, 20');
      c.closeSync(); instance.closeSync();
    }
    const original = await readFile(path);
    file = await ViewerFile.open(path);
    let table = 'data';
    if (format === 'xlsx') {
      await file.runQuery('select * from data');
      table = file.getDetectedSheetTables('data')[0].name;
    }
    const sql = `select * from "${table}" order by id`;
    const before = await file.runQuery(sql);
    assert.equal((await file.checkEditableSelect(sql)).editable, true);
    const backup = await file.createBackup();
    assert.deepEqual(await readFile(backup), original);
    if (format === 'duckdb') {
      const repeated = await file.createBackup();
      assert.notEqual(repeated, backup, 'rapid backup requests must not overwrite the previous snapshot');
      assert.deepEqual(await readFile(repeated), original);
    }
    const row = Object.fromEntries(before.columns.map((name, index) => [name, before.rows[0][index]]));
    assert.equal(await file.updateCell(table, 'value', 99, row), 1);
    const after = await file.runQuery(sql);
    assert.deepEqual(after.rows.map(row => row.map(Number)), [[1, 99], [2, 20]]);
    const diff = await file.diffQueryAgainstBackup(sql, after.columns, after.rows);
    assert.ok(diff);
    assert.deepEqual(await readFile(backup), original);
    file.dispose(); file = undefined;
    if (format === 'csv') assert.match(await readFile(path, 'utf8'), /1,99/);
    if (format === 'duckdb') {
      const instance = await DuckDBInstance.create(path, { access_mode: 'READ_ONLY' });
      const c = await instance.connect();
      assert.deepEqual((await c.runAndReadAll('select * from data order by id')).getRows(), [[1, 99], [2, 20]]);
      c.closeSync(); instance.closeSync();
    }
  } finally { file?.dispose(); await rm(dir, { recursive: true, force: true }); }
});

test('stale source refuses a save and preserves the replacement bytes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dfv-stale-'));
  let file: ViewerFile | undefined;
  try {
    const path = join(dir, 'data.csv');
    await writeFile(path, 'id,value\n1,10\n');
    file = await ViewerFile.open(path);
    await file.runQuery('select * from data');
    const replacement = 'id,value\n1,200\n2,300\n';
    await writeFile(path, replacement);
    await assert.rejects(file.updateCell('data', 'value', 99, { id: 1, value: 10 }), /source changed/i);
    assert.equal(await readFile(path, 'utf8'), replacement);
    await file.refreshInPlace();
    assert.equal((await file.runQuery('select * from data')).rows.length, 2);
  } finally { file?.dispose(); await rm(dir, { recursive: true, force: true }); }
});

test('paired-file grants remain exact and survive reader refresh', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dfv-pair-policy-'));
  let file: ViewerFile | undefined;
  try {
    const source = join(root, 'cold.duckdb'), sibling = join(root, 'hot.sqlite');
    const columns = [{ name: 'id', type: 'INTEGER' }, { name: 'value', type: 'INTEGER' }];
    await duckdbFile(source, [{ name: 'data', columns, rows: [[1, 10]] }]);
    await sqliteFile(sibling, [{ name: 'data', columns, rows: [[2, 20]] }]);
    file = await ViewerFile.open(source, undefined, { siblingPath: sibling });
    const query = await file.buildCombinedQuery('data');
    assert.equal((await file.runQuery(query.sql)).rows.length, 2);
    await assert.rejects(file.runQuery(query.sql + ' '), /document|permitted|relation|catalog/i);
    await file.refreshInPlace();
    assert.equal((await file.runQuery(query.sql)).rows.length, 2);
    assert.equal((await file.runSortedQuery(query.sql, 'id', 'desc')).rows.length, 2);
  } finally { file?.dispose(); await rm(root, { recursive: true, force: true }); }
});
