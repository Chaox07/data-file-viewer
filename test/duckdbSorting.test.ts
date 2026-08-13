import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { DuckDbFile } from '../src/duckdbConnection';
import { computeSortOrder, type SortKind } from '../src/sortOrder';

/**
 * The regression these tests exist for: a LIMIT-ed result is sorted by DuckDB
 * (server round-trip), everything else is sorted by computeSortOrder in the
 * webview. If the two disagree, the grid contradicts itself depending on
 * whether the query happened to end in a LIMIT — and worse, the client can
 * scramble a correct server-computed top-N back into a wrong one.
 *
 * So these assert the two orderings *agree*, against real DuckDB output, on
 * exactly the types that used to be handled wrong.
 */

let dir: string;
let dbPath: string;

const NAMES = ['Zebra', 'apple', 'çilek', 'Şeker', 'ıspanak', 'item10', 'item9'];

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dfv-sort-'));
  dbPath = join(dir, 'fixture.duckdb');
  const instance = await DuckDBInstance.create(dbPath);
  const connection = await instance.connect();
  await connection.run(`create table t (
    id integer,
    big bigint,
    huge hugeint,
    dec decimal(30, 4),
    ts timestamp,
    name varchar
  )`);
  const rows = NAMES.map((name, i) => {
    const big = [9n, 10n, 100n, 1000n, -5n, 1152921504606846976n, 1152921504606846975n][i];
    // Cast before multiplying — the product leaves INT64 range, which is
    // exactly why the column is HUGEINT and why the client needs an exact
    // comparison path for it.
    return `(${i}, ${big}, ${big}::hugeint * 1000000000000, ${(i * 3.25 - 4).toFixed(4)}, timestamp '2024-0${
      (i % 9) + 1
    }-15 0${i}:30:00', '${name}')`;
  });
  await connection.run(`insert into t values ${rows.join(', ')}`);
  await connection.run(`insert into t values (99, null, null, null, null, null)`);
  connection.closeSync();
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

const COLUMNS: { name: string; kind: SortKind }[] = [
  { name: 'big', kind: 'numeric' },
  { name: 'huge', kind: 'numeric' },
  { name: 'dec', kind: 'numeric' },
  { name: 'ts', kind: 'datetime' },
];

for (const { name, kind } of COLUMNS) {
  for (const direction of ['asc', 'desc'] as const) {
    test(`client and DuckDB agree on ${name} ${direction}`, async () => {
      const file = await DuckDbFile.open(dbPath);
      try {
        // What the server produces for a LIMIT-ed query (the sortQuery path).
        const server = await file.runSortedQuery('select * from t limit 100', name, direction);
        assert.match(server.sortedSql, /order by/i, 'the SQL it ran is handed back for the backup diff');

        // What the client produces for the same rows (the no-LIMIT path).
        const unsorted = await file.runQuery('select * from t');
        const colIdx = unsorted.columns.indexOf(name);
        assert.notEqual(colIdx, -1);
        assert.equal(unsorted.columnStatsKind[colIdx], kind, 'server-derived kind matches the fixture');

        const idIdx = unsorted.columns.indexOf('id');
        const clientIds = computeSortOrder(unsorted.rows, colIdx, direction, kind).map((i) =>
          String(unsorted.rows[i][idIdx])
        );
        const serverIds = server.rows.map((r) => String(r[server.columns.indexOf('id')]));

        assert.deepEqual(clientIds, serverIds, `${name} ${direction}: client order must match DuckDB's`);
      } finally {
        file.dispose();
      }
    });
  }
}

test('runSortedQuery sorts across the full data set, not just the LIMIT window', async () => {
  const file = await DuckDbFile.open(dbPath);
  try {
    // Two rows only, but chosen from all eight — the largest two, not two
    // arbitrary rows then sorted.
    const result = await file.runSortedQuery('select * from t limit 2', 'big', 'desc');
    assert.equal(result.rows.length, 2);
    const bigIdx = result.columns.indexOf('big');
    assert.deepEqual(
      result.rows.map((r) => String(r[bigIdx])),
      ['1152921504606846976', '1152921504606846975']
    );
  } finally {
    file.dispose();
  }
});

test('refreshInPlace declines for .duckdb and succeeds for a flat file', async () => {
  // .duckdb pins an MVCC snapshot for the life of the instance, so it must
  // report that only a full re-open can see another process's commits.
  const db = await DuckDbFile.open(dbPath, undefined, { forceReadOnly: true });
  try {
    assert.equal(await db.refreshInPlace(), false, '.duckdb requires a re-open');
  } finally {
    db.dispose();
  }

  // A CSV view re-reads the file on every query, so there is nothing to do and
  // the live path can skip rebuilding the connection entirely.
  const csvPath = join(dir, 'flat.csv');
  await writeFile(csvPath, 'a,b\n1,x\n2,y\n');
  const csv = await DuckDbFile.open(csvPath, undefined, { forceReadOnly: true });
  try {
    assert.equal(await csv.refreshInPlace(), true, 'flat files need no reconnect');
    assert.equal(csv.isReadOnly(), true, 'forceReadOnly is honoured for flat files too');

    // And the cheap path genuinely observes a writer's changes.
    await writeFile(csvPath, 'a,b\n1,x\n2,y\n3,z\n');
    assert.equal(await csv.refreshInPlace(), true);
    const after = await csv.runQuery('select count(*) as n from flat');
    assert.equal(String(after.rows[0][0]), '3', 'the new row is visible without a re-open');
  } finally {
    csv.dispose();
  }
});
