import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DuckDbFile } from '../src/duckdbConnection';

/**
 * SQLite columns declared with no type -- INT-01's last known failure.
 *
 * `create table places (id, name, value real)` is legal SQLite and says
 * nothing about what `id` and `name` hold; SQLite keeps each value's own
 * storage class instead. DuckDB's sqlite scanner has only the declared type to
 * go on, so it read those columns as BLOB, and the viewer showed "İstanbul" as
 * "\xC4\xB0stanbul", refused to filter by it, and could not edit any cell of
 * such a row. See src/sqliteTypes.ts.
 *
 * Every check here reads the file back with node:sqlite as well -- a reader
 * that is not DuckDB and not this extension. That is the point of the edit
 * cases in particular: "the grid shows what I typed" is not the claim. The
 * claim is that the FILE holds it, in the storage class it held before, which
 * only a second reader can say.
 *
 * The controls matter as much as the fixes: a declared `blob` column must
 * still be a blob, a column genuinely mixing text and numbers must keep the
 * behaviour it has today rather than this guessing, and an ordinary typed
 * file must be entirely unaffected by any of it.
 */

let dir: string;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dfv-sqlite-untyped-'));
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Builds a SQLite file through SQLite itself -- the only writer that can declare no type. */
function writeDb(name: string, statements: readonly string[]): string {
  const path = join(dir, name);
  const db = new DatabaseSync(path);
  try {
    for (const sql of statements) db.exec(sql);
  } finally {
    db.close();
  }
  return path;
}

/** What SQLite itself says is in a cell: its value and its storage class. */
function readBack(path: string, sql: string): Record<string, unknown>[] {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    // Spread into ordinary objects: node:sqlite returns null-prototype rows.
    return (db.prepare(sql).all() as Record<string, unknown>[]).map((row) => ({ ...row }));
  } finally {
    db.close();
  }
}

const FOREIGN = [
  // No type at all on id/name: what ETL's writer produced before phase 8, and
  // what plenty of other tools produce.
  `create table places (id, name, value real, raw blob)`,
  `insert into places values ('0007', 'İstanbul', 1.5, x'c4b0ff')`,
  `insert into places values ('0008', 'Ankara', null, null)`,
  // Untyped, holding whole numbers.
  `create table counts (label, n)`,
  `insert into counts values ('a', 1)`,
  `insert into counts values ('b', 22)`,
  // Untyped, holding whole numbers and decimals.
  `create table money (amount)`,
  `insert into money values (1)`,
  `insert into money values (2.5)`,
  // Untyped, holding both text and a number: genuinely ambiguous.
  `create table mixed (v)`,
  `insert into mixed values ('İzmir')`,
  `insert into mixed values (5)`,
];

function foreignDb(name: string): string {
  return writeDb(name, FOREIGN);
}

test('text in a column declared with no type reads as that text', async () => {
  const file = await DuckDbFile.open(foreignDb('read-text.sqlite'));
  try {
    const result = await file.runQuery('select id, name from places order by id');
    assert.deepEqual(result.rows[0], ['0007', 'İstanbul']);
    // The identifier keeps its leading zeros: read as text, not as a number.
    assert.equal(result.rows[1][0], '0008');
  } finally {
    file.dispose();
  }
});

test('such a column can be filtered by a non-ASCII value', async () => {
  const file = await DuckDbFile.open(foreignDb('filter-text.sqlite'));
  try {
    // This is the query that used to fail outright: "Invalid byte encountered
    // in STRING -> BLOB conversion of string "İstanbul"".
    const result = await file.runQuery(`select value from places where name = 'İstanbul'`);
    assert.deepEqual(result.rows, [[1.5]]);
  } finally {
    file.dispose();
  }
});

test('whole numbers in an untyped column are numbers, not bytes', async () => {
  const file = await DuckDbFile.open(foreignDb('read-int.sqlite'));
  try {
    const result = await file.runQuery('select label from counts where n > 5');
    assert.deepEqual(result.rows, [['b']]);
    const total = await file.runQuery('select sum(n) as total from counts');
    assert.equal(Number(total.rows[0][0]), 23);
  } finally {
    file.dispose();
  }
});

