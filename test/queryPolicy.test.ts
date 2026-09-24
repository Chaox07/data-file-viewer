import assert from 'node:assert/strict';
import test from 'node:test';
import { DuckDBInstance } from '@duckdb/node-api';
import { readerThreads, restrictQueryEngine, validateSqlSize, validateResultSize, QueryPolicyError, ReadSqlPolicy } from '../src/queryPolicy';

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
      'explain select * from data', 'explain analyze select * from data',
      'describe data', 'summarize select * from data', '/* outer /* nested */ comment */ explain select * from data',
    ]) await policy.validate(sql, relations);
    for (const sql of [
      'select * from bad', 'select secret()', "select current_setting('temp_directory')",
      'select * from duckdb_databases()', 'select * from information_schema.tables',
      'select * from backup_cmp.data', 'select * from read_text(\'/tmp/synthetic\')',
      'select 1; delete from data', 'with x as (select 1) delete from data',
      'call checkpoint()', 'select nextval(\'x\')',
      'explain analyze select * from bad', 'describe duckdb_databases()',
      'with x as (with sqlite_master as (select 1) select 1) select * from sqlite_master',
    ]) await assert.rejects(policy.validate(sql, relations), QueryPolicyError);
    assert.equal((await c.runAndReadAll('select count(*) from data')).getRows()[0][0], 1n);
  } finally { c.closeSync(); instance.closeSync(); }
});

test('result budget refuses rather than truncating a large single value', () => {
  validateResultSize({ rows: [['unchanged']] });
  assert.throws(() => validateResultSize({ rows: [['x'.repeat(32 * 1024 * 1024)]] }), QueryPolicyError);
});

test('result budget enforces per-cell UTF-8 bytes and aggregate payload independently', () => {
  validateResultSize({ rows: [['x'.repeat(4 * 1024 * 1024)]] });
  assert.throws(() => validateResultSize({ rows: [['é'.repeat(2 * 1024 * 1024 + 1)]] }), /4 MiB/);
  assert.throws(() => validateResultSize({ rows: Array.from({ length: 9 }, () => ['x'.repeat(4 * 1024 * 1024)]) }), /32 MiB/);
  validateResultSize({ rows: Array.from({ length: 200000 }, (_, i) => [i]) });
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
    assert.deepEqual(settings, [['enable_external_access','false'], ['max_temp_directory_size','0 bytes'], ['threads', String(readerThreads())]]);
    const cores = require('node:os').cpus().length;
    assert.equal(readerThreads(), Math.max(1, Math.floor((require('node:os').availableParallelism?.() ?? cores) / 2)));
  } finally { c.closeSync(); instance.closeSync(); }
});

test('user macros cannot inherit the grants for built-in range functions', async () => {
  const instance = await DuckDBInstance.create(':memory:');
  const c = await instance.connect();
  try {
    await c.run("create macro range() as current_setting('home_directory')");
    const catalog = String((await c.runAndReadAll('select current_database()')).getRows()[0][0]);
    await restrictQueryEngine(c, []);
    await assert.rejects(new ReadSqlPolicy(c, catalog).validate('select range()', []), /unavailable/);
  } finally { c.closeSync(); instance.closeSync(); }
});

test('the one-scan function allowlists equal the two separate scans they replaced', async () => {
  const instance = await DuckDBInstance.create(':memory:');
  const c = await instance.connect();
  try {
    await c.run('load excel');
    await c.run("create macro unnest(x) as x");
    await c.run("create macro lower_macro(x) as lower(x)");
    const names = async (sql: string) => new Set((await c.runAndReadAll(sql)).getRows().map(row => String(row[0]).toLowerCase()));
    const functions = await names(`select function_name from system.main.duckdb_functions()
      group by function_name having bool_and(internal)
      and bool_and(function_type in ('scalar','aggregate','macro'))
      and not bool_or(coalesce(has_side_effects,false))`);
    const tableFunctions = await names(`select function_name from system.main.duckdb_functions()
      where function_name in ('range','generate_series','unnest')
      group by function_name having bool_and(internal)`);
    const catalog = String((await c.runAndReadAll('select current_database()')).getRows()[0][0]);
    const policy = new ReadSqlPolicy(c, catalog);
    await policy.validate('select 1', []);
    const loaded = policy as unknown as { functions: Set<string>; tableFunctions: Set<string> };
    assert.deepEqual([...loaded.functions].sort(), [...functions].sort());
    assert.deepEqual([...loaded.tableFunctions].sort(), [...tableFunctions].sort());
    assert.ok(!loaded.tableFunctions.has('unnest') && !loaded.functions.has('lower_macro'), 'user macros are not granted');
  } finally { c.closeSync(); instance.closeSync(); }
});
