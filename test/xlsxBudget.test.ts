import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { preflightWorkbook } from '../src/xlsxBudget';

test('workbook preflight rejects unsafe paths, entities and actual inflation without extracting files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dfv-zip-budget-'));
  const path = join(root, 'synthetic.xlsx');
  const write = async (parts: Record<string, Uint8Array>) => writeFile(path, zipSync(parts));
  try {
    await write({ 'xl/workbook.xml': strToU8('<workbook/>') });
    await preflightWorkbook(path);
    for (const name of ['../outside.xml', '/absolute.xml', 'C:\\outside.xml', 'xl/../../outside.xml']) {
      await write({ [name]: strToU8('<x/>') });
      await assert.rejects(preflightWorkbook(path), /unsafe/);
    }
    for (const xml of ['<!DOCTYPE x SYSTEM "file:///synthetic"><x/>', '<!ENTITY x "synthetic">']) {
      await write({ 'xl/workbook.xml': strToU8(xml) });
      await assert.rejects(preflightWorkbook(path), /entity declarations/);
    }
    await write({ 'xl/workbook.xml': Buffer.from('\ufeff<!DOCTYPE x SYSTEM "file:///synthetic"><x/>', 'utf16le') });
    await assert.rejects(preflightWorkbook(path), /entity declarations/);
    await write({ 'xl/a.xml': strToU8('x'.repeat(8192)), 'xl/b.xml': strToU8('y'.repeat(8192)) });
    await assert.rejects(preflightWorkbook(path, { inflatedBytes: 12000 }), /decompression/);
    await assert.rejects(preflightWorkbook(path, { partBytes: 4000 }), /part-size|decompression/);
    await assert.rejects(preflightWorkbook(path, { entries: 1 }), /archive-entry/);
    await assert.rejects(preflightWorkbook(path, { compressedBytes: 1 }), /compressed-size/);
    await assert.rejects(preflightWorkbook(path, { entries: 10001 }), /Invalid/);
    await preflightWorkbook(path);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('workbook preflight fast path: lying sizes, normalised duplicates and header mismatches', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dfv-zip-budget2-'));
  const path = join(root, 'synthetic.xlsx');
  try {
    // A central directory that under-declares a member's size: only counting stops it.
    const bomb = Buffer.from(zipSync({ 'xl/a.xml': strToU8('<a>' + ' '.repeat(64 * 1024) + '</a>') }, { level: 9 }));
    const central = bomb.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    bomb.writeUInt32LE(10, central + 24);
    const local = bomb.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    bomb.writeUInt32LE(10, local + 22);
    await writeFile(path, bomb);
    await assert.rejects(preflightWorkbook(path, { partBytes: 16 * 1024 }), /decompression/);
    // `a\b` and `a/b` are the same path once normalised.
    await writeFile(path, zipSync({ 'xl\\a.xml': strToU8('<a/>'), 'xl/a.xml': strToU8('<b/>') }));
    await assert.rejects(preflightWorkbook(path), /unsafe or duplicate/);
    // Local header naming a different path than the central record: the fast
    // path declines, and the original streaming path judges the local name.
    const mismatch = Buffer.from(zipSync({ 'xl/ok.xml': strToU8('<x/>') }));
    const at = mismatch.indexOf(Buffer.from('xl/ok.xml'));
    mismatch.write('../o.xml!', at, 'latin1');
    await writeFile(path, mismatch);
    await assert.rejects(preflightWorkbook(path), /unsafe/);
    // And a clean archive returns the SHA-256 of exactly its bytes.
    const clean = Buffer.from(zipSync({ 'xl/workbook.xml': strToU8('<workbook/>') }));
    await writeFile(path, clean);
    const { createHash } = await import('node:crypto');
    assert.equal(await preflightWorkbook(path), createHash('sha256').update(clean).digest('hex'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('preflight cannot bypass inflation limits by disagreeing about the compression method', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dfv-method-review-'));
  try {
    const bytes = Buffer.from(zipSync({ 'xl/a.xml': strToU8('<a>' + 'x'.repeat(65536) + '</a>') }));
    const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    bytes.writeUInt16LE(0, central + 10); // central says stored; local header still says deflate
    bytes.writeUInt32LE(10, central + 24);
    const file = join(root, 'method.xlsx');
    await writeFile(file, bytes);
    await assert.rejects(preflightWorkbook(file, { inflatedBytes: 1024 }), /decompression|archive|header/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('preflight does not skip local members omitted from the central directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dfv-hidden-review-'));
  try {
    const bytes = Buffer.from(zipSync({ 'xl/hidden.xml': strToU8('<!DOCTYPE x><x/>'), 'xl/visible.xml': strToU8('<x/>') }));
    const first = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    const length = 46 + bytes.readUInt16LE(first + 28) + bytes.readUInt16LE(first + 30) + bytes.readUInt16LE(first + 32);
    const altered = Buffer.concat([bytes.subarray(0, first), bytes.subarray(first + length)]);
    const end = altered.length - 22;
    altered.writeUInt16LE(1, end + 8); altered.writeUInt16LE(1, end + 10);
    altered.writeUInt32LE(altered.readUInt32LE(end + 12) - length, end + 12);
    const file = join(root, 'hidden.xlsx');
    await writeFile(file, altered);
    await assert.rejects(preflightWorkbook(file), /entity|archive|header/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
