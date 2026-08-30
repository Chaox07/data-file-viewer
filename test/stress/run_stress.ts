import './generators/index';
import { allCases, families } from './expect';
import { progressLine, summarize, writeReport } from './harness/report';
import { runCases } from './harness/runner';
import { reportPath } from './paths';

/**
 * The suite's own CLI, in the shape of etl_stress/run_stress.py and
 * macro_stress/run_stress.py:
 *
 *   npm run stress                     everything, then write _work/report.md
 *   npm run stress -- --list           what cases exist
 *   npm run stress -- --family shapes  one family
 *   npm run stress -- --case bigint    regex on the case name
 *
 * Exits non-zero on a real failure. A `knownBug` case that fails does NOT fail
 * the run -- that is the whole point of pinning it -- but one that starts
 * passing is reported loudly, because a stale pin hides a fixed bug's
 * regression just as well as it hid the bug.
 */

function arg(name: string): string | undefined {
  const flag = `--${name}`;
  const i = process.argv.indexOf(flag);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  const inline = process.argv.find((a) => a.startsWith(`${flag}=`));
  return inline?.slice(flag.length + 1);
}

async function main(): Promise<void> {
  const cases = allCases({ family: arg('family'), pattern: arg('case') });

  if (process.argv.includes('--list')) {
    console.log(`${cases.length} case(s) across families: ${families().join(', ')}\n`);
    for (const c of cases) {
      console.log(`${c.family.padEnd(12)} ${c.name.padEnd(44)} ${c.expect.note}`);
    }
    return;
  }

  if (cases.length === 0) {
    console.error('no cases matched');
    process.exitCode = 1;
    return;
  }

  const started = Date.now();
  const outcomes = await runCases(cases, (o) => console.log(progressLine(o)));
  const elapsed = Date.now() - started;
  const s = summarize(outcomes);

  console.log('');
  console.log(
    `${s.passed} passed · ${s.failed} failed · ${s.skipped} skipped · ` +
      `${s.xfailed} known · ${s.xpassed} newly fixed  (${(elapsed / 1000).toFixed(1)}s)`
  );
  console.log(`report: ${await writeReport(outcomes, elapsed)}`);
  void reportPath;

  if (s.xpassed > 0) {
    console.log('');
    console.log('Cases pinned as known bugs are now passing. Remove their knownBug pin:');
    for (const o of outcomes.filter((x) => x.status === 'xpass')) console.log(`  ${o.name}`);
  }

  process.exitCode = s.failed > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
