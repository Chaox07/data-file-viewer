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
    files.push(await DuckDbFile.open(path), await DuckDbFile.open(path));
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
    assert.deepEqual(await file.getQueryColumns(table.catalog, table.schema, table.name), [{ name: 'Date', type: 'VARCHAR' }, { name: 'value', type: 'DOUBLE' }]);
    assert.equal(file.getDetectedSheetTables('Unused').length, 0);
  } finally { file?.dispose(); await rm(dir, { recursive: true, force: true }); }
});