test('an untyped column mixing whole numbers and decimals reads as decimals', async () => {
  const file = await DuckDbFile.open(foreignDb('read-double.sqlite'));
  try {
    const result = await file.runQuery('select sum(amount) as total from money');
    assert.equal(Number(result.rows[0][0]), 3.5);
  } finally {
    file.dispose();
  }
});

test('control: a column genuinely mixing text and numbers is left as it was', async () => {
  const file = await DuckDbFile.open(foreignDb('mixed.sqlite'));
  try {
    // Nothing here can say whether that column is text or numbers, because it
    // is both -- so it keeps the reading it has always had rather than this
    // picking a side, and the file is not quietly reinterpreted.
    const result = await file.runQuery('select v from mixed order by v');
    assert.match(String(result.rows[1][0]), /^\\x/);
    await assert.rejects(() => file.runQuery(`select * from mixed where v = 'İzmir'`));
    assert.equal(file.openWarnings.join('\n').includes('"v"'), false);
  } finally {
    file.dispose();
  }
});

test('control: a column declared blob stays a blob', async () => {
  const file = await DuckDbFile.open(foreignDb('blob.sqlite'));
  try {
    // x'c4b0ff' is not valid UTF-8 and was never meant to be text. "Declared
    // with no type" is the trigger; a declared blob means what it says.
    const result = await file.runQuery(`select raw from places where id = '0007'`);
    assert.match(String(result.rows[0][0]), /^\\x/);
  } finally {
    file.dispose();
  }
});

test('the file is told about, so the grid does not silently differ from the file', async () => {
  const file = await DuckDbFile.open(foreignDb('notice.sqlite'));
  try {
    const notices = file.openWarnings.join('\n');
    assert.match(notices, /places/);
    assert.match(notices, /declares no type/);
  } finally {
    file.dispose();
  }
});

test('an edit to such a column is stored by SQLite as text, as it was before', async () => {
  const path = foreignDb('edit-text.sqlite');
  const file = await DuckDbFile.open(path);
  try {
    const changed = await file.updateCell('places', 'name', 'İzmir', {
      id: '0007',
      name: 'İstanbul',
      value: 1.5,
    });
    assert.equal(changed, 1);
  } finally {
    file.dispose();
  }
  // Read by SQLite itself: the value, and the class it is stored as. Written
  // as a BLOB it would read back as bytes here, and every other program
  // reading this file would see the change.
  const rows = readBack(path, `select name, typeof(name) as class from places where id = '0007'`);
  assert.deepEqual(rows, [{ name: 'İzmir', class: 'text' }]);
});

test('an edit to a typed column of the same row works, and leaves the rest alone', async () => {
  const path = foreignDb('edit-neighbour.sqlite');
  const file = await DuckDbFile.open(path);
  try {
    // This used to fail for a reason that had nothing to do with the column
    // being edited: matching the row meant comparing "İstanbul" against a BLOB
    // column, so no cell of this row could be edited at all.
    const changed = await file.updateCell('places', 'value', 9.75, {
      id: '0007',
      name: 'İstanbul',
      value: 1.5,
    });
    assert.equal(changed, 1);
  } finally {
    file.dispose();
  }
  const rows = readBack(path, `select name, typeof(name) as class, value from places where id = '0007'`);
  assert.deepEqual(rows, [{ name: 'İstanbul', class: 'text', value: 9.75 }]);
});

test('an edit that matches no row changes nothing and says so', async () => {
  const path = foreignDb('edit-nomatch.sqlite');
  const file = await DuckDbFile.open(path);
  try {
    const changed = await file.updateCell('places', 'name', 'Bursa', {
      id: '0007',
      name: 'İstanbul',
      value: 99, // not what the row holds
    });
    assert.equal(changed, 0);
  } finally {
    file.dispose();
  }
  assert.deepEqual(readBack(path, `select name from places where id = '0007'`), [{ name: 'İstanbul' }]);
});

test('an edit to an untyped column of numbers is refused, rather than storing text', async () => {
  const path = foreignDb('edit-number.sqlite');
  const file = await DuckDbFile.open(path);
  try {
    // A column with no declared type has no affinity, so SQLite would store
    // exactly what it is handed -- and text is all this can hand it. One cell
    // of a column of numbers holding "42" as text is a difference every other
    // reader would see, so it is refused with the reason.
    await assert.rejects(
      () => file.updateCell('counts', 'n', 42, { label: 'a', n: 1 }),
      /declared with no type/
    );
  } finally {
    file.dispose();
  }
  const rows = readBack(path, `select n, typeof(n) as class from counts where label = 'a'`);
  assert.deepEqual(rows, [{ n: 1, class: 'integer' }]);
});

