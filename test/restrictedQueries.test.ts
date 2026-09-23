import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DuckDbFile } from '../src/duckdbConnection';
import { xlsxFile } from './stress/generators/_write';

test('restricted CSV queries and stats work, outside functions and writes do not', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dfv-restricted-'));
  let file: DuckDbFile | undefined;
  try {
    const source = join(dir, 'approved.csv');
    const outside = join(dir, 'outside.txt');
    await writeFile(source, 'id,value\n1,10\n2,20\n');
    await writeFile(outside, 'SYNTHETIC_OUTSIDE');
    const before = await readFile(source);
    file = await DuckDbFile.open(source, undefined, { restrictedReads: true });
    assert.equal((await file.runQuery('select * from approved where id>=2')).rows.length, 1);
    assert.equal(await file.countMatchingRows('select * from approved'), 2);
    assert.equal((await file.getColumnDescriptiveStats('select * from approved', 'value', 'numeric')).mean, 15);
    for (const sql of [
      `select content from read_text('${outside.replace(/'/g, "''")}')`,
      'select * from duckdb_databases()', 'select * from information_schema.tables',
      'delete from approved', 'set enable_external_access=true',
    ]) {
      await assert.rejects(file.runQuery(sql));
      await assert.rejects(file.getColumnTopValues(sql, 'value'));
      assert.equal(await file.countMatchingRows(sql), undefined);
    }
    assert.deepEqual(await readFile(source), before);
  } finally { file?.dispose(); await rm(dir, { recursive: true, force: true }); }
});

test('cold multi-sheet query prepares exactly its referenced detected tables', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dfv-cold-'));
  let file: DuckDbFile | undefined;
  try {
    const path = await xlsxFile(join(dir, 'data.xlsx'), ['First', 'Second', 'Unused'].map(name => ({ name, rows: [['id', 'value'], [1, 10], [2, 20]] })));
    file = await DuckDbFile.open(path, undefined, { restrictedReads: true });
    const result = await file.runQuery(`select a.id from "First · Table 1" a join "Second · Table 1" b on a.id=b.id where a.id=2 /* "Unused" */`);
    assert.deepEqual(result.rows.map(row => Number(row[0])), [2]);
    assert.equal(file.getDetectedSheetTables('First').length, 1);
    assert.equal(file.getDetectedSheetTables('Second').length, 1);
    assert.equal(file.getDetectedSheetTables('Unused').length, 0);
  } finally { file?.dispose(); await rm(dir, { recursive: true, force: true }); }
});
