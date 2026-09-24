// PKG-01–04: inspect a built VSIX against allow/deny rules. Usage:
//   npm run test:package                  (newest data-file-viewer-*.vsix here)
//   node test/package.cjs path/to/file.vsix
// Reads the archive; installs nothing and publishes nothing.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { unzipSync, strFromU8 } = require('fflate');

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const vsix = process.argv[2] ?? fs.readdirSync(root)
  .filter(name => /^data-file-viewer-.*\.vsix$/.test(name))
  .map(name => path.join(root, name))
  .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
assert.ok(vsix, 'no VSIX found; run `npx vsce package --allow-missing-repository` first');

const bytes = fs.readFileSync(vsix);
const entries = unzipSync(bytes);
const names = Object.keys(entries);
const own = names.filter(n => n.startsWith('extension/') && !n.startsWith('extension/node_modules/'));
const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); };

// PKG-02/03: the tested code ships, with its native binding and worker.
for (const required of ['extension/package.json', 'extension/dist/extension.js', 'extension/dist/queryWorkerEntry.js',
  'extension/dist/webview.js', 'extension/dist/chartView.js', 'extension/media/main.css']) {
  check(names.includes(required), `missing ${required}`);
}
check(names.some(n => /^extension\/node_modules\/@duckdb\/node-bindings-[^/]+\/duckdb\.node$/.test(n)), 'missing the native DuckDB binding');
const shipped = JSON.parse(strFromU8(entries['extension/package.json']));
check(shipped.version === pkg.version, `packaged version ${shipped.version} != package.json ${pkg.version}`);
check(names.length > 800 && names.length < 4000, `unexpected file count ${names.length} (a good package is ~1500; 9 means the empty-package trap)`);

// PKG-03: no tests, fixtures, docs, backups, drafts or source maps of our own.
for (const name of own) {
  check(!/^extension\/(test|out-test|docs|\.tmp|src|\.github)\//.test(name), `development file shipped: ${name}`);
  check(!/\.(ts|map|vsix|duckdb|sqlite|db|xlsx|csv|parquet|arrows?|feather|dta|wal|bak|orig)$/i.test(name) || name.endsWith('.d.ts'), `data or build artifact shipped: ${name}`);
}
// Synthetic sentinels used by the security suites must never reach an artifact.
for (const name of own) {
  if (!/\.(js|json|css|html|md|txt)$/i.test(name)) continue;
  const text = strFromU8(entries[name]);
  check(!/SYNTHETIC_(SECRET|OUTSIDE|TOKEN|PASSWORD|REMOTE)/.test(text), `test sentinel inside ${name}`);
}
// PKG-01: dependencies resolve from the lockfile, not a developer's temp directory.
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
check(lock.version === pkg.version && lock.packages[''].version === pkg.version, 'package-lock.json version fields do not match package.json');
for (const [key, meta] of Object.entries(lock.packages)) {
  if (!key || meta.dev) continue;
  check(!meta.link && !(meta.resolved ?? '').startsWith('file:'), `production dependency resolved locally: ${key}`);
}

const size = bytes.length;
console.log(JSON.stringify({ vsix: path.basename(vsix), files: names.length, ownFiles: own.length, bytes: size, version: shipped.version }));
if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
console.log('PKG checks passed');
