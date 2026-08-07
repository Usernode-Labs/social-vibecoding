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
  base: '/shell/',
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
        // UNHASHED, SINGLE CHUNK — on purpose.
        //
        // public/sw.js precaches a hand-maintained SHELL_ASSETS list and
        // tests/pwa-shell-wiring.test.js asserts it covers every local asset
        // index.html loads. Content-hashed filenames would make that list
        // churn on every build. Freshness is already handled the way the rest
        // of the shell handles it: `no-cache, must-revalidate` on .js/.css
        // (src/services/static-cache.js) plus a network-first service worker.
        entryFileNames: 'assets/shell.js',
        chunkFileNames: 'assets/shell-[name].js',
        assetFileNames: 'assets/shell.[ext]',
        manualChunks: undefined,
        inlineDynamicImports: true,
      },
    },
  },
});
