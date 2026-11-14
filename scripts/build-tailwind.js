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
    // The Kubernetes image builds the shell and CSS from one dependency
    // tree under frontend/. Local and Docker-compose builds keep using the
    // root install. Search both explicitly so the compiler script stays the
    // single entry point for either layout without NODE_PATH or npx.
    pkgJson = require.resolve('tailwindcss/package.json', {
      paths: [ROOT, path.join(ROOT, 'frontend')],
    });
  } catch {
    fail('tailwindcss is not installed. Run `npm install` (dev dependencies included) first.');
  }
  const pkg = JSON.parse(fs.readFileSync(pkgJson, 'utf8'));
  const binRel = typeof pkg.bin === 'string' ? pkg.bin : (pkg.bin && pkg.bin.tailwindcss);
  if (!binRel) fail(`Could not find the tailwindcss CLI entry point in ${pkgJson}`);
  return path.join(path.dirname(pkgJson), binRel);
}

// ── Settings › Accessibility › Reduce motion (#6510) ──────────────────────
// The head module writes data-motion="reduce" on <html> when the setting is
// on. Tailwind's `motion-reduce:` and `motion-safe:` variants are media
// queries only, and a config plugin cannot replace them (3.4.17 registers its
// own reduced-motion variants after every user plugin), so the compiled sheet
// is finished here instead:
//   - every rule inside `@media (prefers-reduced-motion: reduce)` gets a twin
//     right after the block, its selector under
//     `:where(html[data-motion="reduce"])`, any other media condition kept;
//   - every rule inside `@media (prefers-reduced-motion: no-preference)` is
//     scoped to `:where(html:not([data-motion="reduce"]))`, so motion-safe
//     motion stops when the setting is on.
// :where() adds no specificity, so a class weighs what it did. app.css and
// native.css carry the same twins by hand (tests/reduce-motion-setting.test.js).
const MOTION_ON = ':where(html[data-motion="reduce"])';
const MOTION_OFF = ':where(html:not([data-motion="reduce"]))';
const MOTION_MARK = '/*#6510 reduce-motion twins*/';

// postcss's `selectors` splits on top-level commas only, so a comma inside
// :is() or :not() stays put.
function scopeRule(rule, scope) {
  rule.selectors = rule.selectors.map((one) => `${scope} ${one}`);
}

function addMotionTwins(css) {
  if (css.includes(MOTION_MARK)) return css;
  const postcss = require(require.resolve('postcss', { paths: [ROOT, path.join(ROOT, 'frontend')] }));
  const root = postcss.parse(css);
  const inKeyframes = (rule) => rule.parent && rule.parent.type === 'atrule' && /keyframes$/.test(rule.parent.name);
  root.walkAtRules('media', (media) => {
    const params = media.params;
    if (/prefers-reduced-motion:\s*no-preference/.test(params)) {
      media.walkRules((rule) => {
        if (!inKeyframes(rule)) scopeRule(rule, MOTION_OFF);
      });
      return;
    }
    if (!/prefers-reduced-motion:\s*reduce/.test(params)) return;
    const twins = [];
    media.each((node) => {
      if (node.type === 'rule') {
        const twin = node.clone();
        scopeRule(twin, MOTION_ON);
        twins.push(twin);
      } else if (node.type === 'atrule' && !/keyframes$/.test(node.name)) {
        // A stacked variant (motion-reduce:hover: is an @media (hover) inside).
        const twin = node.clone();
        twin.walkRules((rule) => {
          if (!inKeyframes(rule)) scopeRule(rule, MOTION_ON);
        });
        twins.push(twin);
      }
    });
    if (!twins.length) return;
    const rest = params.split(/\s+and\s+/).filter((p) => !/prefers-reduced-motion/.test(p)).join(' and ');
    if (rest) {
      media.after(postcss.atRule({ name: 'media', params: rest, nodes: twins }));
    } else {
      media.after(twins);
    }
  });
  return MOTION_MARK + root.toString();
}

function finishMotion(outputPath) {
  try {
    const css = fs.readFileSync(outputPath, 'utf8');
    const done = addMotionTwins(css);
    if (done !== css) fs.writeFileSync(outputPath, done);
  } catch (err) {
    fail(`adding the Reduce motion twins failed: ${err.message}`);
  }
}

function fail(message) {
  console.error(`[build-tailwind] ${message}`);
  process.exit(1);
}

module.exports = { addMotionTwins };
if (require.main === module) main();

function main() {
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
    // Each rebuild rewrites the file without the twins; put them back.
    fs.watchFile(outputPath, { interval: 300 }, () => {
      try { if (fs.existsSync(outputPath)) finishMotion(outputPath); } catch { /* the next rebuild tries again */ }
    });
    child.on('exit', (code) => process.exit(code == null ? 1 : code));
  } else {
    try {
      // The CLI writes its progress banner to stderr; inherit so a real
      // compile error is visible, and let a non-zero exit throw.
      execFileSync(process.execPath, [...args, '--minify'], { cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'] });
    } catch (err) {
      fail(`tailwindcss failed: ${err.message}`);
    }
    finishMotion(outputPath);

    const bytes = fs.statSync(outputPath).size;
    console.log(`[build-tailwind] wrote ${outputLabel} — ${(bytes / 1024).toFixed(1)} KB`);
  }
}