test('two identical rows are still refused rather than edited together', async () => {
  const path = writeDb('edit-ambiguous.sqlite', [
    `create table twins (name)`,
    `insert into twins values ('İstanbul')`,
    `insert into twins values ('İstanbul')`,
  ]);
  const file = await DuckDbFile.open(path);
  try {
    await assert.rejects(
      () => file.updateCell('twins', 'name', 'Ankara', { name: 'İstanbul' }),
      /identical across every column/
    );
  } finally {
    file.dispose();
  }
  assert.deepEqual(readBack(path, `select count(*) as n from twins where name = 'İstanbul'`), [{ n: 2 }]);
});

test('Safe Mode sees an untouched file as unchanged, and an edited one as changed', async () => {
  const path = foreignDb('backup.sqlite');
  const file = await DuckDbFile.open(path);
  try {
    await file.createBackup();
    // Both sides have to be read the same way. Compared raw against retyped,
    // every row of every untyped column would read as changed, and a Safe Mode
    // that cries wolf is worse than none.
    const before = await file.compareToBackup();
    assert.deepEqual(
      Object.values(before).filter((v) => v !== 'unchanged'),
      []
    );
    await file.updateCell('places', 'name', 'İzmir', { id: '0007', name: 'İstanbul', value: 1.5 });
    const after = await file.compareToBackup();
    assert.equal(after.places, 'changed');
    assert.equal(after.counts, 'unchanged');
  } finally {
    file.dispose();
  }
});

test('a live refresh picks up new rows and reads them the same way', async () => {
  const path = foreignDb('refresh.sqlite');
  const file = await DuckDbFile.open(path, undefined, { forceReadOnly: true });
  try {
    assert.equal((await file.runQuery('select * from places')).rows.length, 2);
    const writer = new DatabaseSync(path);
    try {
      writer.exec(`insert into places values ('0009', 'Şanlıurfa', 3.5, null)`);
    } finally {
      writer.close();
    }
    assert.equal(await file.refreshInPlace(), true);
    const result = await file.runQuery(`select name from places where id = '0009'`);
    assert.deepEqual(result.rows, [['Şanlıurfa']]);
  } finally {
    file.dispose();
  }
});

test('a live refresh picks up a table the writer added', async () => {
  const path = foreignDb('refresh-schema.sqlite');
  const file = await DuckDbFile.open(path, undefined, { forceReadOnly: true });
  try {
    const writer = new DatabaseSync(path);
    try {
      writer.exec(`create table later (city)`);
      writer.exec(`insert into later values ('Trabzon')`);
    } finally {
      writer.close();
    }
    await file.refreshInPlace();
    assert.ok((await file.listTables()).includes('later'));
    assert.deepEqual((await file.runQuery('select city from later')).rows, [['Trabzon']]);
  } finally {
    file.dispose();
  }
});

// ===================================================================
// Control: an ordinary, fully declared file is untouched by all of this
// ===================================================================

test('control: a file whose columns are all declared reads and edits as before', async () => {
  const path = writeDb('typed.sqlite', [
    `create table bars (symbol text, close real, n integer)`,
    `insert into bars values ('İSTANBUL', 1.5, 3)`,
    `insert into bars values ('AKBNK', 2.5, 4)`,
  ]);
  const file = await DuckDbFile.open(path);
  try {
    assert.deepEqual(await file.listTables(), ['bars']);
    assert.equal(file.openWarnings.length, 0);
    const result = await file.runQuery(`select close from bars where symbol = 'İSTANBUL'`);
    assert.deepEqual(result.rows, [[1.5]]);
    const changed = await file.updateCell('bars', 'close', 7.25, {
      symbol: 'İSTANBUL',
      close: 1.5,
      n: 3,
    });
    assert.equal(changed, 1);
  } finally {
    file.dispose();
  }
  const rows = readBack(path, `select close, typeof(close) as class from bars where symbol = 'İSTANBUL'`);
  assert.deepEqual(rows, [{ close: 7.25, class: 'real' }]);
});

