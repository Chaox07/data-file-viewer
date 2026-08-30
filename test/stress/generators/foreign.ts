import { access } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { registerCase, type CanonicalTable } from '../expect';
import { readTable } from '../harness/inspect';
import { foreignDir, repoRoot } from '../paths';

/**
 * Tier B: files written by libraries this repo cannot run.
 *
 * Everything in `_write.ts` comes from DuckDB or apache-arrow, which is what
 * lets the corpus build in CI with no Python. It also means the corpus agrees
 * with the reader by construction, and that blind spot has already cost real
 * time: `malformedFiles.test.ts` passed for months while every polars-written
 * Feather file failed, because every Arrow fixture in it came from DuckDB.
 * DuckDB writes plain `Utf8`; polars writes `Utf8View`, which `read_arrow`
 * rejects outright. Nothing in the suite could produce the failing shape.
 *
 * `foreign/build_corpus.py` writes the same logical table through polars,
 * pyarrow, openpyxl, pandas and DuckDB's Python bindings, and records what it
 * produced in `foreign/manifest.json`. The manifest is committed; the files
 * are not.
 *
 * Absent files SKIP, they do not fail. That is the whole design: `npm test`
 * stays green on a machine with no Python and CI needs no Python step, while a
 * developer who runs the builder gets coverage over files nobody in this repo
 * could otherwise write. A skip names the command, so the reason is never a
 * mystery.
 */

interface ManifestEntry {
  file: string;
  writer: string;
  note: string;
  /** Null when the writer's own type choices legitimately differ; see below. */
  expected: CanonicalTable | null;
}

interface Manifest {
  generated?: string;
  command?: string;
  files: ManifestEntry[];
}

const BUILD_COMMAND = 'conda run -n myproject python test/stress/foreign/build_corpus.py';

// Read at module load, because cases have to be REGISTERED before the runner
// starts -- a case that appears only when its file exists would silently
// shrink the suite instead of reporting a skip.
//
// Read from the SOURCE tree by absolute path rather than `require`d: tsc does
// not copy .json into outDir for a `test/**/*.ts` include, so a require would
// resolve next to the compiled JS and find nothing -- which looks exactly like
// "no manifest committed" and disables the whole family in silence.
function loadManifest(): Manifest {
  try {
    const path = join(repoRoot, 'test', 'stress', 'foreign', 'manifest.json');
    return JSON.parse(readFileSync(path, 'utf8')) as Manifest;
  } catch {
    return { files: [] };
  }
}

const manifest = loadManifest();

async function missing(path: string): Promise<string | undefined> {
  try {
    await access(path);
    return undefined;
  } catch {
    return `Tier B corpus not built — run: ${BUILD_COMMAND}`;
  }
}

for (const entry of manifest.files) {
  const path = join(foreignDir, entry.file);

  registerCase({
    name: `foreign_${entry.file.replace(/[^a-zA-Z0-9]+/g, '_')}`,
    family: 'foreign',
    expect: {
      note: `${entry.writer}: ${entry.note}`,
      // A null `expected` in the manifest means the writer's own type choices
      // legitimately differ from the reference table -- openpyxl storing dates
      // as formatted serials, pandas spelling NA its own way -- so the case
      // asserts that the file OPENS and reads its rows, without claiming to
      // know what every value should look like. Asserting a shared table
      // across five writers would be asserting that they agree, which they do
      // not and need not.
      table: entry.expected ?? undefined,
      // Files with no expectation include the ones that must be REFUSED
      // (compressed Feather, which apache-arrow JS has no codecs for). Those
      // are checked below rather than declared, since the manifest cannot say
      // "refuse this" without duplicating the reason.
      mayRefuse: entry.expected === null,
    },
    skipIf: () => missing(path),
    build: async () => ({ path }),
    check: async (file, ctx) => {
      // For the no-expectation files: it opened, so it must at least read its
      // rows and report its columns. A file that opens and returns nothing is
      // the silent misread this suite exists for.
      if (entry.expected !== null) return;
      const table = await readTable(file);
      if (table.columns.length === 0) {
        ctx.fail('silent-misread', 'the file opened but reported no columns at all');
        return;
      }
      if (table.rows.length === 0) {
        ctx.fail(
          'silent-misread',
          `the file opened and returned zero rows over [${table.columns.join(', ')}] — ` +
            `the corpus writer put five rows in it`
        );
      }
    },
  });
}

/**
 * The compressed Feather files, checked for their MESSAGE rather than merely
 * for a refusal.
 *
 * apache-arrow JS ships no IPC codecs, so these cannot be converted at all.
 * "Refused" is not enough: the message has to name compression as the reason
 * and point at the way out, or it sends someone looking for a damaged file.
 */
for (const codec of ['lz4', 'zstd']) {
  const file = `polars-${codec}.feather`;
  const path = join(foreignDir, file);
  registerCase({
    name: `foreign_compressed_${codec}_is_refused_with_the_reason`,
    family: 'foreign',
    expect: {
      note: `${codec}-compressed Feather is refused, naming compression and the remedy`,
      refuses: /COMPRESSED Feather/i,
    },
    skipIf: () => missing(path),
    build: async () => ({ path }),
  });
}

/**
 * The manifest itself must describe a corpus that was actually built.
 *
 * A manifest listing files nobody generates is worse than no manifest: every
 * case skips, the suite stays green, and the coverage silently disappears.
 * This case fails only when the corpus IS built and disagrees with the
 * manifest -- so it is quiet on a machine without Python and loud on one where
 * the two have drifted apart.
 */
registerCase({
  name: 'foreign_manifest_matches_what_was_built',
  family: 'foreign',
  expect: { note: 'every file the manifest lists exists in the built corpus' },
  skipIf: async () => {
    if (manifest.files.length === 0) return 'no manifest committed';
    return missing(join(foreignDir, manifest.files[0].file));
  },
  build: async () => ({ path: join(foreignDir, manifest.files[0].file) }),
  check: async (_file, ctx) => {
    const absent: string[] = [];
    for (const entry of manifest.files) {
      if (await missing(join(foreignDir, entry.file))) absent.push(entry.file);
    }
    if (absent.length) {
      ctx.fail(
        'crash',
        `the manifest lists ${absent.length} file(s) the builder did not produce: ${absent.join(', ')}`
      );
    }
  },
});

/** How many Tier B cases are live, for the report's benefit. */
export const foreignCaseCount = manifest.files.length;

/** Kept for the runner's diagnostics; also proves the JSON parsed. */
export async function foreignManifestSummary(): Promise<string> {
  if (manifest.files.length === 0) return 'no Tier B manifest';
  const built = await Promise.all(
    manifest.files.map(async (e) => ((await missing(join(foreignDir, e.file))) ? 0 : 1))
  );
  const have = built.reduce((a: number, b: number) => a + b, 0);
  return `Tier B: ${have}/${manifest.files.length} files present`;
}
