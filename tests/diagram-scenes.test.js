'use strict';

// #6832: the fixed picture set a "steps" picture is drawn from. The client's
// list is the server's own, every drawing is a line drawing in currentColor
// with the one accent and nothing else (no fills, no ids, no outside image),
// and the three pictures are drawn by the one renderer under their own labels.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const diagram = require('../src/services/diagram');

test('#6832: the client keeps the server\'s picture set, and the kinds that use it', () => {
  const types = read('frontend/src/lib/diagram/types.ts');
  const m = types.match(/export const SCENES = \[([\s\S]*?)\] as const;/);
  assert.ok(m, 'the client has the picture set');
  const client = m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
  assert.deepEqual(client, [...diagram.SCENES], 'the two lists are the same, in the same order');
  assert.match(types, /export const NONE_KINDS = \['seen', 'moment', 'steps'\] as const;/);
  assert.match(types, /export function isNonePicture/);
});

test('#6832: every picture in the set has one drawing, in currentColor, with no fill or id', () => {
  const scene = read('frontend/src/lib/diagram/scene.tsx');
  for (const pic of diagram.SCENES) {
    assert.ok(new RegExp(`'?${pic}'?: svg\\(`).test(scene), `${pic} has a drawing`);
  }
  // One drawing per name, and no name outside the set (a picture is chosen
  // from the list, never invented at a call site).
  const names = [...scene.matchAll(/^  '?([a-z-]+)'?: svg\(/gm)].map((x) => x[1]);
  assert.deepEqual(names.sort(), [...diagram.SCENES].sort());
  assert.match(scene, /stroke="currentColor"/);
  assert.doesNotMatch(scene, /fill="(?!none")/, 'no fill colour of its own');
  assert.doesNotMatch(scene, /id="|<image|href="/, 'no ids and nothing loaded from elsewhere');
  // The one second colour is the app's own accent token.
  assert.match(scene, /var\(--accent\)/);
});

test('#6832: the renderer draws the three pictures under their own labels, in the shell\'s tokens', () => {
  const renderer = read('frontend/src/lib/diagram/diagram.tsx');
  for (const kind of ['seen', 'moment', 'steps']) {
    assert.match(renderer, new RegExp(`d\\.kind === '${kind}' \\? <`), `${kind} is in Diagram's switch`);
  }
  assert.match(renderer, /t\('project:diagram\.moment\.now'\)/);
  assert.match(renderer, /t\('project:diagram\.steps\.retry'\)/);
  assert.match(renderer, /t\('project:diagram\.seen\.before'\)/);
  const labels = read('frontend/src/lib/diagram/types.ts');
  assert.match(labels, /seen: 'project:diagram\.kind\.seen'/);
  assert.match(labels, /moment: 'project:diagram\.kind\.moment'/);
  assert.match(labels, /steps: 'project:diagram\.kind\.steps'/);
  // The CSS adds no stock colour beside the platform's own tokens.
  const css = read('public/css/app.css');
  const at = css.indexOf('.dev-ws-diagram-seen, .dev-ws-diagram-moment');
  assert.ok(at > 0, 'the picture rules are there');
  const block = css.slice(css.indexOf('.dev-ws-diagram-seen, .dev-ws-diagram-moment'), css.indexOf('/* Mermaid:', at));
  assert.doesNotMatch(block, /gray-\d|indigo-\d|#[0-9a-fA-F]{3,6}\b/, 'no stock hue and no hex of its own');
  assert.match(block, /var\(--accent-tint\)/);
  assert.match(block, /@media \(max-width: 419px\)[\s\S]*?\.dev-ws-diagram-seen-sides \{ grid-template-columns: minmax\(0, 1fr\); \}/,
    'the two sides stack on a narrow card');
});

test('#6832: a "no visible change" with no picture counts as incomplete, and the bot picks seen, then moment, then steps', () => {
  const tools = read('src/services/mcp-tools.js');
  assert.match(tools, /incomplete = \['no_picture'\];/);
  assert.match(tools, /diagramContract\.NONE_KINDS\.includes\(kind\)/);
  // The order, in the three places that tell the bot.
  const live = read('src/services/homeroom-bot-live.js');
  const charter = read('src/services/mcp-charter.js');
  const conventions = read('src/prompts/app-conventions.md');
  for (const [name, src] of [['the build lines', live], ['the charter', charter], ['the app conventions', conventions]]) {
    const seen = src.indexOf('"seen"') >= 0 ? src.indexOf('"seen"') : src.indexOf('`seen`');
    const moment = Math.max(src.indexOf('"moment"'), src.indexOf('`moment`'));
    const steps = Math.max(src.indexOf('"steps"'), src.indexOf('`steps`'));
    assert.ok(seen > 0 && moment > seen && steps > moment, `${name} name seen, then moment, then steps`);
  }
});

test('#6832: on a 390px phone a five-step row fits the card, with no sideways scroll', () => {
  const css = read('public/css/app.css');
  const m = css.match(/@media \(max-width: 419px\) \{[\s\S]*?\.dev-ws-diagram-step-caption \{[^}]*\}[\s\S]*?\n\}/);
  assert.ok(m, 'the narrow block exists');
  const block = m[0];
  assert.match(block, /\.dev-ws-diagram-step-pic \{ width: 56px; \}/);
  assert.match(block, /\.dev-ws-diagram-steps \{ gap: 12px; \}/);
  assert.match(block, /\.dev-ws-diagram-step-pic > svg \{ width: 32px; height: 32px; \}/);
  assert.match(block, /\.dev-ws-diagram-step-caption \{[^}]*overflow-wrap: anywhere;/,
    'a caption wraps rather than pushing its column wider');
  // The card's own inline padding must leave room for five 56px columns and
  // four 12px gaps (328px) inside a 390px phone's 32px gutters.
  const pad = block.match(/\.dev-ws-item > \.dev-ws-diagram \{ padding-inline: (\d+)px/);
  assert.ok(pad, 'the card picture narrows its inline padding on a phone');
  const inner = 390 - 32 - 2 * Number(pad[1]);
  assert.ok(inner >= 5 * 56 + 4 * 12, `five steps fit: ${inner}px available, 328px needed`);
});
