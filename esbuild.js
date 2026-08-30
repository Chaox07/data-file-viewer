const esbuild = require('esbuild');

const watch = process.argv.includes('--watch');
const minify = !watch;

/** @type {import('esbuild').BuildOptions} */
const extensionConfig = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  outfile: 'dist/extension.js',
  external: ['vscode', '@duckdb/node-api'],
  minify,
  sourcemap: true,
};

/** @type {import('esbuild').BuildOptions} */
const webviewConfig = {
  entryPoints: ['src/webview.ts'],
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2020',
  outfile: 'dist/webview.js',
  minify,
  sourcemap: true,
};

// The chart's own webview, and its own bundle on purpose: ECharts is ~530 KB
// and only this entry point needs it, so keeping it out of webview.js means
// the grid does not pay for a library it never calls.
/** @type {import('esbuild').BuildOptions} */
const chartViewConfig = {
  entryPoints: ['src/chartView.ts'],
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2020',
  outfile: 'dist/chartView.js',
  minify,
  sourcemap: true,
};

async function main() {
  const configs = [extensionConfig, webviewConfig, chartViewConfig];
  if (watch) {
    const contexts = await Promise.all(configs.map((c) => esbuild.context(c)));
    await Promise.all(contexts.map((c) => c.watch()));
    console.log('watching for changes...');
  } else {
    await Promise.all(configs.map((c) => esbuild.build(c)));
    console.log('build complete');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
