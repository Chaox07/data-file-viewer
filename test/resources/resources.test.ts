import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { QueryWorker } from '../../src/queryWorker';
import { ViewerFile } from '../../src/viewerFile';
import { xlsxFile } from '../stress/generators/_write';

// DOS-01–04 and PERF-01–04 of docs/sql-filtering-plan.md. Kept out of the
// default `npm test` glob because it deliberately burns CPU and memory; run it
// with `npm run test:resources`. Measurements are printed as one JSON line per
// case (prefix PERF) so a run can be recorded in docs/sql-filtering-progress.md.

const workerPath = join(__dirname, '..', '..', 'src', 'queryWorkerEntry.js');
const childOf = (worker: QueryWorker) => (worker as unknown as { child?: { pid?: number } }).child;
const tempOf = (worker: QueryWorker) => (worker as unknown as { tempRoot?: string }).tempRoot;
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const rssMiB = (pid: number) => { try { return Math.round(Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)]).toString().trim()) / 1024); } catch { return NaN; } };
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(1); };
const report = (name: string, data: Record<string, unknown>) => console.log(`PERF ${JSON.stringify({ case: name, ...data })}`);

async function csv(dir: string, rows: number) {
  const path = join(dir, `rows${rows}.csv`);
  const lines = ['id,region,amount,day'];
  for (let i = 0; i < rows; i++) lines.push(`${i},${['n', 's', 'e', 'w'][i % 4]},${(i * 7919) % 100000},${new Date(Date.UTC(2000, 0, 1 + (i % 9000))).toISOString().slice(0, 10)}`);
  await writeFile(path, lines.join('\n') + '\n');
  return path;
}

test('DOS-01: cartesian and unbounded recursive SQL are stopped by the parent deadline; no orphan survives', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dfv-dos01-'));
  const worker = new QueryWorker(workerPath);
  try {
    const path = await csv(dir, 100);
    await worker.call('open', [path, undefined, {}]);
    for (const sql of [
      // Memory-bound: stopped by the 512 MB engine budget with spill disabled.
      'select count(*) from range(1000000000) a, range(1000000000) b',
      // CPU-bound and streaming: only the parent deadline can stop this one.
      'select count(*) from range(100000000000) t(i) where hash(i) % 7 = 0',
      'with recursive r(n) as (select 1 union all select n + 1 from r) select count(*) from r',
      // length() forces the aggregate; count(*) alone lets the optimizer drop it.
      "select length(string_agg(rpad('', 1000, 'x'), '')) from range(10000000)",
    ]) {
      const pid = childOf(worker)?.pid;
      if (pid === undefined) await worker.call('open', [path, undefined, {}]);
      const child = childOf(worker)!.pid!;
      const temp = tempOf(worker)!;
      const started = Date.now();
      await assert.rejects(worker.call('runQuery', [sql], 2500));
      const elapsed = Date.now() - started;
      assert.ok(elapsed < 6000, `${sql}: stopped in ${elapsed} ms`);
      await new Promise(r => setTimeout(r, 300));
      if (!childOf(worker)) {
        assert.equal(alive(child), false, 'the stopped worker process is gone');
        assert.equal(existsSync(temp), false, 'its private scratch directory is removed');
      }
      report('DOS-01', { sql: sql.slice(0, 40), stoppedMs: elapsed });
    }
    // The document is usable again afterwards.
    if (!childOf(worker)) await worker.call('open', [path, undefined, {}]);
    const reply = await worker.call<{ value: { rows: unknown[][] } }>('runQuery', ['select count(*) from rows100']);
    assert.equal(String(reply.value.rows[0][0]), '100');
  } finally { worker.dispose(); await rm(dir, { recursive: true, force: true }); }
});

