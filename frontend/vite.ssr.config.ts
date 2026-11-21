import path from 'node:path';
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const dirname = path.dirname(fileURLToPath(import.meta.url));

// Config for the build's SSG pass ONLY (see scripts/build-shell.mjs).
//
// Separate from vite.config.ts on purpose: that config's `rollupOptions.output`
// pins the deployable bundle's unhashed filenames, and inheriting them here
// put the prerender entry at an unrelated path. This pass produces a
// throwaway Node module that the build imports, calls once, and deletes.
export default defineConfig({
  // The same pin and publicDir off as vite.config.ts, for the same reason: a
  // run started from the repository root copied its `public/` into the build
  // output (PR 6917, 20 Nov 2026). Without these, it would copy it into
  // `frontend/.ssr` on this pass.
  root: dirname,
  publicDir: false,
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(dirname, './@') },
  },
  build: {
    ssr: path.resolve(dirname, 'src/prerender.tsx'),
    outDir: path.resolve(dirname, '.ssr'),
    emptyOutDir: true,
    minify: false,
    rollupOptions: {
      output: { entryFileNames: 'prerender.js' },
    },
  },
});
