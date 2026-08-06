#!/usr/bin/env node
// Compiles the platform shell's Tailwind stylesheet.
//
//   npm run build:css     one-shot, minified, stamped  → public/css/tailwind.css
//   npm run watch:css     rebuild-on-change for local iteration (NOT stamped)
//
// Why a committed artifact instead of a deploy-time build: the runtime image
// installs with `npm ci --production` (no devDependencies, so no tailwindcss),
// the deploy workflow only rsyncs + `docker compose up --build`, and worker
// checkouts never run an install step. Committing the compiled CSS keeps all
// three paths working with zero infrastructure change — at the cost of having
// to rebuild whenever the scanned markup changes, which the stamp written
// here (and checked by tests/tailwind-build.test.js) makes impossible to
// forget silently.
//
// Run this after ANY change to public/index.html, public/js/**, the native
// kit demo page, tailwind.config.js or styles/tailwind-input.css.

const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const {
  ROOT, CONFIG_FILE, INPUT_FILE, OUTPUT_FILE, expectedStamp, formatStamp,
} = require('./tailwind-stamp');

const watch = process.argv.includes('--watch');

// Resolve the tailwindcss CLI out of node_modules rather than trusting PATH
// or npx (which would happily go to the network on a cache miss).
function resolveCli() {
  let pkgJson;
  try {
    pkgJson = require.resolve('tailwindcss/package.json', { paths: [ROOT] });
  } catch {
    fail('tailwindcss is not installed. Run `npm install` (dev dependencies included) first.');
  }
  const pkg = JSON.parse(fs.readFileSync(pkgJson, 'utf8'));
  const binRel = typeof pkg.bin === 'string' ? pkg.bin : (pkg.bin && pkg.bin.tailwindcss);
  if (!binRel) fail(`Could not find the tailwindcss CLI entry point in ${pkgJson}`);
  return path.join(path.dirname(pkgJson), binRel);
}

function fail(message) {
  console.error(`[build-tailwind] ${message}`);
  process.exit(1);
}

const cli = resolveCli();
const args = [
  cli,
  '--config', path.join(ROOT, CONFIG_FILE),
  '--input', path.join(ROOT, INPUT_FILE),
  '--output', path.join(ROOT, OUTPUT_FILE),
];

fs.mkdirSync(path.dirname(path.join(ROOT, OUTPUT_FILE)), { recursive: true });

if (watch) {
  // Watch mode leaves the output UNSTAMPED on purpose: the stamp is a
  // point-in-time claim about the whole tree, and rewriting it on every
  // keystroke would just produce noise. Finish an iteration session with
  // `npm run build:css` — the freshness test will remind you otherwise.
  console.log('[build-tailwind] watching (output is not stamped — run `npm run build:css` before committing)');
  const child = spawn(process.execPath, [...args, '--watch'], { cwd: ROOT, stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code == null ? 1 : code));
} else {
  try {
    // The CLI writes its progress banner to stderr; inherit so a real
    // compile error is visible, and let a non-zero exit throw.
    execFileSync(process.execPath, [...args, '--minify'], { cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'] });
  } catch (err) {
    fail(`tailwindcss failed: ${err.message}`);
  }

  const outPath = path.join(ROOT, OUTPUT_FILE);
  const css = fs.readFileSync(outPath, 'utf8').replace(/^﻿/, '').trimStart();
  // Stamp AFTER compiling: --minify strips comments, so the stamp has to be
  // prepended to the finished file. Computed from the working tree, which is
  // exactly what the freshness test recomputes.
  const { stamp, files } = expectedStamp();
  fs.writeFileSync(outPath, `${formatStamp(stamp)}\n${css}\n`);

  const bytes = fs.statSync(outPath).size;
  console.log(`[build-tailwind] wrote ${OUTPUT_FILE} — ${(bytes / 1024).toFixed(1)} KB from ${files.length} scanned files`);
  console.log(`[build-tailwind] stamp ${stamp.slice(0, 16)}…`);
}
