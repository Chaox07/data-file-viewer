import './stress/stubs/vscode';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as vscode from 'vscode';
import { DuckDBInstance } from '@duckdb/node-api';
import { DuckDbFile } from '../src/duckdbConnection';
import { DuckDBDocument } from '../src/duckdbEditorProvider';
import { xlsxFile } from './stress/generators/_write';

test('catalog keeps same-named relations in different schemas distinct and IDs document-bound', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dfv-catalog-'));
  const files: DuckDbFile[] = [];
  try {
    const path = join(dir, 'data.duckdb');
    const instance = await DuckDBInstance.create(path); const c = await instance.connect();
    await c.run('create schema other; create table main.data(i integer); create table other.data("Date" date)');
    c.closeSync(); instance.closeSync();
    files.push(await DuckDbFile.open(path, undefined, { forceReadOnly: true }), await DuckDbFile.open(path, undefined, { forceReadOnly: true }));
    const docs = files.map(file => new DuckDBDocument(vscode.Uri.file(path), file));
    const page = await docs[0].queryCatalogPage();
    assert.equal(page.targets.length, 2);
    assert.notEqual(page.targets[0].sqlName, page.targets[1].sqlName);
    const [first, second] = page.targets;
    assert.deepEqual(await files[0].getQueryColumns(first.catalog, first.schema, first.name), [{ name: 'i', type: 'INTEGER' }]);
    assert.deepEqual(await files[0].getQueryColumns(second.catalog, second.schema, second.name), [{ name: 'Date', type: 'DATE' }]);
    await docs[1].queryCatalogPage();
    assert.throws(() => docs[1].queryTarget(first.id, first.generation));
    docs[0].invalidateTablesCache();
    assert.throws(() => docs[0].queryTarget(first.id, first.generation));
  } finally { files.forEach(file => file.dispose()); await rm(dir, { recursive: true, force: true }); }
});

test('a raw worksheet\'s bounds are its used range, from the first used cell, not from A1', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dfv-catalog-used-'));
  let file: DuckDbFile | undefined;
  try {
    // Data at B2:C4 with a note at E7: row 1 and column A are empty, as on YieldCurve_Data's Raw_Data.
    const rows = [[], [null, 'Date', 'value'], [null, '1990-01-01', 1], [null, '1990-01-02', 2], [], [], [null, null, null, null, 'note']];
    const path = await xlsxFile(join(dir, 'data.xlsx'), [{ name: 'S', rows }]);
    file = await DuckDbFile.open(path, undefined, { restrictedReads: true });
    const sheet = (await file.getQueryCatalog()).find(target => target.name === 'S')!;
    assert.equal(sheet.bounds, undefined);
    await file.getQueryColumns(sheet.catalog, sheet.schema, sheet.name);
    const prepared = (await file.getQueryCatalog()).find(target => target.name === 'S')!;
    assert.deepEqual(prepared.bounds, { top: 1, bottom: 7, left: 1, right: 5 }, 'B2:E7');
  } finally { file?.dispose(); await rm(dir, { recursive: true, force: true }); }
});

test('catalog discovers only selected worksheet and reports actual typed columns', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dfv-catalog-sheet-'));
  let file: DuckDbFile | undefined;
  try {
    const path = await xlsxFile(join(dir, 'data.xlsx'), ['Selected', 'Unused'].map(name => ({ name, rows: [['Date', 'value'], ['1990-01-01', 1], ['1990-01-02', 2]] })));
    file = await DuckDbFile.open(path, undefined, { restrictedReads: true });
    const initial = await file.getQueryCatalog();
    assert.equal(initial.length, 2);
    assert.ok(initial.every(target => target.rawWorksheet && !target.prepared));
    const selected = initial.find(target => target.name === 'Selected')!;
    await file.getQueryColumns(selected.catalog, selected.schema, selected.name);
    const table = (await file.getQueryCatalog()).find(target => target.worksheet === 'Selected' && !target.rawWorksheet)!;
    assert.equal(table.range, 'A1:B3');
    assert.deepEqual(table.bounds, { top: 0, bottom: 3, left: 0, right: 2 });
    const prepared = await file.getQueryCatalog();
    assert.deepEqual(prepared.find(target => target.name === 'Selected')!.bounds, { top: 0, bottom: 3, left: 0, right: 2 });
    assert.equal(prepared.find(target => target.name === 'Unused')!.bounds, undefined, 'an unprepared sheet has no used range yet');
    assert.deepEqual(await file.getQueryColumns(table.catalog, table.schema, table.name), [{ name: 'Date', type: 'VARCHAR' }, { name: 'value', type: 'DOUBLE' }]);
    assert.equal(file.getDetectedSheetTables('Unused').length, 0);
  } finally { file?.dispose(); await rm(dir, { recursive: true, force: true }); }
});
