import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, readFile, readdir, rm, symlink, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { DuckDbFile } from '../src/duckdbConnection';
import { xlsxFile, sqliteFile } from './stress/generators/_write';

// SEC-01–13 of docs/sql-filtering-plan.md, against the real restricted reader.
// Every refusal is paired with an authorized query on the same document, and
// the observation is the side effect (canary text, listener hits, hashes and
// directory listings), not the error message.

const CANARY = 'SYNTHETIC_OUTSIDE_CANARY_7f3a';
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const sha = async (p: string) => createHash('sha256').update(await readFile(p)).digest('hex');

/** Every public read path a webview message can reach with user SQL. */
async function everyReadPath(file: DuckDbFile, sql: string, column: string): Promise<unknown[]> {
  const outcomes: unknown[] = [];
  const attempt = async (run: () => Promise<unknown>) => {
    try { outcomes.push(await run()); } catch (error) { outcomes.push({ refused: String(error instanceof Error ? error.message : error) }); }
  };
  await attempt(() => file.runQuery(sql));
  await attempt(() => file.runQuery(sql, 10));
  await attempt(() => file.countMatchingRows(sql));
  await attempt(() => file.runSortedQuery(sql, column, 'desc'));
  await attempt(() => file.runChartQuery(sql, column, [column]));
  await attempt(() => file.getColumnTopValues(sql, column));
  await attempt(() => file.getColumnDescriptiveStats(sql, column, 'numeric'));
  await attempt(() => file.checkEditableSelect(sql));
  return outcomes;
}

function assertNoLeak(outcomes: unknown[], sql: string): void {
  const text = JSON.stringify(outcomes, (_k, v) => typeof v === 'bigint' ? String(v) : v);
  assert.ok(!text.includes(CANARY), `canary reached a result or error for: ${sql}\n${text.slice(0, 600)}`);
}

async function fixtureDir(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const docs = join(root, 'docs');
  await mkdir(docs);
  const outside = join(root, 'outside.csv');
  await writeFile(outside, `id,value\n1,${CANARY}\n`);
  // Same-prefix siblings of an approved path must not inherit its grant.
  await writeFile(join(docs, 'approved.csv.bak'), `id,value\n1,${CANARY}\n`);
  await writeFile(join(docs, 'approvedX.csv'), `id,value\n1,${CANARY}\n`);
  await symlink(outside, join(docs, 'link.csv'));
  return { root, docs, outside };
}

function outsideReads(outside: string, docs: string): string[] {
  const rel = '../outside.csv';
  const fns = ['read_csv', 'read_csv_auto', 'read_text', 'read_blob', 'read_parquet', 'read_json', 'read_json_auto', 'glob', 'sniff_csv'];
  const paths = [outside, rel, join(docs, 'link.csv'), join(docs, 'approved.csv.bak'), join(docs, 'approvedX.csv'),
    join(docs, '*.csv'), join(docs, '..', 'outside.csv'), `${docs}/./../outside.csv`, `file://${outside}`];
  const sqls: string[] = [];
  for (const fn of fns) for (const p of paths) sqls.push(`select * from ${fn}(${lit(p)})`);
  for (const p of [outside, rel, join(docs, 'link.csv')]) {
    sqls.push(
      `select * from ${lit(p)}`,
      `select * from "${p}"`,
      `select * from approved where value in (select value from read_csv(${lit(p)}))`,
      `with x as (select * from read_csv(${lit(p)})) select * from x`,
      `select (select string_agg(value::varchar, ',') from read_csv(${lit(p)})) as value, 1 as id`,
      `select * from approved, lateral (select * from read_csv(${lit(p)})) t`,
      `select * from approved order by (select count(*) from read_csv(${lit(p)}))`,
      `select list_transform([1], x -> (select value from read_csv(${lit(p)}) limit 1)) as value`,
      `select * from read_csv([${lit(join(docs, 'approved.csv'))}, ${lit(p)}])`,
      `select * from approved union all select * from read_csv(${lit(p)})`,
      `/* comment */ select * from read_csv(${lit(p)}) -- trailing`,
      `explain analyze select * from read_csv(${lit(p)})`,
      `describe select * from read_csv(${lit(p)})`,
      `summarize read_csv(${lit(p)})`,
    );
  }
  sqls.push(
    "select getenv('HOME') as value", "select current_setting('home_directory') as value",
    "select * from query('select 1')", "select * from query_table('approved')",
    "select json_execute_serialized_sql('x')", "select * from duckdb_settings()",
    'select * from pragma_database_list()', 'select * from system.main.duckdb_tables()',
    "select * from sqlite_scan('x.db','t')", "select * from parquet_metadata('x.parquet')",
  );
  return sqls;
}

