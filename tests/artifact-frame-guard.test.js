// test:changed: always (every shell source, for model or template HTML drawn in its own frame with scripts or this site's origin; scripts/test-changed.js)
'use strict';

// Artifacts, stage 1 (docs/plans/artifacts.md): one frame for every page the
// bot writes, and the rule no mode breaks: a frame never has both scripts and
// `allow-same-origin`. The frame itself lives in
// frontend/src/features/artifact/, which this suite does not walk: it is the
// one place that may name a mode's sandbox at all.
//
// Everywhere else, a shell file that draws HTML it was handed (`srcDoc` /
// `srcdoc`) must draw it in that one frame. A file that keeps an <iframe> of
// its own for such HTML may not give it `allow-scripts` (the page would run)
// or `allow-same-origin` (it could reach Homeroom). One frame is kept on
// purpose and named here with its reason: the admin's email template editor.
// Apps' own frames (an app, a side panel, a staging overlay, a landing
// viewer) load code by address, never model or template HTML by srcDoc, so
// they are not this rule's.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const ARTIFACT_DIR = path.join(ROOT, 'frontend', 'src', 'features', 'artifact') + path.sep;
const ROOTS = [path.join(ROOT, 'frontend', 'src'), path.join(ROOT, 'public', 'js')];
const SUFFIXES = ['.ts', '.tsx', '.js'];

// The one frame kept outside the one component, and why. A file here is
// allowed its looser sandbox only while it still edits a template in place
// and reads its own document to do it.
const KEPT = new Map([
  [path.join(ROOT, 'frontend', 'src', 'features', 'admin', 'email-templates', 'visual-tab.tsx'),
    'the admin\'s email template editor: it edits a template in place, shows no HTML the bot wrote, and must read its own document'],
]);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file, out);
    else if (SUFFIXES.includes(path.extname(entry.name))) out.push(file);
  }
  return out;
}

const sources = () => ROOTS.flatMap((dir) => walk(dir)).filter((file) => !file.startsWith(ARTIFACT_DIR));
const rel = (file) => path.relative(ROOT, file).split(path.sep).join('/');
const loose = (value) => /allow-scripts|allow-same-origin/.test(value);

/** The sandbox a JSX or string `<iframe>` tag names, raw (a JSX expression is read as written). */
function sandboxOf(tag) {
  const found = /\bsandbox\s*=\s*(?:"([^"]*)"|'([^']*)'|\{([^}]*)\})/.exec(tag);
  return found ? (found[1] ?? found[2] ?? found[3] ?? '') : '';
}

function offencesIn(file) {
  const src = fs.readFileSync(file, 'utf8');
  if (!/\bsrcDoc\b|\bsrcdoc\b/.test(src)) return [];
  const out = [];
  // A frame drawn as markup, or as a string a module writes.
  for (const tag of src.match(/<iframe\b[^>]*>/g) || []) {
    const sandbox = sandboxOf(tag);
    if (loose(sandbox)) out.push(`${rel(file)}: <iframe sandbox=${sandbox}> for srcDoc HTML`);
  }
  // A frame built with createElement('iframe'), its sandbox set later.
  if (/createElement\(\s*['"]iframe['"]\s*\)/.test(src)) {
    for (const found of src.match(/sandbox(?:\s*=\s*|['"]\s*,\s*)(?:"([^"]*)"|'([^']*)'|([^;\n]*))/g) || []) {
      if (loose(found)) out.push(`${rel(file)}: an iframe built in code gets ${found}`);
    }
  }
  return out;
}

test('no shell file outside features/artifact draws model or template HTML in a frame with scripts or this site\'s origin', () => {
  const offenders = [];
  for (const file of sources()) {
    if (KEPT.has(file)) continue;
    offenders.push(...offencesIn(file));
  }
  assert.deepEqual(offenders, [], 'draw it through the one frame (frontend/src/features/artifact/frame.tsx)');
});

test('every kept frame is named here with its reason, and still is what the reason says', () => {
  for (const [file, reason] of KEPT) {
    assert.ok(reason.length > 20, 'the reason is written down');
    const src = fs.readFileSync(file, 'utf8');
    assert.match(src, /sandbox="allow-same-origin"/, `${rel(file)} is still the frame this exception is for`);
    assert.match(src, /same-origin so this module can reach its DOM/i, `${rel(file)} still says why it needs it`);
  }
  // No other file keeps such a frame.
  for (const file of sources()) {
    if (KEPT.has(file)) continue;
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /sandbox="allow-same-origin"/, rel(file));
  }
});

test('the change pictures draw the email in the one frame: the tile static, the viewer measured by the helper', () => {
  const src = fs.readFileSync(path.join(ROOT, 'frontend', 'src', 'features', 'messages', 'bot-cards', 'gallery.tsx'), 'utf8');
  assert.doesNotMatch(src, /allow-same-origin|allow-scripts/, 'the gallery names no sandbox at all');
  assert.doesNotMatch(src, /<iframe|\bsrcDoc=/, 'it draws no frame of its own');
  assert.match(src, /<ArtifactFrame\b[\s\S]*?mode="static"/);
  assert.match(src, /mode="helper"/);
});

test('the thread comparison draws model HTML in the one frame, static', () => {
  const src = fs.readFileSync(path.join(ROOT, 'frontend', 'src', 'features', 'messages', 'bot-cards', 'thread-comparison.tsx'), 'utf8');
  assert.doesNotMatch(src, /<iframe|\bsrcDoc=|sandbox=/, 'it draws no frame of its own');
  assert.match(src, /<ArtifactFrame\b[\s\S]*?mode="static"/);
});
