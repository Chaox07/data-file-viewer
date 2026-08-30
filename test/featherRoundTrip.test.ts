import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { mkdtemp, open, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { DuckDbFile } from '../src/duckdbConnection';

/**
 * Feather, read and written as the FILE encoding it actually is.
 *
 * The two claims worth a real file rather than a unit test:
 *
 * 1. **A saved .feather is still a .feather.** DuckDB writes only the Arrow
 *    IPC *stream* encoding, so the naive save -- `COPY ... (FORMAT arrow)`
 *    straight into the path -- puts stream bytes inside a file named .feather.
 *    This viewer would happily reopen it, because it sniffs magic bytes rather
 *    than trusting the extension, and every other reader (pyarrow, pandas,
 *    polars' read_ipc) would refuse it. The footer magic is the assertion that
 *    catches that, and nothing else does.
 *
 * 2. **The conversion is batch-at-a-time.** Both directions go through
 *    apache-arrow's record-batch readers rather than tableFromIPC/tableToIPC,
 *    so a file larger than comfortable memory converts. A multi-batch fixture
 *    is what makes the difference observable at all: with one batch, a
 *    streaming converter and a whole-table one are the same program.
 */

const ARROW1 = Buffer.from('ARROW1', 'ascii');

let dir: string;

/** Write `rows` as a real Feather (Arrow IPC file) at `path`, in `batches` batches. */
async function writeFeather(path: string, rows: number, batches: number): Promise<void> {
  const { Table, Int32, Utf8, Float64, vectorFromArray, RecordBatchFileWriter, RecordBatchReader } =
    await import('apache-arrow');
  const { createWriteStream } = await import('node:fs');

  // Columns built with explicit types rather than through tableFromArrays,
  // which dictionary-encodes a string array -- a different Arrow type than any
  // of the writers this fixture stands in for actually produce.
  const per = Math.ceil(rows / batches);
  const chunks = Array.from({ length: batches }, (_, b) => {
    const n = Math.min(per, rows - b * per);
    const at = (i: number) => b * per + i;
    return new Table({
      id: vectorFromArray(Array.from({ length: n }, (_, i) => at(i)), new Int32()),
      label: vectorFromArray(Array.from({ length: n }, (_, i) => `row-${at(i)}`), new Utf8()),
      value: vectorFromArray(Array.from({ length: n }, (_, i) => at(i) * 1.5), new Float64()),
    });
  });

  // One Table over all the chunks, via the concatenating Table(...tables) form
  // -- which the typings do not describe, hence the cast. Writing the chunks
  // straight into the writer instead looks equivalent and is not: each carries
  // its own schema OBJECT, the writer treats a new schema as a new file and
  // resets, and the second write dies on a closed queue. Concatenating gives
  // every batch one shared schema, which is also the only arrangement a reader
  // ever hands the converter.
  const table = new (Table as unknown as new (...t: unknown[]) => InstanceType<typeof Table>)(
    ...chunks
  );

  const writer = new RecordBatchFileWriter();
  const out = createWriteStream(path);
  const done = new Promise<void>((resolve, reject) => {
    out.on('finish', resolve);
    out.on('error', reject);
  });
  writer.toNodeStream().pipe(out);
  for (const batch of table.batches) writer.write(batch);
  writer.finish();
  await done;
  // Sanity: the fixture really is the file encoding, and really is multi-batch.
  const head = Buffer.alloc(6);
  const handle = await open(path, 'r');
  await handle.read(head, 0, 6, 0);
  await handle.close();
  assert.ok(head.equals(ARROW1), 'fixture is not Feather-encoded');
  const reader = await RecordBatchReader.from(await readFile(path));
  let seen = 0;
  for (const _ of reader) seen++;
  assert.equal(seen, batches, 'fixture did not come out multi-batch');
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dfv-feather-rt-'));
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

test('a Feather file opens, across every one of its record batches', async () => {
  const path = join(dir, 'read.feather');
  await writeFeather(path, 3000, 3);
  const file = await DuckDbFile.open(path);
  try {
    const r = await file.runQuery('select count(*) as n, max(id) as hi from read');
    assert.equal(Number(r.rows[0][0]), 3000);
    // The last row of the last batch: a converter that stopped after the first
    // batch would still return a plausible count from a plausible table.
    assert.equal(Number(r.rows[0][1]), 2999);
  } finally {
    file.dispose();
  }
});

test('an edited Feather file is written back as Feather, not as a stream', async () => {
  const path = join(dir, 'write.feather');
  await writeFeather(path, 1200, 3);
  const before = (await stat(path)).mtimeMs;

  const file = await DuckDbFile.open(path);
  try {
    const info = await file.checkEditableSelect('select * from write');
    assert.equal(info.editable, true, 'Feather should be editable');
    // Row identity is full-row equality on every column's pre-edit value --
    // see updateCell -- so the whole original row goes in, not just a key.
    const updated = await file.updateCell(info.table!, 'label', 'edited', {
      id: 7,
      label: 'row-7',
      value: 10.5,
    });
    assert.equal(updated, 1);
  } finally {
    file.dispose();
  }

  // Still the FILE encoding: leading magic, and the footer magic that a stream
  // does not have. This is the assertion the whole two-step save exists for.
  const buf = await readFile(path);
  assert.ok(buf.subarray(0, 6).equals(ARROW1), 'saved file lost its Feather header');
  assert.ok(buf.subarray(-6).equals(ARROW1), 'saved file has no Feather footer — it is a stream');
  assert.notEqual((await stat(path)).mtimeMs, before);

  // And it still reads, with the edit in it.
  const reopened = await DuckDbFile.open(path);
  try {
    const r = await reopened.runQuery(`select label from write where id = 7`);
    assert.equal(r.rows[0][0], 'edited');
    const n = await reopened.runQuery('select count(*) from write');
    assert.equal(Number(n.rows[0][0]), 1200);
  } finally {
    reopened.dispose();
  }
});

test('a compressed Feather file is refused by name, not by symptom', async () => {
  // apache-arrow JS carries no IPC codecs, so this cannot be converted. The
  // requirement is that the message says which file and what to do about it --
  // the failure it replaces was a bare codec error naming neither.
  const path = join(dir, 'zstd.feather');
  const dbPath = join(dir, 'src.duckdb');
  const instance = await DuckDBInstance.create(dbPath);
  const connection = await instance.connect();
  await connection.run(`install arrow from community`);
  await connection.run(`load arrow`);
  connection.closeSync();

  // Built by hand: a valid Feather header on bytes that are not a readable
  // table stands in for any file the converter cannot decode.
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path, Buffer.concat([ARROW1, Buffer.alloc(64, 7), ARROW1]));
  await assert.rejects(
    () => DuckDbFile.open(path),
    (err: Error) => {
      assert.match(err.message, /zstd\.feather/);
      return true;
    }
  );
});
