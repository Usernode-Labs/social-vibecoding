import path from 'node:path';
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const dirname = path.dirname(fileURLToPath(import.meta.url));

// The React chassis for the platform shell.
//
// Deliberately NOT an HTML-entry Vite app: `build.rollupOptions.input` names
// src/main.tsx directly and there is no index.html here for Vite to
// transform. The shell's document is composed by scripts/build-shell.mjs
// from src/head.html (carried over verbatim) plus the prerendered body, so
// nothing rewrites the head's blocking scripts, the three stylesheet links
// or their load-bearing order.
//
// No Tailwind plugin either: the shell keeps its existing compiled v3
// stylesheet (tailwind.config.js + scripts/build-tailwind.js →
// public/css/tailwind.css), which now also scans this tree for classes.
// Tailwind v4 changes utility semantics and would silently restyle the shell,
// which is exactly what step 1 must not do.
export default defineConfig({
  // Pin the project root to this directory and never copy a public folder into
  // the build output. Vite's `root` defaults to `process.cwd()` and its
  // `publicDir` to `<root>/public`, which it copies into `outDir` on a client
  // build. The usual build runs Vite with the frontend directory as its cwd,
  // and there is no `frontend/public`, so nothing was copied. A Vite run
  // started from the repository root (PR 6917, 20 Nov 2026) took the
  // repository's own `public/` as its publicDir and copied it into
  // `public/shell/`, 127 files committed by the worker's `git add -A`. Pinned
  // and turned off, so the copy cannot depend on the caller's working
  // directory.
  root: dirname,
  publicDir: false,
  base: '/shell/',
  server: { host: '127.0.0.1' },
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(dirname, './@') },
  },
  build: {
    outDir: path.resolve(dirname, '../public/shell'),
    emptyOutDir: true,
    // Target the browsers the platform already supports; the shell's own
    // scripts are plain ES2020-era globals.
    target: 'es2020',
    sourcemap: false,
    modulePreload: { polyfill: false },
    rollupOptions: {
      input: path.resolve(dirname, 'src/main.tsx'),
      output: {
        // UNHASHED — on purpose, and still.
        //
        // public/sw.js precaches a hand-maintained SHELL_ASSETS list and
        // tests/pwa-shell-wiring.test.js asserts it covers every local asset
        // index.html loads. Content-hashed filenames would make that list
        // churn on every build. Freshness is already handled the way the rest
        // of the shell handles it: `no-cache, must-revalidate` on .js/.css
        // (src/services/static-cache.js) plus a network-first service worker.
        //
        // NO LONGER A SINGLE CHUNK. `inlineDynamicImports` folded every
        // dynamic import back into shell.js, which meant a lazy route could
        // not exist: the admin console's twenty section modules were 422KB of
        // the 1.75MB bundle, downloaded and executed by every visitor so an
        // admin could open a console behind an isAdmin gate. A CPU profile of
        // a warm mobile board load put 558ms of self time in this bundle
        // against 83ms in all of app-view.js, so this is where the shell's
        // JavaScript cost actually is.
        //
        // The names stay deterministic — `assets/shell-<name>.js`, from the
        // chunk's own module id — so SHELL_ASSETS stays a list a person can
        // maintain and read. A lazily-imported chunk is deliberately NOT in
        // it: index.html does not load it, the module graph does, on the
        // route that needs it. See the LAZY CHUNKS note in public/sw.js.
        entryFileNames: 'assets/shell.js',
        chunkFileNames: 'assets/shell-[name].js',
        assetFileNames: 'assets/shell.[ext]',
        manualChunks: undefined,
        inlineDynamicImports: false,
      },
    },
  },
});