test('SEC-01–04: outside files, links, prefixes and globs never reach any read path (CSV)', async () => {
  const { root, docs, outside } = await fixtureDir('dfv-sec-csv-');
  let file: DuckDbFile | undefined;
  try {
    const source = join(docs, 'approved.csv');
    await writeFile(source, 'id,value\n1,10\n2,20\n');
    file = await DuckDbFile.open(source, undefined, { restrictedReads: true });
    assert.equal((await file.runQuery('select * from approved where id >= 2')).rows.length, 1, 'authorized query works');
    for (const sql of outsideReads(outside, docs)) assertNoLeak(await everyReadPath(file, sql, 'value'), sql);
    assert.equal(Number((await file.runQuery('select sum(value) from approved')).rows[0][0]), 30, 'still usable after refusals');
  } finally { file?.dispose(); await rm(root, { recursive: true, force: true }); }
});

test('SEC-01–04: persisted views and macros in a .duckdb file cannot read outside files', async () => {
  const { root, docs, outside } = await fixtureDir('dfv-sec-db-');
  let file: DuckDbFile | undefined;
  try {
    const path = join(docs, 'store.duckdb');
    const instance = await DuckDBInstance.create(path);
    const c = await instance.connect();
    await c.run('create table data as select range as id, range * 10 as value from range(3)');
    await c.run('create view good as select * from data where id > 0');
    await c.run(`create view bad as select * from read_csv(${lit(outside)})`);
    await c.run(`create view bad_nested as select * from good union all select * from read_csv(${lit(outside)})`);
    await c.run('create view via_bad as select * from bad');
    await c.run(`create macro m_scalar() as (select value from read_csv(${lit(outside)}) limit 1)`);
    await c.run(`create macro m_table() as table select * from read_csv(${lit(outside)})`);
    await c.run("create macro m_env() as current_setting('home_directory')");
    await c.run(`create view "weird ""name""" as select * from read_text(${lit(outside)})`);
    c.closeSync(); instance.closeSync();
    const before = await sha(path);
    file = await DuckDbFile.open(path, undefined, { restrictedReads: true });
    assert.equal((await file.runQuery('select count(*) from good')).rows[0][0] + '', '2');
    assert.equal((await file.runQuery('select sum(value)::integer from data')).rows[0][0], 30);
    for (const sql of [
      'select * from bad', 'select * from bad_nested', 'select * from via_bad',
      'select m_scalar() as value', 'select * from m_table()', 'select m_env() as value',
      'select * from "weird ""name"""', 'with x as (select * from bad) select * from x',
      'select * from good where value in (select value from via_bad)',
      ...outsideReads(outside, docs),
    ]) assertNoLeak(await everyReadPath(file, sql, 'value'), sql);
    file.dispose(); file = undefined;
    assert.equal(await sha(path), before, 'read-only workflows leave the document unchanged');
  } finally { file?.dispose(); await rm(root, { recursive: true, force: true }); }
});

