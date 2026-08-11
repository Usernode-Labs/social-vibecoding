#!/usr/bin/env node
// Compiles the platform shell's Tailwind stylesheet.
//
//   npm run build:css     one-shot, minified → public/css/tailwind.css
//   npm run watch:css     rebuild-on-change for local iteration
//
// Dockerfile runs this in a disposable builder stage for every production and
// staging image, then copies only the output into the production-only runtime
// stage. The output is gitignored; this command also remains available for
// local development and focused tests.
//
// Tests pass --output <temporary-path> so they can validate a fresh compile
// without creating or depending on an artifact in the source tree.

const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CONFIG_FILE = 'tailwind.config.js';
const INPUT_FILE = 'styles/tailwind-input.css';
const DEFAULT_OUTPUT_FILE = 'public/css/tailwind.css';

const watch = process.argv.includes('--watch');

function optionValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) fail(`${name} requires a path`);
  return value;
}

const outputArg = optionValue('--output');
const outputPath = path.resolve(ROOT, outputArg || DEFAULT_OUTPUT_FILE);
const outputLabel = path.relative(ROOT, outputPath) || outputPath;

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
  '--output', outputPath,
];

fs.mkdirSync(path.dirname(outputPath), { recursive: true });

if (watch) {
  console.log(`[build-tailwind] watching → ${outputLabel}`);
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

  const bytes = fs.statSync(outputPath).size;
  console.log(`[build-tailwind] wrote ${outputLabel} — ${(bytes / 1024).toFixed(1)} KB`);
}
