import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DuckDbFile } from '../src/duckdbConnection';

/**
 * The decimal convention, end to end through the real read path.
 *
 * numericLocale.test.ts pins the decision in isolation; this pins that the
 * decision actually reaches DuckDB and changes the column type and value.
 * Both halves matter, because the failure being prevented is invisible on
 * either side alone: a Turkish column read with the default options is a
 * clean VARCHAR, and an English column read with European options is a clean
 * DOUBLE holding a number 1000x too big. Neither raises anything.
 */

let dir: string;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dfv-locale-'));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function csv(name: string, body: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, body, 'utf8');
  return path;
}

/** Open, read the one view, and close — the shape every case here needs. */
async function readAll(
  path: string,
  numberLocale?: 'auto' | 'en' | 'eu'
): Promise<{ file: DuckDbFile; rows: unknown[][]; names: string[] }> {
  const file = await DuckDbFile.open(path, undefined, { numberLocale });
  const tables = await file.listTables();
  const res = await file.runQuery(`select * from "${tables[0].replace(/"/g, '""')}"`);
  return { file, rows: res.rows, names: res.columns };
}

test('a Turkish CSV comes back as numbers, exact', async () => {
  const path = await csv(
    'tr.csv',
    'Tarih;Deger;Oran\n2024-01-31;1.794.446,52;12,5\n2024-02-29;2.145.900,00;13,7\n'
  );
  const { file, rows, names } = await readAll(path);
  try {
    const deger = names.indexOf('Deger');
    const oran = names.indexOf('Oran');
    // The value, not just the type: 1.794.446,52 is one million seven hundred
    // ninety-four thousand, not 1.794446.
    assert.equal(Number(rows[0][deger]), 1794446.52);
    assert.equal(Number(rows[0][oran]), 12.5);
    assert.equal(file.numberLocale?.locale, 'eu');
  } finally {
    file.dispose();
  }
});

test('an English CSV is never mangled by the European path', async () => {
  // The regression ETL's comments record as actually hit: a rule tuned to
  // catch Turkish files started converting English ones.
  const path = await csv('en.csv', 'Date,Value,Rate\n2024-01-31,"1,234.56",12.5\n');
  const { file, rows, names } = await readAll(path);
  try {
    assert.equal(Number(rows[0][names.indexOf('Rate')]), 12.5, 'must not become 125');
    assert.notEqual(file.numberLocale?.locale, 'eu');
  } finally {
    file.dispose();
  }
});

test('an undecidable column is left as text and said out loud', async () => {
  // Nothing here can break the tie, so the only safe answer is no number.
  const path = await csv('ambiguous.csv', 'a\n1.234\n2.345\n3.456\n');
  const { file } = await readAll(path);
  try {
    const notice = file.openWarnings.join('\n');
    assert.match(notice, /left as text/i);
    assert.match(notice, /1\.234/);
    // Both readings are named, so the user can pick rather than be told.
    assert.match(notice, /Turkish/);
    assert.match(notice, /English/);
    assert.match(notice, /numberLocale/);
  } finally {
    file.dispose();
  }
});

test('forcing the locale resolves what the sniff refused', async () => {
  const path = await csv('ambiguous2.csv', 'a\n1.234\n2.345\n');

  const eu = await readAll(path, 'eu');
  try {
    assert.equal(Number(eu.rows[0][0]), 1234);
  } finally {
    eu.file.dispose();
  }

  const en = await readAll(path, 'en');
  try {
    assert.equal(Number(en.rows[0][0]), 1.234);
  } finally {
    en.file.dispose();
  }
  // The same bytes, a factor of 1000 apart. This is what declining to guess
  // is worth.
});

test('a file whose columns disagree is not converted either way', async () => {
  const path = await csv('mixed.csv', 'a;b\n1.794.446,52;1\n2.000,00;2\n');
  const { file } = await readAll(path);
  try {
    // b is a plain integer column, so it carries no convention and cannot
    // conflict; a decides the file.
    assert.equal(file.numberLocale?.locale, 'eu');
  } finally {
    file.dispose();
  }
});

test('an ordinary numeric CSV is untouched', async () => {
  // No separators anywhere: there is nothing to decide, and the file must
  // behave exactly as it did before any of this existed.
  const path = await csv('plain.csv', 'a,b\n1,2\n3,4000\n');
  const { file, rows } = await readAll(path);
  try {
    assert.equal(Number(rows[1][1]), 4000);
    assert.equal(file.numberLocale?.locale, null);
    assert.equal(file.openWarnings.length, 0);
  } finally {
    file.dispose();
  }
});

test('the CSV on disk is never modified', async () => {
  // The viewer only views. Opening, sniffing and reading must leave the bytes
  // exactly as they were.
  const body = 'Tarih;Deger\n2024-01-31;1.794.446,52\n';
  const path = await csv('untouched.csv', body);
  const { readFile } = await import('node:fs/promises');
  const before = await readFile(path);
  const { file } = await readAll(path);
  file.dispose();
  const after = await readFile(path);
  assert.deepEqual(after, before);
});
