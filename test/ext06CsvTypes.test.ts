import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DuckDbFile } from '../src/duckdbConnection';

/**
 * EXT-06 -- the CSV sniffer keeps typing the file, and is checked where it can
 * lose a value.
 *
 * E23 is pinned in integrityFindings.test.ts. The user's decision (2026-09-13)
 * was "sniff, then verify" over "the viewer types everything": read_csv_auto is
 * what makes a date a DATE, and replacing it would stake every date column on
 * new code to fix a defect that only ever happens in DOUBLE columns. So the
 * controls here matter as much as the fixes -- a column the sniffer typed right
 * must come out exactly as it did before.
 */

let dir: string;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dfv-ext06-'));
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function csv(name: string, text: string): Promise<string> {
  const path = join(dir, `${name}.csv`);
  await writeFile(path, text, 'utf8');
  return path;
}

async function typesOf(file: DuckDbFile, table: string): Promise<Record<string, string>> {
  const r = await file.runQuery(`describe select * from "${table}"`);
  const name = r.columns.indexOf('column_name');
  const type = r.columns.indexOf('column_type');
  return Object.fromEntries(r.rows.map((row) => [String(row[name]), String(row[type])]));
}

async function valuesOf(file: DuckDbFile, table: string, column: string): Promise<string[]> {
  const r = await file.runQuery(`select "${column}" from "${table}"`);
  return r.rows.map((row) => String(row[0]));
}

test('EXT-06: the decision fixture — ids exact, dates still dates', async () => {
  // The two CSVs the decision was asked with, as one file: what the fix buys,
  // beside what reading everything as text would have cost.
  const path = await csv(
    'side',
    'id,trade_date,stamp,price,mixed,code\n' +
      '12345678901234567890123,2026-01-02,2026-01-02 09:30:00,1.5,1.5,007\n' +
      '12345678901234567890124,2026-01-05,2026-01-05 16:00:00,2.25,9007199254740993,010\n'
  );
  const file = await DuckDbFile.open(path);
  try {
    assert.deepEqual(await typesOf(file, 'side'), {
      id: 'HUGEINT',
      trade_date: 'DATE',
      stamp: 'TIMESTAMP',
      price: 'DOUBLE',
      mixed: 'VARCHAR',
      code: 'VARCHAR',
    });
    assert.deepEqual(await valuesOf(file, 'side', 'id'), ['12345678901234567890123', '12345678901234567890124']);
    assert.deepEqual(await valuesOf(file, 'side', 'mixed'), ['1.5', '9007199254740993']);
    const notices = file.openWarnings.join('\n');
    assert.match(notices, /"id", "mixed"/, `the retyped columns were not named: ${notices}`);
  } finally {
    file.dispose();
  }
});

test('EXT-06 control: every type the sniffer gets right is unchanged', async () => {
  const path = await csv(
    'sniffed',
    'd1,d3,b,t,n,ts\n' +
      '2026-01-02,20260102,true,09:30,42,2026-01-02T09:30:00\n' +
      '2026-01-15,20260115,false,16:00,-7,2026-01-15T16:00:00\n'
  );
  const file = await DuckDbFile.open(path);
  try {
    assert.deepEqual(await typesOf(file, 'sniffed'), {
      d1: 'DATE',
      d3: 'BIGINT',
      b: 'BOOLEAN',
      t: 'TIME',
      n: 'BIGINT',
      ts: 'TIMESTAMP',
    });
    assert.equal(file.openWarnings.length, 0, file.openWarnings.join('\n'));
  } finally {
    file.dispose();
  }
});

test('EXT-06 control: ordinary and scientific doubles stay DOUBLE', async () => {
  // Each of these prints back differently from how it was written, and none of
  // them loses a value: a check that compared characters would retype them all.
  // (`inf` and `nan` are not here because read_csv_auto types such a column
  // VARCHAR on its own -- measured -- so it never reaches this check.)
  const path = await csv(
    'doubles',
    'price,avogadro,long\n1.50,6.022e23,0.1234567890123456789\n1e3,1.5E-10,-123456.78901234567\n' +
      '-0.5,3.0e8,1.25\n12.25,2e0,0.30000000000000004\n'
  );
  const file = await DuckDbFile.open(path);
  try {
    assert.deepEqual(await typesOf(file, 'doubles'), { price: 'DOUBLE', avogadro: 'DOUBLE', long: 'DOUBLE' });
    assert.equal(file.openWarnings.length, 0, file.openWarnings.join('\n'));
  } finally {
    file.dispose();
  }
});