test('control: an edit to a declared text column still stores text', async () => {
  const path = writeDb('typed-text.sqlite', [
    `create table t (label text, n integer)`,
    `insert into t values ('0007', 1)`,
  ]);
  const file = await DuckDbFile.open(path);
  try {
    assert.equal(await file.updateCell('t', 'label', '0009', { label: '0007', n: 1 }), 1);
  } finally {
    file.dispose();
  }
  assert.deepEqual(readBack(path, `select label, typeof(label) as class from t`), [
    { label: '0009', class: 'text' },
  ]);
});

for (const rowid of ['rowid', 'RoWiD']) {
  test(`a user-defined ${rowid} cannot redirect an edit to multiple rows`, async () => {
    const path = writeDb(`shadow-${rowid === 'rowid' ? 'lower' : 'mixed'}.sqlite`, [
      `create table t (${rowid} integer, name text, value text)`,
      `insert into t values (7, 'a', 'old'), (7, 'b', 'old')`,
    ]);
    const file = await DuckDbFile.open(path);
    try {
      await assert.rejects(() => file.updateCell('t', 'value', 'new', {
        [rowid]: 7, name: 'a', value: 'old',
      }), /unshadowed rowid/);
    } finally { file.dispose(); }
    assert.deepEqual(readBack(path, 'select name, value from t order by name'), [
      { name: 'a', value: 'old' }, { name: 'b', value: 'old' },
    ]);
  });
}

test('untyped REAL values round-trip exactly, including first NULL and exponent extremes', async () => {
  const values = [1.2345678901234567, Number.MIN_VALUE, Number.MAX_VALUE,
    -1.7976931348623157e308, 2.2250738585072014e-308, 0.10000000000000002];
  const path = writeDb('precise-real.sqlite', ['create table t (id integer, value)',
    'insert into t values (0, null)',
    ...values.map((v, i) => `insert into t values (${i + 1}, ${v})`)]);
  const file = await DuckDbFile.open(path);
  try {
    const expected = readBack(path, 'select value from t order by id').map((r) => [r.value]);
    assert.deepEqual((await file.runQuery('select value from t order by id')).rows, expected);
    // Repeated capped streaming queries must release their SQLite snapshot.
    for (let i = 0; i < 3; i++) {
      const result = await file.runQuery('select value from t order by id', 2);
      assert.deepEqual(result.rows, expected.slice(0, 2));
      assert.equal(result.truncated, true);
    }
    await file.createBackup();
    assert.equal((await file.compareToBackup()).t, 'unchanged');
    assert.equal(await file.updateCell('t', 'id', 99, { id: 1, value: values[0] }), 1);
  } finally { file.dispose(); }
  assert.deepEqual(readBack(path, 'select value from t where id = 99'), [{ value: values[0] }]);
});

test('mixed numeric values with wide integers retain exact digits and refuse numeric edits', async () => {
  const path = writeDb('wide-mixed.sqlite', ['create table t (id integer, v)',
    'insert into t values (1, 9007199254740993), (2, 2.5), (3, -9223372036854775808), (4, null)']);
  const file = await DuckDbFile.open(path);
  try {
    assert.deepEqual((await file.runQuery('select v from t order by id')).rows,
      [['9007199254740993'], ['2.5'], ['-9223372036854775808'], [null]]);
    assert.ok(file.openWarnings.some((w) => w.includes('exact numeric text')));
    await assert.rejects(() => file.updateCell('t', 'v', '10', { id: 1, v: '9007199254740993' }),
      /declared with no type/);
  } finally { file.dispose(); }
  assert.deepEqual(readBack(path, 'select cast(v as text) as v from t where id = 1'), [{ v: '9007199254740993' }]);
});

