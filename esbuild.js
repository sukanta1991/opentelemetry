// Build script for the extension host bundle.
// - Bundles src/extension.ts -> dist/extension.js (CommonJS, `vscode` external)
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
      copyDir(
        path.join(__dirname, 'src', 'views', 'webview'),
        path.join(__dirname, 'dist', 'webview')
      );
      console.log('[esbuild] assets copied');
    });
  },
};

async function main() {
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
    plugins: [copyAssetsPlugin],
  });

  if (watch) {
    await ctx.watch();
    console.log('[esbuild] watching...');
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
