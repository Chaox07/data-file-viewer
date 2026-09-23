import assert from 'node:assert/strict';
import test from 'node:test';
import { DuckDBInstance } from '@duckdb/node-api';
import { restrictQueryEngine, validateSqlSize, validateResultSize, QueryPolicyError, ReadSqlPolicy } from '../src/queryPolicy';

test('SQL payload budget uses bytes and rejects invalid values before native access', () => {
  for (const value of [null, [], {}, '', ' ', 'é'.repeat(131073)]) assert.throws(() => validateSqlSize(value), QueryPolicyError);
  validateSqlSize('select 1');
  validateSqlSize('x'.repeat(262144));
});

test('native AST policy accepts ordinary queries and rejects side effects, macros and metadata through views', async () => {
  const instance = await DuckDBInstance.create(':memory:');
  const c = await instance.connect();
  try {
    await c.run('create table data(i integer, "Date" date)');
    await c.run("insert into data values (1, DATE '1990-01-01')");
    await c.run('create view good as select * from data');
    await c.run('create view bad as select * from duckdb_databases()');
    await c.run("create macro secret() as current_setting('temp_directory')");
    const views = (await c.runAndReadAll('select view_name,sql from duckdb_views() where not internal')).getRows();
    const catalog = String((await c.runAndReadAll('select current_database()')).getRows()[0][0]);
    const relations = [{ catalog, schema: 'main', name: 'data' }, ...views.map(row => ({ catalog, schema: 'main', name: String(row[0]), viewSql: String(row[1]) }))];
    await restrictQueryEngine(c, []);
    const policy = new ReadSqlPolicy(c, catalog);
    for (const sql of [
      'select * from data',
      'select * from good',
      'select count(*) from data where i > 0',
      `select * from data where "Date" >= DATE '1990-01-01' limit 100`,
      'with x as (select * from data) select * from x',
      'select * from data a join data b on a.i=b.i',
      'select sum(i) from range(10) t(i)',
    ]) await policy.validate(sql, relations);
    for (const sql of [
      'select * from bad', 'select secret()', "select current_setting('temp_directory')",
      'select * from duckdb_databases()', 'select * from information_schema.tables',
      'select * from backup_cmp.data', 'select * from read_text(\'/tmp/synthetic\')',
      'select 1; delete from data', 'with x as (select 1) delete from data',
      'call checkpoint()', 'select nextval(\'x\')',
      'with x as (with sqlite_master as (select 1) select 1) select * from sqlite_master',
    ]) await assert.rejects(policy.validate(sql, relations), QueryPolicyError);
    assert.equal((await c.runAndReadAll('select count(*) from data')).getRows()[0][0], 1n);
  } finally { c.closeSync(); instance.closeSync(); }
});

test('result budget refuses rather than truncating a large single value', () => {
  validateResultSize({ rows: [['unchanged']] });
  assert.throws(() => validateResultSize({ rows: [['x'.repeat(32 * 1024 * 1024)]] }), QueryPolicyError);
});

test('engine policy locks capabilities, bounds memory and disables spill', async () => {
  const instance = await DuckDBInstance.create(':memory:');
  const c = await instance.connect();
  try {
    await restrictQueryEngine(c, []);
    assert.deepEqual((await c.runAndReadAll('select 42')).getRows(), [[42]]);
    for (const sql of ['set enable_external_access=true', 'set lock_configuration=false', 'set autoload_known_extensions=true', "set allowed_paths=['/']"] ) {
      await assert.rejects(c.run(sql));
    }
    const settings = (await c.runAndReadAll("select name,value from duckdb_settings() where name in ('threads','max_temp_directory_size','enable_external_access') order by name")).getRows();
    assert.deepEqual(settings, [['enable_external_access','false'], ['max_temp_directory_size','0 bytes'], ['threads','2']]);
  } finally { c.closeSync(); instance.closeSync(); }
});