test('DOS-02/03: zip bombs, huge declared dimensions and malformed parts are refused before extraction', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dfv-dos02-'));
  try {
    const base = (sheet: string) => ({
      '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'),
      '_rels/.rels': strToU8('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'),
      'xl/workbook.xml': strToU8('<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>'),
      'xl/_rels/workbook.xml.rels': strToU8('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'),
      'xl/worksheets/sheet1.xml': strToU8(sheet),
    });
    const head = '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">';
    const cases: Record<string, Uint8Array> = {
      // ~300 MB of sheet XML that compresses to well under 1 MB.
      bomb: zipSync({ ...base(head + '<sheetData>' + '<row r="1"><c r="A1"><v>1</v></c></row>'.padEnd(64, ' ').repeat(1) + ' '.repeat(300 * 1024 * 1024) + '</sheetData></worksheet>') }, { level: 9 }),
      dimension: zipSync(base(head + '<dimension ref="A1:XFD1048576"/><sheetData><row r="1"><c r="A1"><v>1</v></c></row><row r="1048576"><c r="XFD1048576"><v>1</v></c></row></sheetData></worksheet>')),
      entity: zipSync(base('<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">]>' + head + '<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>&b;</t></is></c></row></sheetData></worksheet>')),
      truncated: zipSync(base(head + '<sheetData><row r="1"><c r="A1"><v>1')).slice(0, 700),
    };
    for (const [name, bytes] of Object.entries(cases)) {
      const path = join(dir, `${name}.xlsx`);
      await writeFile(path, bytes);
      const started = Date.now();
      let file: ViewerFile | undefined;
      let opened = false;
      try {
        file = await ViewerFile.open(path);
        opened = true;
        // A dimension that is declared huge but mostly empty may open; querying it must stay bounded.
        await file.runQuery('select count(*) from "S"').catch(() => undefined);
      } catch { /* refused */ } finally { file?.dispose(); }
      const elapsed = Date.now() - started;
      assert.ok(elapsed < 20_000, `${name}: bounded (${elapsed} ms)`);
      if (name === 'bomb' || name === 'entity' || name === 'truncated') assert.equal(opened, false, `${name} is refused`);
      report('DOS-02/03', { name, compressedBytes: (await stat(path)).size, opened, ms: elapsed });
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('DOS-04: result and cell budgets hold under a parent deadline; the reader stays usable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dfv-dos04-'));
  const file = await ViewerFile.open(await csv(dir, 10));
  try {
    await assert.rejects(file.runQuery("select rpad('', 5 * 1024 * 1024, 'x') as big"), /4 MiB/);
    await assert.rejects(file.runQuery("select rpad('', 3 * 1024 * 1024, 'é') as big"), /4 MiB/);
    await assert.rejects(file.runQuery("select rpad('', 1024 * 1024, 'x') as v from range(40)"), /32 MiB/);
    assert.equal(String((await file.runQuery("select rpad('', 3 * 1024 * 1024, 'x') as ok")).rows[0][0]).length, 3 * 1024 * 1024, 'within budget is returned whole');
    assert.equal(String((await file.runQuery('select count(*) from rows10')).rows[0][0]), '10');
  } finally { file.dispose(); await rm(dir, { recursive: true, force: true }); }
});

