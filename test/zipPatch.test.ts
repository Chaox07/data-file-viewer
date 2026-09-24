import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Zip, ZipDeflate, ZipPassThrough, unzipSync, zipSync, strToU8, strFromU8 } from 'fflate';
import { DuckDBInstance } from '@duckdb/node-api';
import { indexZip, readMember, rewriteZip } from '../src/zipPatch';
import { xlsxFile } from './stress/generators/_write';

const members = (bytes: Uint8Array) => unzipSync(bytes);

test('zipPatch: a rewrite with no replacement keeps every member, and a replacement changes only that member', () => {
  const original = Buffer.from(zipSync({
    'a.xml': strToU8('<a>' + 'x'.repeat(5000) + '</a>'),
    'dir/b.xml': strToU8('<b/>'),
    'stored.bin': [new Uint8Array([1, 2, 3, 4]), { level: 0 }],
    'ünïcode.xml': strToU8('<u>é</u>'),
  }, { level: 6 }));
  const index = indexZip(original);
  assert.ok(index);
  const same = rewriteZip(index, new Map());
  assert.deepEqual(members(same), members(original));
  const changed = rewriteZip(index, new Map([['dir/b.xml', strToU8('<b>new</b>')]]));
  const m = members(changed);
  assert.equal(strFromU8(m['dir/b.xml']), '<b>new</b>');
  for (const name of ['a.xml', 'stored.bin', 'ünïcode.xml']) assert.deepEqual(m[name], members(original)[name]);
  assert.deepEqual(Object.keys(m), Object.keys(members(original)), 'member order kept');
  assert.equal(strFromU8(readMember(indexZip(changed)!, 'dir/b.xml')!), '<b>new</b>');
});

test('zipPatch: an archive written with data descriptors is rewritten correctly', () => {
  const chunks: Uint8Array[] = [];
  const zip = new Zip((err, data) => { if (err) throw err; chunks.push(data); });
  const one = new ZipDeflate('one.xml', { level: 6 }); zip.add(one); one.push(strToU8('<one>1</one>'), true);
  const two = new ZipPassThrough('two.xml'); zip.add(two); two.push(strToU8('<two>2</two>'), true);
  zip.end();
  const original = Buffer.concat(chunks);
  const index = indexZip(original);
  assert.ok(index, 'streamed archive is in scope');
  const out = rewriteZip(index, new Map([['one.xml', strToU8('<one>changed</one>')]]));
  assert.equal(strFromU8(members(out)['one.xml']), '<one>changed</one>');
  assert.equal(strFromU8(members(out)['two.xml']), '<two>2</two>');
});

test('zipPatch: out-of-scope archives return undefined so the caller keeps the full path', () => {
  const ok = Buffer.from(zipSync({ 'a.txt': strToU8('a') }));
  const encrypted = Buffer.from(ok);
  const central = encrypted.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  encrypted.writeUInt16LE(encrypted.readUInt16LE(central + 8) | 1, central + 8);
  assert.equal(indexZip(encrypted), undefined);
  const multiDisk = Buffer.from(ok);
  multiDisk.writeUInt16LE(1, multiDisk.length - 22 + 4);
  assert.equal(indexZip(multiDisk), undefined);
  assert.equal(indexZip(Buffer.from('not a zip at all')), undefined);
  assert.equal(indexZip(ok.subarray(0, ok.length - 5)), undefined, 'truncated');
});

test('zipPatch declines local ZIP64 headers even when central sizes fit in 32 bits', () => {
  const ordinary = Buffer.from(zipSync({ 'sheet.xml': strToU8('<sheet/>') }));
  const central = ordinary.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  const dataOffset = 30 + ordinary.readUInt16LE(26);
  const extra = Buffer.alloc(20);
  extra.writeUInt16LE(1, 0); extra.writeUInt16LE(16, 2);
  extra.writeBigUInt64LE(BigInt(ordinary.readUInt32LE(22)), 4);
  extra.writeBigUInt64LE(BigInt(ordinary.readUInt32LE(18)), 12);
  const archive = Buffer.concat([ordinary.subarray(0, dataOffset), extra, ordinary.subarray(dataOffset)]);
  archive.writeUInt16LE(45, 4); archive.writeUInt16LE(20, 28);
  archive.writeUInt32LE(0xffffffff, 18); archive.writeUInt32LE(0xffffffff, 22);
  archive.writeUInt32LE(central + 20, archive.length - 6);
  assert.equal(indexZip(archive), undefined, 'rewriting must not retain stale ZIP64 local sizes');
});

test('zipPatch: a rewritten workbook still opens in DuckDB with the same values', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dfv-zippatch-'));
  try {
    const path = await xlsxFile(join(dir, 'book.xlsx'), [
      { name: 'A', rows: [['id', 'v'], [1, 'x'], [2, 'y']] }, { name: 'B', rows: [['k'], ['z']] },
    ]);
    const index = indexZip(await readFile(path))!;
    const sheet = index.entries.find(e => /sheet1\.xml$/.test(e.name))!.name;
    const xml = strFromU8(readMember(index, sheet)!).replace('>x<', '>w<');
    const rewritten = join(dir, 'out.xlsx');
    await writeFile(rewritten, rewriteZip(index, new Map([[sheet, strToU8(xml)]])));
    const instance = await DuckDBInstance.create(':memory:');
    const c = await instance.connect();
    try {
      await c.run('load excel');
      const read = async (p: string, s: string) => (await c.runAndReadAll(`select * from read_xlsx('${p}', sheet='${s}', all_varchar=true)`)).getRows();
      assert.deepEqual(await read(rewritten, 'B'), await read(path, 'B'));
      const a = await read(rewritten, 'A');
      assert.ok(JSON.stringify(a).includes('"w"') && !JSON.stringify(a).includes('"x"'), JSON.stringify(a));
    } finally { c.closeSync(); instance.closeSync(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
