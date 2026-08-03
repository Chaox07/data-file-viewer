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

async function main() {
  if (watch) {
    const [extCtx, webCtx] = await Promise.all([
      esbuild.context(extensionConfig),
      esbuild.context(webviewConfig),
    ]);
    await Promise.all([extCtx.watch(), webCtx.watch()]);
    console.log('watching for changes...');
  } else {
    await Promise.all([esbuild.build(extensionConfig), esbuild.build(webviewConfig)]);
    console.log('build complete');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