test('exact numeric transport preserves neighboring declared values and BLOB bytes', async () => {
  const path = writeDb('numeric-neighbors.sqlite', [
    'create table t (n, label text, raw blob, count integer, amount real)',
    "insert into t values (null,null,null,null,null), (1.2345678901234567,'İstanbul',x'00ff',42,1.2345678901234567)",
  ]);
  const file = await DuckDbFile.open(path);
  try {
    assert.deepEqual((await file.runQuery('select label, hex(raw), cast(count as varchar), amount from t where n is not null')).rows,
      [['İstanbul', '00FF', '42', 1.2345678901234567]]);
    assert.equal(await file.updateCell('t', 'label', 'İzmir', { n: 1.2345678901234567, label: 'İstanbul', count: 42 }), 1);
  } finally { file.dispose(); }
  assert.deepEqual(readBack(path, 'select label, hex(raw) as raw from t where n is not null'), [{ label: 'İzmir', raw: '00FF' }]);
});

for (const [label, initial, change, query, expected] of [
  ['integer-to-text', 'create table t(v); insert into t values(1)', "insert into t values('text')", 'select count(*) from t', [['2']]],
  ['text-to-integer', "create table t(v); insert into t values('a')", 'delete from t; insert into t values(42)', 'select v from t', [['42']]],
  ['null-to-real', 'create table t(v); insert into t values(null)', 'insert into t values(1.2345678901234567)', 'select v from t where v is not null', [[1.2345678901234567]]],
  ['declared-type', "create table t(v); insert into t values('old')", "drop table t; create table t(v text); insert into t values('new')", 'select v from t', [['new']]],
] as const) {
  test(`refresh rechecks ${label} changes with unchanged column names`, async () => {
    const path = writeDb(`refresh-${label}.sqlite`, [initial]);
    const file = await DuckDbFile.open(path, undefined, { forceReadOnly: true });
    try {
      const writer = new DatabaseSync(path);
      try { writer.exec(change); } finally { writer.close(); }
      assert.equal(await file.refreshInPlace(), true);
      assert.deepEqual((await file.runQuery(query)).rows, expected);
      assert.equal(await file.refreshInPlace(), true);
      assert.deepEqual((await file.runQuery(query)).rows, expected);
    } finally { file.dispose(); }
  });
}

test('numeric transport preserves 8192 deterministic binary64 patterns across all finite exponents', async () => {
  const path = writeDb('binary64-corpus.sqlite', ['create table t (id integer, v)']);
  const db = new DatabaseSync(path);
  try {
    db.exec('begin');
    const insert = db.prepare('insert into t values (?, ?)');
    for (let i = 0; i < 8192; i++) {
      const exponent = BigInt(i % 2047);
      const fraction = (BigInt(i + 1) * 0x9e3779b97f4a7c15n) & ((1n << 52n) - 1n);
      const bytes = Buffer.alloc(8);
      bytes.writeBigUInt64LE((BigInt(i % 2) << 63n) | (exponent << 52n) | fraction);
      insert.run(i, bytes.readDoubleLE());
    }
    db.exec('commit');
  } finally { db.close(); }
  const expected = readBack(path, 'select v from t order by id').map((r) => [r.v]);
  const started = performance.now();
  const file = await DuckDbFile.open(path, undefined, { forceReadOnly: true });
  try {
    assert.deepEqual((await file.runQuery('select v from t order by id')).rows, expected);
    assert.equal(await file.refreshInPlace(), true);
    assert.deepEqual((await file.runQuery('select v from t order by id')).rows, expected);
  } finally { file.dispose(); }
  console.log(`8192 binary64 values, open/read/refresh/read: ${(performance.now() - started).toFixed(0)} ms`);
});

test('unexpected update counts roll back the SQLite transaction', async () => {
  const path = writeDb('update-count.sqlite', ["create table t (name text); insert into t values ('old')"]);
  const file = await DuckDbFile.open(path);
  // Inject a driver misreport after an actual update to prove the guard rolls
  // back a real write, rather than merely refusing before SQL runs.
  const connection = (file as unknown as { connection: { run: (...args: any[]) => Promise<any> } }).connection;
  const run = connection.run.bind(connection);
  connection.run = async (...args: any[]) => {
    const result = await run(...args);
    return /^update /i.test(args[0]) ? { ...result, rowsChanged: 2 } : result;
  };
  try {
    await assert.rejects(() => file.updateCell('t', 'name', 'new', { name: 'old' }), /exactly one row/);
    connection.run = run;
    assert.equal(await file.updateCell('t', 'name', 'retry', { name: 'old' }), 1);
  } finally { file.dispose(); }
  assert.deepEqual(readBack(path, 'select name from t'), [{ name: 'retry' }]);
});