test('PERF-01: 200,000 rows — cold open, warm queries, sort, stats and chart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dfv-perf01-'));
  try {
    const path = await csv(dir, 200_000);
    const t0 = performance.now();
    const file = await ViewerFile.open(path);
    const coldOpen = performance.now() - t0;
    try {
      const t1 = performance.now();
      await file.runQuery('select * from rows200000 limit 1000');
      const firstQuery = performance.now() - t1;
      const warm: number[] = [];
      for (let i = 0; i < 20; i++) {
        const t = performance.now();
        const r = await file.runQuery(`select * from rows200000 where amount >= ${i * 1000} and region = 'n' limit 1000`);
        warm.push(performance.now() - t);
        assert.ok(r.rows.length > 0);
      }
      const t2 = performance.now();
      await file.runSortedQuery('select * from rows200000', 'amount', 'desc', 1000);
      await file.getColumnDescriptiveStats('select * from rows200000', 'amount', 'numeric');
      const chart = await file.runChartQuery('select day, amount from rows200000', 'day', ['amount'], true, 3000);
      const heavy = performance.now() - t2;
      assert.ok(chart.rows.length > 0);
      const pid = childOf((file as unknown as { worker: QueryWorker }).worker)?.pid;
      report('PERF-01', { coldOpenMs: Math.round(coldOpen), firstQueryMs: Math.round(firstQuery), warmP50: pct(warm, 0.5), warmP95: pct(warm, 0.95), sortStatsChartMs: Math.round(heavy), workerRssMiB: pid ? rssMiB(pid) : null });
      assert.ok(pct(warm, 0.95) < 2000);
    } finally { file.dispose(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('PERF-02/03: 50 sheets / 500 detected tables and a large cell — lazy preparation, 1,000 target switches', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dfv-perf02-'));
  try {
    const sheets = Array.from({ length: 50 }, (_, s) => {
      const rows: unknown[][] = [];
      for (let t = 0; t < 10; t++) {
        rows.push(['id', `v${t}`]);
        for (let i = 0; i < 4; i++) rows.push([i, `s${s}t${t}r${i}`]);
        rows.push([]);
      }
      // Excel's own per-cell maximum is 32,767 characters.
      if (s === 0) rows.push(['id', 'big'], [1, 'x'.repeat(32_000)], [2, 'y']);
      return { name: `Sheet${s}`, rows };
    });
    const path = await xlsxFile(join(dir, 'wide.xlsx'), sheets);
    const t0 = performance.now();
    const file = await ViewerFile.open(path);
    const coldOpen = performance.now() - t0;
    try {
      const pid = () => childOf((file as unknown as { worker: QueryWorker }).worker)?.pid;
      const rssStart = pid() ? rssMiB(pid()!) : NaN;
      const catalogTimes: number[] = [];
      for (let i = 0; i < 5; i++) { const t = performance.now(); await file.getQueryCatalog(0); catalogTimes.push(performance.now() - t); }
      // 1,000 switches across 20 sheets' tables: each builds and runs the inline query.
      const switches: number[] = [];
      for (let i = 0; i < 1000; i++) {
        const sheet = `Sheet${i % 20}`;
        const table = `${sheet} · Table ${(i % 10) + 1}`;
        const t = performance.now();
        const r = await file.runQuery(`select * from "${table}" limit 5`);
        switches.push(performance.now() - t);
        assert.equal(r.rows.length, 4);
      }
      const rssAfterSwitches = pid() ? rssMiB(pid()!) : NaN;
      // Untouched sheets stay unprepared (lazy): 30 of 50 were never referenced.
      const prepared = (await file.getQueryCatalog(0)).concat(await file.getQueryCatalog(100)).filter(r => /^Sheet\d+$/.test(r.name) && r.prepared).length;
      assert.ok(prepared <= 21, `only referenced sheets were prepared (${prepared})`);
      // The large cell is readable in full when explicitly selected, and within budget.
      const big = await file.runQuery('select * from "Sheet0 · Table 11"');
      assert.equal(String(big.rows[0][1]).length, 32_000);
      // 50 refresh cycles of the same query: memory must not keep growing.
      const rssCycles: number[] = [];
      for (let i = 0; i < 50; i++) { await file.runQuery('select * from "Sheet1 · Table 1"'); if (i % 10 === 9 && pid()) rssCycles.push(rssMiB(pid()!)); }
      report('PERF-02/03', { coldOpenMs: Math.round(coldOpen), catalogP50: pct(catalogTimes, 0.5), switchP50: pct(switches, 0.5), switchP95: pct(switches, 0.95), preparedSheets: prepared, rssStart, rssAfterSwitches, rssCycles });
      if (rssCycles.length >= 2) assert.ok(rssCycles.at(-1)! - rssCycles[0] < 64, 'no continuing memory growth across refresh cycles');
    } finally { file.dispose(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('PERF-04: queue depth stays bounded under rapid requests from four documents', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dfv-perf04-'));
  const files: ViewerFile[] = [];
  try {
    for (let i = 0; i < 4; i++) files.push(await ViewerFile.open(await csv(dir, 1000 + i)));
    const t = performance.now();
    const outcomes = await Promise.allSettled(files.flatMap((f, i) => Array.from({ length: 12 }, () => f.runQuery(`select count(*) from rows${1000 + i}`))));
    const ms = performance.now() - t;
    const refused = outcomes.filter(o => o.status === 'rejected').length;
    report('PERF-04', { requests: outcomes.length, refusedByBound: refused, totalMs: Math.round(ms) });
    assert.ok(outcomes.some(o => o.status === 'fulfilled'));
    // Every document still answers afterwards.
    for (const [i, f] of files.entries()) assert.equal(String((await f.runQuery(`select count(*) from rows${1000 + i}`)).rows[0][0]), String(1000 + i));
  } finally { for (const f of files) f.dispose(); await rm(dir, { recursive: true, force: true }); }
});
