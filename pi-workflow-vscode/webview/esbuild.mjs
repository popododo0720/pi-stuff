import * as esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['webview/src/main.ts'],
  bundle: true,
  outfile: 'out/webview/main.js',
  format: 'iife',
  target: 'es2020',
  minify: process.argv.includes('--minify'),
  sourcemap: false,
  loader: { '.css': 'text' },
});