test('EXT-06: decimals written past a double\'s precision stay numbers', async () => {
  // The user's decision on 2026-09-13: 966.41641389214044 shown as
  // 966.4164138921404 is a measurement at a double's precision, not a changed
  // value. Under the stricter 15-decimal-place test every column like this one
  // -- what a program writing floats at full precision produces -- became text.
  // The integer column beside it is the other half: an id still has to be exact.
  const path = await csv(
    'precision',
    'a,b,id\n966.41641389214044,-218.89959204133902,12345678901234567890123\n' +
      '278.74005196960428,0.000123456789012345678,12345678901234567890124\n'
  );
  const file = await DuckDbFile.open(path);
  try {
    assert.deepEqual(await typesOf(file, 'precision'), { a: 'DOUBLE', b: 'DOUBLE', id: 'HUGEINT' });
    assert.doesNotMatch(file.openWarnings.join('\n'), /"a"|"b"/);
  } finally {
    file.dispose();
  }
});

test('EXT-06 control: an integer that a double holds exactly is not retyped', async () => {
  // 16 digits, below 2^53: longer than the 15-character skip, so it is checked,
  // and it survives. Mixed with decimals so the sniffer types the column DOUBLE.
  const path = await csv('exact16', 'v\n1234567890123456\n0.5\n');
  const file = await DuckDbFile.open(path);
  try {
    assert.equal((await typesOf(file, 'exact16')).v, 'DOUBLE');
  } finally {
    file.dispose();
  }
});

test('EXT-06: a Turkish-decimal file is checked in its own convention', async () => {
  // Read with European separators, so the check has to normalise `1.234,56`
  // the same way or it would call every amount a loss.
  const path = await csv(
    'turkish',
    'tutar;kimlik\n1.234,56;12345678901234567890123\n2.345,67;12345678901234567890124\n98,10;12345678901234567890125\n'
  );
  const file = await DuckDbFile.open(path);
  try {
    const types = await typesOf(file, 'turkish');
    assert.equal(types.tutar, 'DOUBLE');
    assert.equal(types.kimlik, 'HUGEINT');
    assert.deepEqual(await valuesOf(file, 'turkish', 'tutar'), ['1234.56', '2345.67', '98.1']);
    assert.deepEqual(await valuesOf(file, 'turkish', 'kimlik'), [
      '12345678901234567890123',
      '12345678901234567890124',
      '12345678901234567890125',
    ]);
  } finally {
    file.dispose();
  }
});

test('EXT-06: a wide value deep in the file is found, not only in the head', async () => {
  // The sniffer samples; the check does not. 5,000 ordinary prices and one
  // 2^53+1 near the end.
  const lines = ['v'];
  for (let i = 0; i < 5000; i++) lines.push(`${i}.25`);
  lines.push('9007199254740993');
  const path = await csv('deep', lines.join('\n') + '\n');
  const file = await DuckDbFile.open(path);
  try {
    assert.equal((await typesOf(file, 'deep')).v, 'VARCHAR');
    const last = await file.runQuery(`select v from "deep" where v = '9007199254740993'`);
    assert.equal(last.rows.length, 1);
  } finally {
    file.dispose();
  }
});

test('EXT-06: an edit to a file with a retyped id column writes every digit back', async () => {
  // EXT-01's write-back serialises the table, so the table's type is what the
  // file gets. As DOUBLE this rewrote the ids as 1.2345678901234568e+22.
  const path = await csv('edit', 'id,qty\n12345678901234567890123,1\n12345678901234567890124,2\n');
  const file = await DuckDbFile.open(path);
  try {
    const r = await file.runQuery('select * from "edit" order by qty');
    const row = Object.fromEntries(r.columns.map((c, i) => [c, r.rows[0][i]]));
    assert.equal(await file.updateCell('edit', 'qty', 5, row), 1);
  } finally {
    file.dispose();
  }
  const text = await readFile(path, 'utf8');
  assert.match(text, /12345678901234567890123,5/);
  assert.match(text, /12345678901234567890124,2/);
});
