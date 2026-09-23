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
    await write({ 'xl/a.xml': strToU8('x'.repeat(8192)), 'xl/b.xml': strToU8('y'.repeat(8192)) });
    await assert.rejects(preflightWorkbook(path, { inflatedBytes: 12000 }), /decompression/);
    await assert.rejects(preflightWorkbook(path, { partBytes: 4000 }), /part-size|decompression/);
    await assert.rejects(preflightWorkbook(path, { entries: 1 }), /archive-entry/);
    await assert.rejects(preflightWorkbook(path, { compressedBytes: 1 }), /compressed-size/);
    await assert.rejects(preflightWorkbook(path, { entries: 10001 }), /Invalid/);
    await preflightWorkbook(path);
  } finally { await rm(root, { recursive: true, force: true }); }
});
