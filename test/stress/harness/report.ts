import { writeFile } from 'node:fs/promises';
import { SEVERITY_ORDER, type Severity } from '../expect';
import { ensureWorkDir, reportPath } from '../paths';
import type { Outcome } from './runner';

/**
 * _work/report.md, ranked by how QUIETLY a thing went wrong.
 *
 * etl_stress ranks findings by silence because a crash announces itself and a
 * wrong number does not. The viewer's version of that ordering:
 *
 *   1 silent-corruption  a save changed bytes it had no business touching
 *   2 silent-misread     the grid drew, the values are wrong, nothing was said
 *   3 lost-edit          save reported success; the value is gone on reopen
 *   4 crash
 *   5 bad-message        refused, but for a reason that does not help anyone
 *
 * A crash sits fourth deliberately. It is the outcome a user can see, report,
 * and work around; the three above it are the ones that end with somebody
 * trusting a number that is not there.
 */

const SEVERITY_LABEL: Record<Severity, string> = {
  'silent-corruption': 'Silent corruption',
  'silent-misread': 'Silent misread',
  'lost-edit': 'Lost edit',
  crash: 'Crash',
  'bad-message': 'Unhelpful refusal',
};

export interface Summary {
  passed: number;
  failed: number;
  skipped: number;
  xfailed: number;
  xpassed: number;
  total: number;
}

export function summarize(outcomes: Outcome[]): Summary {
  const count = (s: Outcome['status']) => outcomes.filter((o) => o.status === s).length;
  return {
    passed: count('pass'),
    failed: count('fail'),
    skipped: count('skip'),
    xfailed: count('xfail'),
    xpassed: count('xpass'),
    total: outcomes.length,
  };
}

function worstSeverity(outcome: Outcome): number {
  let worst = SEVERITY_ORDER.length;
  for (const f of outcome.findings) {
    worst = Math.min(worst, SEVERITY_ORDER.indexOf(f.severity));
  }
  return worst;
}

export async function writeReport(outcomes: Outcome[], elapsedMs: number): Promise<string> {
  await ensureWorkDir();
  const s = summarize(outcomes);
  const lines: string[] = [];

  lines.push('# viewer stress report');
  lines.push('');
  lines.push(`${new Date().toISOString()} — ${(elapsedMs / 1000).toFixed(1)}s`);
  lines.push('');
  lines.push(
    `**${s.passed} passed · ${s.failed} failed · ${s.skipped} skipped · ` +
      `${s.xfailed} known · ${s.xpassed} newly fixed** (${s.total} cases)`
  );
  lines.push('');

  const failures = outcomes.filter((o) => o.status === 'fail').sort((a, b) => worstSeverity(a) - worstSeverity(b));

  if (failures.length) {
    lines.push('## Findings');
    lines.push('');
    lines.push('Ranked by how quietly the failure happened, worst first.');
    lines.push('');
    for (const outcome of failures) {
      const worst = SEVERITY_ORDER[worstSeverity(outcome)];
      lines.push(`### ${outcome.name} — ${SEVERITY_LABEL[worst]}`);
      lines.push('');
      lines.push(`*${outcome.family}* — ${outcome.note}`);
      lines.push('');
      for (const f of outcome.findings) {
        lines.push(`- **${SEVERITY_LABEL[f.severity]}**: ${f.message}`);
      }
      lines.push('');
    }
  } else {
    lines.push('No findings.');
    lines.push('');
  }

  const xpassed = outcomes.filter((o) => o.status === 'xpass');
  if (xpassed.length) {
    lines.push('## Newly fixed');
    lines.push('');
    lines.push('These were pinned as known defects and now pass. Remove the `knownBug` pin.');
    lines.push('');
    for (const o of xpassed) lines.push(`- **${o.name}** — was: ${o.knownBug}`);
    lines.push('');
  }

  const xfailed = outcomes.filter((o) => o.status === 'xfail');
  if (xfailed.length) {
    lines.push('## Known defects');
    lines.push('');
    lines.push('Pinned, so they do not count as regressions. Each is a real bug.');
    lines.push('');
    for (const o of xfailed) {
      lines.push(`- **${o.name}** — ${o.knownBug}`);
      for (const f of o.findings) lines.push(`  - ${f.message}`);
    }
    lines.push('');
  }

  const skipped = outcomes.filter((o) => o.status === 'skip');
  if (skipped.length) {
    lines.push('## Skipped');
    lines.push('');
    for (const o of skipped) lines.push(`- **${o.name}** — ${o.skipReason}`);
    lines.push('');
  }

  lines.push('## Every case');
  lines.push('');
  lines.push('| case | family | status | ms |');
  lines.push('|---|---|---|---|');
  for (const o of [...outcomes].sort((a, b) => a.family.localeCompare(b.family) || a.name.localeCompare(b.name))) {
    lines.push(`| ${o.name} | ${o.family} | ${o.status} | ${o.ms} |`);
  }
  lines.push('');

  await writeFile(reportPath, lines.join('\n'), 'utf8');
  return reportPath;
}

/** One line per case for the terminal, in the style of the sibling suites. */
export function progressLine(outcome: Outcome): string {
  const mark =
    outcome.status === 'pass'
      ? 'ok  '
      : outcome.status === 'fail'
        ? 'FAIL'
        : outcome.status === 'skip'
          ? 'skip'
          : outcome.status === 'xfail'
            ? 'known'
            : 'XPASS';
  const detail =
    outcome.status === 'fail'
      ? ` — ${outcome.findings[0]?.message ?? ''}`
      : outcome.status === 'skip'
        ? ` — ${outcome.skipReason}`
        : '';
  return `${mark.padEnd(5)} ${outcome.name.padEnd(44)} ${String(outcome.ms).padStart(5)}ms${detail}`;
}
