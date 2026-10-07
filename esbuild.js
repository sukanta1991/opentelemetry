// Build script for the extension bundles.
// - Bundles src/extension.ts -> dist/extension.js (CommonJS, `vscode` external)
// - Bundles each src/views/webview entry point -> dist/webview/*.js (IIFE, browser)
// - grpc-js / proto-loader are kept external so their runtime file loading works
// - Copies proto/ and webview assets into dist/ so they can be resolved at runtime
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

function copyDir(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

const copyAssetsPlugin = {
  name: 'copy-assets',
  setup(build) {
    build.onEnd(() => {
      copyDir(path.join(__dirname, 'proto'), path.join(__dirname, 'dist', 'proto'));
      console.log('[esbuild] assets copied');
    });
  },
};

// Prints the markers and "file:line:col: error: msg" lines the npm: watch task's problem matcher
// reads, so F5 knows when a build has finished. Shared by both contexts.
let pendingBuilds = 0;
const watchReporterPlugin = {
  name: 'watch-reporter',
  setup(build) {
    build.onStart(() => {
      if (pendingBuilds++ === 0) console.log('[watch] build started');
    });
    build.onEnd((result) => {
      const report = (severity) => ({ text, location }) => {
        const where = location ? `${location.file}:${location.line}:${location.column + 1}` : 'esbuild.js:1:1';
        console.error(`${where}: ${severity}: ${text}`);
      };
      result.errors.forEach(report('error'));
      result.warnings.forEach(report('warning'));
      if (--pendingBuilds === 0) console.log('[watch] build finished');
    });
  },
};

async function main() {
  const reporter = watch ? [watchReporterPlugin] : [];
  const ctx = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    outfile: 'dist/extension.js',
    external: ['vscode', '@grpc/grpc-js', '@grpc/proto-loader', 'protobufjs'],
    sourcemap: !production,
    minify: production,
    logLevel: 'info',
    plugins: [copyAssetsPlugin, ...reporter],
  });

  // Separate browser bundles for the panel webviews (metrics charts, logs table, traces table).
  const webviewCtx = await esbuild.context({
    entryPoints: [
      'src/views/webview/metricsChart.ts',
      'src/views/webview/logsTable.ts',
      'src/views/webview/tracesTable.ts',
      'src/views/webview/serviceMap.ts',
    ],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    outdir: 'dist/webview',
    sourcemap: !production,
    minify: production,
    logLevel: 'info',
    plugins: reporter,
  });

  if (watch) {
    await Promise.all([ctx.watch(), webviewCtx.watch()]);
    console.log('[esbuild] watching...');
  } else {
    await Promise.all([ctx.rebuild(), webviewCtx.rebuild()]);
    await Promise.all([ctx.dispose(), webviewCtx.dispose()]);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
