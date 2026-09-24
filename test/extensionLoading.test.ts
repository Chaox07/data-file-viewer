import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DuckDBConnection } from '@duckdb/node-api';
import { DuckDbFile } from '../src/duckdbConnection';
import { xlsxFile } from './stress/generators/_write';

for (const lostInstallRace of [false, true]) {
  test(`extension loading tolerates a locked install directory, install race=${lostInstallRace}`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dfv-extension-load-'));
    const original = DuckDBConnection.prototype.run;
    let file: DuckDbFile | undefined;
    try {
      const path = await xlsxFile(join(dir, 'data.xlsx'), [{ name: 'data', rows: [['id'], [1]] }]);
      // The real extension is available; the mock models another process
      // finishing installation between our initial LOAD and INSTALL.
      const warm = await DuckDbFile.open(path);
      warm.dispose();
      let loads = 0, installs = 0;
      DuckDBConnection.prototype.run = function (sql, ...args) {
        if (sql === 'load excel') {
          loads++;
          if (lostInstallRace && loads === 1) return Promise.reject(new Error('not installed yet'));
        }
        if (sql === 'install excel') {
          installs++;
          return Promise.reject(new Error('Could not move file: Access is denied.'));
        }
        return original.call(this, sql, ...args);
      };
      file = await DuckDbFile.open(path);
      assert.equal((await file.runQuery('select * from data')).rows.length, 2);
      assert.equal(installs, lostInstallRace ? 1 : 0);
      assert.equal(loads, lostInstallRace ? 2 : 1);
    } finally {
      DuckDBConnection.prototype.run = original;
      file?.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });
}
