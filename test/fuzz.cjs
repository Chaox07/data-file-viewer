// Bounded, reproducible fuzz campaign: npm run test:fuzz -- --seed 12345 [--runs 20000]
// The default suite runs the same tests with a fixed seed and fewer runs.
const { spawnSync } = require('node:child_process');
const arg = name => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const seed = arg('seed') ?? String(Date.now() % 2147483647);
const runs = arg('runs') ?? '20000';
console.log(`fuzz campaign: seed ${seed}, runs ${runs}`);
const result = spawnSync(process.execPath, ['--test', 'out-test/test/queryBoundary.test.js', 'out-test/test/scannerDifferential.test.js'], {
  stdio: 'inherit', env: { ...process.env, DFV_FUZZ_SEED: seed, DFV_FUZZ_RUNS: runs },
});
process.exit(result.status ?? 1);
