import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { destructiveReason } from '../src/sqlSafety';
import { DuckDbFile } from '../src/duckdbConnection';

// Plan section 6: compare the Safe Mode scanner with DuckDB's own parser on
// seeded variants. The scanner only chooses a message; the AST policy and the
// locked engine are the gate. So a scanner miss is triaged by requiring the
// restricted reader to refuse that statement anyway, with the file unchanged.

const SEED = Number(process.env.DFV_FUZZ_SEED ?? 20260923);
const RUNS = Number(process.env.DFV_FUZZ_RUNS ?? 600);

function rng(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const READS = ['select * from data', 'select count(*) from data', 'with x as (select * from data) select * from x',
  "select 'delete from data' as s", 'select "update" from (select 1 as "update")', 'from data', 'select * from data where v = $$drop table data$$'];
const WRITES = ['delete from data', 'update data set v = 0', 'insert into data values (9, 9)', 'drop table data',
  "copy data to 'out.csv'", 'create table t as select 1', 'alter table data add column z int', "attach ':memory:' as m",
  'set threads = 1', 'pragma enable_profiling', 'checkpoint', 'vacuum', 'install httpfs', 'with x as (select 1) delete from data',
  'truncate data', 'create or replace view data as select 1 as id, 1 as v', 'call checkpoint()', 'export database \'x\''];
const WRAP: ((s: string) => string)[] = [
  s => s, s => `/* note */ ${s}`, s => `-- note\n${s}`, s => `/* a /* nested */ b */${s}`, s => `  \n\t${s};`,
  s => s.toUpperCase(), s => `${s} -- trailing ; delete`, s => `(${s})`,
];

async function parserVerdict(c: Awaited<ReturnType<Awaited<ReturnType<typeof DuckDBInstance.create>>['connect']>>, sql: string): Promise<'read' | 'other'> {
  const r = await c.runAndReadAll('select json_serialize_sql(?::varchar)', [sql]);
  const ast = JSON.parse(String(r.getRows()[0][0]));
  return !ast.error && Array.isArray(ast.statements) && ast.statements.length === 1 ? 'read' : 'other';
}

test('scanner/parser differential: every scanner miss is still refused by the restricted reader', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dfv-diff-'));
  const instance = await DuckDBInstance.create(':memory:');
  const c = await instance.connect();
  const path = join(dir, 'data.csv');
  await writeFile(path, 'id,v\n1,2\n');
  const before = await readFile(path);
  const file = await DuckDbFile.open(path, undefined, { restrictedReads: true });
  const r = rng(SEED);
  const disagreements: { sql: string; scanner: string; parser: string }[] = [];
  try {
    for (let run = 0; run < RUNS; run++) {
      const pickFrom = r() < 0.5 ? READS : WRITES;
      let sql = WRAP[Math.floor(r() * WRAP.length)](pickFrom[Math.floor(r() * pickFrom.length)]);
      if (r() < 0.25) sql = `${sql}; ${WRITES[Math.floor(r() * WRITES.length)]}`;
      const scanner = destructiveReason(sql) === null ? 'read' : 'write';
      const parser = await parserVerdict(c, sql);
      if (scanner === 'read' && parser === 'other') {
        disagreements.push({ sql, scanner, parser });
        await assert.rejects(file.runQuery(sql), `scanner miss not refused by the reader: ${sql}`);
      }
    }
    assert.equal(String((await file.runQuery('select count(*) from data')).rows[0][0]), '1');
    assert.deepEqual(await readFile(path), before);
    console.log(`scanner/parser: ${disagreements.length} scanner misses in ${RUNS} runs (seed ${SEED}), all refused by the reader`);
    for (const d of disagreements.slice(0, 10)) console.log(`  miss: ${JSON.stringify(d.sql)}`);
  } finally { file.dispose(); c.closeSync(); instance.closeSync(); await rm(dir, { recursive: true, force: true }); }
});
