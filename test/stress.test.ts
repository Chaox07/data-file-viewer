import assert from 'node:assert/strict';
import test from 'node:test';
import './stress/generators/index';
import { allCases } from './stress/expect';
import { runCase } from './stress/harness/runner';

/**
 * The stress corpus, as ordinary tests.
 *
 * `npm run stress` writes the ranked report and is what you read when something
 * breaks; this file is what makes the same cases run in CI, in `npm test`,
 * beside everything else. One `test()` per case rather than one for the whole
 * suite, so a failure names itself in the runner's output instead of arriving
 * as "the stress suite failed".
 *
 * A case pinned with `knownBug` is expected to fail and does not fail the
 * build. A pinned case that starts PASSING does fail it, deliberately: a stale
 * pin silently disables a regression test for a bug that was fixed once.
 *
 * A known failure is marked `todo`, not returned from silently. It used to
 * return, which put it in the runner's `pass` tally: `npm test` reported
 * "pass 563, fail 0" while four reproduced defects sat in the code, and a
 * fifth appearing would not have moved either number. `npm run stress` had
 * always counted them separately; this makes the two runners agree. node's
 * `todo` is its own line in the summary, so the count is visible without
 * reading the report.
 */
for (const c of allCases()) {
  test(`stress: ${c.name}`, async (t) => {
    const outcome = await runCase(c);

    if (outcome.status === 'skip') {
      t.skip(outcome.skipReason);
      return;
    }

    if (outcome.status === 'xpass') {
      assert.fail(
        `pinned as a known bug ("${c.expect.knownBug}") but it now passes — remove the knownBug pin`
      );
    }

    if (outcome.status === 'xfail') {
      t.todo(`known bug: ${c.expect.knownBug}`);
      return; // reported in full by run_stress
    }

    assert.deepEqual(
      outcome.findings.map((f) => `[${f.severity}] ${f.message}`),
      [],
      `${c.expect.note}\n`
    );
  });
}
