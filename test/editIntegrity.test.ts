import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { ViewerFile } from '../src/viewerFile';
import { sqliteFile, xlsxFile } from './stress/generators/_write';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';

// INT-01–04 of docs/sql-filtering-plan.md through the production document
// (restricted reader + trusted writer). Persisted results are checked with an
// independent DuckDB instance, never with the reader that made the edit.

async function independent(sql: string): Promise<unknown[][]> {
  const instance = await DuckDBInstance.create(':memory:');
  const c = await instance.connect();
  try { return (await c.runAndReadAll(sql)).getRows(); } finally { c.closeSync(); instance.closeSync(); }
}

test('workbook edit cannot use row coordinates cached from different bytes with the same file stamp', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dfv-edit-stamp-'));
  let file: ViewerFile | undefined;
  try {
    const path = await xlsxFile(join(dir, 'data.xlsx'), [{ name: 'data', rows: [['id', 'value'], [1, 10], [2, 10]] }]);
    const parts = unzipSync(await readFile(path));
    const options = { level: 0 as const, mtime: new Date('2000-01-01T00:00:00Z') };
    const original = Buffer.from(zipSync(parts, options));
    const sheet = 'xl/worksheets/sheet1.xml';
    parts[sheet] = strToU8(strFromU8(parts[sheet]).replace(/<v>(1|2)<\/v>/g, (_, id) => `<v>${id === '1' ? 2 : 1}</v>`));
    const replacement = Buffer.from(zipSync(parts, options));
    assert.equal(replacement.length, original.length);
    assert.notDeepEqual(replacement, original);
    const stamp = new Date('2020-01-01T00:00:00Z');
    const replace = async (bytes: Buffer) => { await writeFile(path, bytes); await utimes(path, stamp, stamp); };
    await replace(original);
    file = await ViewerFile.open(path);
    await replace(replacement);
    let rejected = false;
    try { await file.runQuery('select * from "data · Table 1"'); }
    catch (error) { assert.match(String(error), /workbook.*changed|source.*changed/i); rejected = true; }
    finally { await replace(original); }
    if (rejected) { assert.deepEqual(await readFile(path), original); return; }
    await file.updateCell('data · Table 1', 'value', 99, { id: 1, value: 10 });
    const changed = strFromU8(unzipSync(await readFile(path))[sheet]);
    assert.match(changed, /<c\b[^>]*r="B2"[^>]*><v>99<\/v><\/c>/, 'the edit must never move to the row with id=2');
  } finally { file?.dispose(); await rm(dir, { recursive: true, force: true }); }
});

test('INT-01: an edit made from a filtered result changes exactly the targeted cell', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dfv-int01-'));
  const path = join(dir, 'data.csv');
  await writeFile(path, 'id,region,amount\n' + Array.from({ length: 40 }, (_, i) => `${i},${i % 4 === 0 ? 'north' : 'south'},${i * 10}`).join('\n') + '\n');
  const file = await ViewerFile.open(path);
  try {
    const filtered = await file.runQuery("select * from data where region = 'north' and amount >= 100");
    assert.equal(filtered.rows.length, 7);
    const row = Object.fromEntries(filtered.columns.map((c, i) => [c, filtered.rows[2][i]]));
    assert.equal(await file.updateCell('data', 'amount', 12345, row), 1);
    const after = await independent(`select id, amount from read_csv('${path.replace(/'/g, "''")}') order by id`);
    for (const [id, amount] of after) {
      assert.equal(Number(amount), Number(id) === Number(row.id) ? 12345 : Number(id) * 10, `row ${id}`);
    }
    // The restricted reader sees the edit after its own refresh.
    assert.equal(String((await file.runQuery(`select amount from data where id = ${Number(row.id)}`)).rows[0][0]), '12345');
  } finally { file.dispose(); await rm(dir, { recursive: true, force: true }); }
});

test('INT-02: a user column named rowid does not redirect a SQLite edit to another row', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dfv-int02-'));
  const path = await sqliteFile(join(dir, 'hot.sqlite'), [{ name: 'items',
    columns: [{ name: 'rowid', type: 'INTEGER' }, { name: 'name', type: 'VARCHAR' }, { name: 'qty', type: 'INTEGER' }],
    rows: [[3, 'a', 1], [1, 'b', 2], [2, 'c', 3]] }]);
  const file = await ViewerFile.open(path);
  try {
    let changed: number | undefined;
    try { changed = await file.updateCell('items', 'qty', 99, { rowid: 1, name: 'b', qty: 2 }); } catch { changed = undefined; }
    const rows = await independent(`attach '${path.replace(/'/g, "''")}' as s (type sqlite, read_only); select name, qty from s.items order by name`);
    if (changed === undefined) {
      assert.deepEqual(rows.map(r => Number(r[1])), [1, 2, 3], 'a refused edit changes nothing');
    } else {
      assert.equal(changed, 1);
      assert.deepEqual(rows.map(r => [String(r[0]), Number(r[1])]), [['a', 1], ['b', 99], ['c', 3]], 'exactly the matched row changed');
    }
  } finally { file.dispose(); await rm(dir, { recursive: true, force: true }); }
});

test('INT-03: an edit against stale workbook bounds is refused and the workbook is untouched', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dfv-int03-'));
  const path = join(dir, 'book.xlsx');
  await xlsxFile(path, [{ name: 'S', rows: [['id', 'v'], [1, 'x'], [2, 'y']] }]);
  const file = await ViewerFile.open(path);
  try {
    await file.runQuery('select * from "S · Table 1"');
    // Another program inserts two rows above the table: same table name, different bounds.
    await new Promise(r => setTimeout(r, 1100));
    await xlsxFile(path, [{ name: 'S', rows: [['note'], [], ['id', 'v'], [1, 'x'], [2, 'y']] }]);
    const replaced = await readFile(path);
    await assert.rejects(file.updateCell('S · Table 1', 'v', 'Z', { id: 1, v: 'x' }));
    assert.deepEqual(await readFile(path), replaced, 'the replacement bytes are preserved');
  } finally { file.dispose(); await rm(dir, { recursive: true, force: true }); }
});

test('INT-04: a write that cannot be published rolls back; memory and disk agree', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dfv-int04-'));
  const path = join(dir, 'data.csv');
  await writeFile(path, 'id,v\n1,a\n2,b\n');
  const file = await ViewerFile.open(path);
  try {
    // A value the column cannot hold fails before publication.
    await assert.rejects(file.updateCell('data', 'id', 'not a number', { id: 1, v: 'a' }));
    assert.equal(await readFile(path, 'utf8'), 'id,v\n1,a\n2,b\n');
    assert.deepEqual((await file.runQuery('select id, v from data order by id')).rows.map(r => r.map(String)), [['1', 'a'], ['2', 'b']]);
    // And a normal edit still lands.
    assert.equal(await file.updateCell('data', 'v', 'B', { id: 2, v: 'b' }), 1);
    assert.deepEqual((await independent(`select v from read_csv('${path.replace(/'/g, "''")}') order by id`)).map(r => String(r[0])), ['a', 'B']);
  } finally { file.dispose(); await rm(dir, { recursive: true, force: true }); }
});
