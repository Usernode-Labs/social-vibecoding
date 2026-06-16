// esbuild build for the Pixel Cup Mini client bundle.
//
// Compiles + bundles the TypeScript game (entry: src/game/main.ts) into
// public/game.bundle.js as a single self-contained IIFE with Phaser
// bundled in. esbuild transpiles TS (it does NOT type-check — that's
// `tsc --noEmit` if you want it) which keeps the build fast and robust.
//
// Usage:
//   node build.mjs          one-shot production build (minified)
//   node build.mjs --watch  rebuild on change (used by `npm run dev`)

import { build, context } from 'esbuild';

const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ['src/game/main.ts'],
  bundle: true,
  outfile: 'public/game.bundle.js',
  format: 'iife',
  target: ['es2019'],
  platform: 'browser',
  minify: !watch,
  sourcemap: watch ? 'inline' : false,
  logLevel: 'info',
  // Phaser ships its own globals; bundling it keeps the app self-contained.
  loader: { '.js': 'js' },
};

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log('[build] watching for changes…');
} else {
  await build(options);
  console.log('[build] wrote public/game.bundle.js');
}
