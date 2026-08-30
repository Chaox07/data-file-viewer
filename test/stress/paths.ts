import { mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/**
 * Every path the suite uses, derived from this file's own location.
 *
 * Mirrors etl_stress/paths.py for the same reason it exists there: the suite
 * has to run identically from any working directory, on macOS and on CI, and
 * from `node --test` as well as from run_stress. Nothing here reads cwd.
 *
 * Note this resolves against the COMPILED location (out-test/test/stress/), so
 * `repoRoot` climbs out of out-test too. Keeping the corpus under the repo
 * rather than the system temp dir is deliberate: a failed run leaves its files
 * where they can be opened in the very extension that mishandled them.
 */
const compiledDir = __dirname;

/** out-test/test/stress -> the repo root. */
export const repoRoot = resolve(compiledDir, '..', '..', '..');

/** Scratch space for everything generated. Gitignored; safe to delete. */
export const workDir = join(repoRoot, 'test', 'stress', '_work');

/** Generated inputs, one directory per case. */
export const corpusDir = join(workDir, 'corpus');

/** Tier B files, written by foreign/build_corpus.py. Absent on a CI machine. */
export const foreignDir = join(workDir, 'foreign');

/** Committed fixtures that cannot be regenerated in Node — see damage.ts. */
export const fixturesDir = join(repoRoot, 'test', 'stress', 'fixtures');

export const reportPath = join(workDir, 'report.md');

/** A per-case directory, emptied first so a rerun never sees stale files. */
export async function caseDir(name: string): Promise<string> {
  // Case names reach the filesystem, and several of them are deliberately
  // hostile (quotes, slashes, newlines). Only [a-z0-9_-] survives.
  const safe = name.replace(/[^a-zA-Z0-9_-]/g, '_');
  const dir = join(corpusDir, safe);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function ensureWorkDir(): Promise<void> {
  await mkdir(workDir, { recursive: true });
}