test('SEC-05–07: no outbound request from URLs, redirects or credential-bearing fake URLs', async () => {
  const { root, docs } = await fixtureDir('dfv-sec-net-');
  let hits = 0;
  const server = createServer((req, res) => {
    hits++;
    if (req.url?.startsWith('/redirect')) { res.writeHead(302, { location: '/data.csv' }); res.end(); return; }
    res.end(`id,value\n1,${CANARY}\n`);
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  let file: DuckDbFile | undefined;
  try {
    const source = join(docs, 'approved.csv');
    await writeFile(source, 'id,value\n1,10\n');
    file = await DuckDbFile.open(source, undefined, { restrictedReads: true });
    const urls = [`http://127.0.0.1:${port}/data.csv`, `https://127.0.0.1:${port}/data.csv`,
      `http://127.0.0.1:${port}/redirect`, `http://user:SYNTHETIC_PASSWORD@127.0.0.1:${port}/data.csv`,
      `s3://synthetic-bucket/data.csv`, `http://localhost:${port}/data.csv?token=SYNTHETIC_TOKEN`];
    for (const url of urls) {
      for (const sql of [`select * from read_csv(${lit(url)})`, `select * from ${lit(url)}`,
        `select * from read_text(${lit(url)})`, `select * from approved where value in (select value from read_csv(${lit(url)}))`]) {
        assertNoLeak(await everyReadPath(file, sql, 'value'), sql);
      }
    }
    assert.equal(hits, 0, 'no connection attempt reached the local listener');
    assert.equal((await file.runQuery('select * from approved')).rows.length, 1);
  } finally {
    file?.dispose();
    await new Promise<void>(r => server.close(() => r()));
    await rm(root, { recursive: true, force: true });
  }
});

test('SEC-07: a stored external view in a .duckdb file makes no request during open, catalog or preview', async () => {
  const { root, docs } = await fixtureDir('dfv-sec-net-view-');
  let hits = 0;
  const server = createServer((_req, res) => { hits++; res.end(`id\n${CANARY}\n`); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  let file: DuckDbFile | undefined;
  try {
    const path = join(docs, 'remote.duckdb');
    const instance = await DuckDBInstance.create(path);
    const c = await instance.connect();
    await c.run('create table local_data as select 1 as id');
    // The view body is stored as SQL text; creating it does not fetch.
    await c.run(`create view remote_view as select * from read_csv('http://127.0.0.1:${port}/x.csv', columns={'id':'varchar'})`);
    c.closeSync(); instance.closeSync();
    hits = 0;
    file = await DuckDbFile.open(path, undefined, { restrictedReads: true });
    await file.listTables();
    await file.getQueryCatalog();
    assertNoLeak(await everyReadPath(file, 'select * from remote_view', 'id'), 'remote_view');
    assert.equal((await file.runQuery('select * from local_data')).rows.length, 1);
    assert.equal(hits, 0);
  } finally {
    file?.dispose();
    await new Promise<void>(r => server.close(() => r()));
    await rm(root, { recursive: true, force: true });
  }
});

test('SEC-08–10: writes, DDL, COPY/ATTACH, settings and extensions change nothing', async () => {
  const { root, docs } = await fixtureDir('dfv-sec-write-');
  let file: DuckDbFile | undefined;
  try {
    const path = join(docs, 'store.duckdb');
    const instance = await DuckDBInstance.create(path);
    const c = await instance.connect();
    await c.run('create table data as select range as id, range * 10 as value from range(3)');
    await c.run('create sequence seq');
    c.closeSync(); instance.closeSync();
    const before = await sha(path);
    const listing = (await readdir(docs)).sort();
    const target = join(docs, 'written.csv');
    file = await DuckDbFile.open(path, undefined, { restrictedReads: true });
    const writes = [
      'delete from data', 'update data set value = 0', 'insert into data values (9, 90)',
      'create table t2 as select 1', 'create view v2 as select 1', 'drop table data', 'alter table data add column z int',
      `copy data to ${lit(target)}`, `copy (select * from data) to ${lit(target)} (format csv)`,
      `export database ${lit(join(docs, 'exported'))}`, `attach ${lit(join(docs, 'new.duckdb'))} as n`,
      "attach ':memory:' as m", 'detach sibling', 'use system', 'install httpfs', 'load httpfs', 'force install httpfs',
      'set enable_external_access = true', "set allowed_paths = ['/']", 'reset lock_configuration',
      "pragma enable_profiling", "pragma database_size", 'call checkpoint()', 'checkpoint', 'vacuum', 'begin transaction',
      "select nextval('seq')", 'select setseed(0.5)', "call pragma_version()",
      'select 1; delete from data', 'select 1;; delete from data', '/* x */ delete from data',
      '/* outer /* nested */ */ delete from data', '-- c\ndelete from data', 'with x as (select 1) delete from data',
      "select $$ ; delete from data $$ as value; delete from data", 'delete from data returning *',
      "select * from (select 1) t; copy data to 'x.csv'", 'create macro m() as 1', 'create secret s (type s3)',
      "create temp table t3 as select 1", "summarize data; delete from data", 'explain analyze delete from data',
      `select * from data where id = 1 union all select * from data; copy data to ${lit(target)}`,
    ];
    for (const sql of writes) {
      const outcomes = await everyReadPath(file, sql, 'value');
      for (const [i, outcome] of outcomes.entries()) {
        if (i === 2 || i === 7) continue; // counts return undefined; editability describes, both checked by side effects below
        assert.ok(outcome && typeof outcome === 'object' && 'refused' in outcome, `accepted as a read: ${sql} (path ${i})`);
      }
    }
    assert.equal((await file.runQuery('select count(*) from data')).rows[0][0] + '', '3', 'data unchanged and reader usable');
    file.dispose(); file = undefined;
    assert.equal(await sha(path), before, 'document bytes unchanged');
    assert.deepEqual((await readdir(docs)).sort(), listing, 'no file created beside the document');
  } finally { file?.dispose(); await rm(root, { recursive: true, force: true }); }
});

test('SEC-11–13: only this document\'s relations are reachable; internal catalogs are not', async () => {
  const { root, docs } = await fixtureDir('dfv-sec-cat-');
  const files: DuckDbFile[] = [];
  try {
    const mk = async (name: string, secret: string) => {
      const p = join(docs, `${name}.duckdb`);
      const instance = await DuckDBInstance.create(p);
      const c = await instance.connect();
      await c.run('create schema other');
      await c.run(`create table data as select 1 as id, '${name}' as value`);
      await c.run(`create table other.data as select 2 as id, '${secret}' as value`);
      c.closeSync(); instance.closeSync();
      return p;
    };
    const aPath = await mk('alpha', 'ALPHA_OTHER_SCHEMA');
    const bPath = await mk('beta', CANARY);
    // A backup catalog is attached for Safe Mode comparison; it must not be queryable.
    const backup = join(root, 'backup.duckdb');
    await writeFile(backup, await readFile(bPath));
    const a = await DuckDbFile.open(aPath, undefined, { restrictedReads: true, backupPath: backup });
    const b = await DuckDbFile.open(bPath, undefined, { restrictedReads: true });
    files.push(a, b);
    assert.equal((await a.runQuery('select value from other.data')).rows[0][0], 'ALPHA_OTHER_SCHEMA', 'same-name relation in another schema of the SAME document stays distinct and reachable');
    assert.equal((await a.runQuery('select value from data')).rows[0][0], 'alpha');
    // Prove the internal catalog really is attached (so the refusals below are
    // not vacuous): the host comparison reads it and sees the other document's rows.
    assert.equal((await a.compareToBackup())['data'], 'changed');
    const catalog = await a.getQueryCatalog();
    assert.ok(catalog.every(r => !/backup|sibling|system|temp|__/i.test(r.catalog)), JSON.stringify(catalog));
    assert.deepEqual(catalog.map(r => `${r.schema}.${r.name}`).sort(), ['main.data', 'other.data']);
    for (const sql of [
      'select * from backup_cmp.data', 'select * from backup_cmp.other.data', 'select * from beta.data', 'select * from beta.other.data',
      'select * from system.main.duckdb_tables', 'select * from temp.main.data', 'select * from memory.main.data',
      'select * from information_schema.tables', 'select * from pg_catalog.pg_tables', 'select * from sqlite_master',
      'select * from "backup_cmp"."other"."data"', 'select * from duckdb_tables()', 'select * from sibling.data',
    ]) assertNoLeak(await everyReadPath(a, sql, 'value'), sql);
  } finally { for (const f of files) f.dispose(); await rm(root, { recursive: true, force: true }); }
});

test('SEC-01/SEC-13: a workbook reader cannot address hidden raw sheets or outside files', async () => {
  const { root, docs, outside } = await fixtureDir('dfv-sec-xlsx-');
  let file: DuckDbFile | undefined;
  try {
    const path = await xlsxFile(join(docs, 'book.xlsx'), [
      { name: 'Data', rows: [['id', 'value'], [1, 10], [2, 20]] },
      { name: 'Other', rows: [['id', 'value'], [3, 30]] },
    ]);
    const before = await sha(path);
    file = await DuckDbFile.open(path, undefined, { restrictedReads: true });
    assert.equal((await file.runQuery('select count(*) from "Data · Table 1"')).rows[0][0] + '', '2');
    for (const sql of [
      `select * from read_xlsx(${lit(path)})`, `select * from read_xlsx(${lit(outside)})`,
      ...outsideReads(outside, docs).slice(0, 40),
    ]) assertNoLeak(await everyReadPath(file, sql, 'value'), sql);
    file.dispose(); file = undefined;
    assert.equal(await sha(path), before);
  } finally { file?.dispose(); await rm(root, { recursive: true, force: true }); }
});

test('SEC-13: the hidden SQLite source catalog behind the typed views is not addressable', async () => {
  const { root, docs } = await fixtureDir('dfv-sec-sqlite-');
  let file: DuckDbFile | undefined;
  try {
    const path = await sqliteFile(join(docs, 'hot.sqlite'), [{ name: 'data',
      columns: [{ name: 'id', type: 'INTEGER' }, { name: 'value', type: 'VARCHAR' }],
      rows: [[1, CANARY], [2, 'ok']] }]);
    const before = await sha(path);
    file = await DuckDbFile.open(path, undefined, { restrictedReads: true });
    const catalog = (await file.getQueryCatalog())[0].catalog;
    assert.equal((await file.runQuery("select id from data where value = 'ok'")).rows[0][0] + '', '2');
    const hidden = `${catalog}__dfv_sqlite_source`;
    for (const sql of [`select * from "${hidden}".data`, `select * from "${hidden}".main.data`,
      `select * from sqlite_scan(${lit(path)}, 'data')`, `select * from sqlite_master`]) {
      const outcomes = await everyReadPath(file, sql, 'value');
      assert.ok(outcomes.every((o, i) => i === 2 || i === 7 || (o && typeof o === 'object' && 'refused' in o)), `reachable: ${sql}`);
    }
    file.dispose(); file = undefined;
    assert.equal(await sha(path), before);
  } finally { file?.dispose(); await rm(root, { recursive: true, force: true }); }
});
