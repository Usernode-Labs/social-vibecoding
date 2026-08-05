// #419: platform-shell About row, modal, and first-run lifecycle contracts.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
const viewJs = fs.readFileSync(path.join(root, 'public/js/app-view.js'), 'utf8');

test('drawer exposes an app-scoped 44px About control on the central lifecycle', () => {
  assert.match(html, /id="drawer-row-app-about"[\s\S]{0,220}?min-h-\[44px\]/);
  const start = appJs.indexOf('    setAppOpen(open) {');
  const lifecycle = appJs.slice(start, appJs.indexOf('    setForkVisible', start));
  assert.match(lifecycle, /drawer-row-app-about/);
  assert.match(lifecycle, /classList\.toggle\('hidden', !open\)/);
});

test('modal is labelled, modal, and has explicit dismissal controls', () => {
  assert.match(html, /id="app-about-modal"[\s\S]{0,180}?role="dialog"[\s\S]{0,120}?aria-modal="true"/);
  assert.match(html, /aria-labelledby="app-about-title"/);
  assert.match(html, /id="app-about-close"/);
  assert.match(html, /id="app-about-continue"/);
  assert.match(appJs, /e\.key === 'Escape'[\s\S]{0,180}?AppView\.closeAbout\(\)/);
});

test('untrusted manifest strings are rendered with textContent, never innerHTML', () => {
  const start = viewJs.indexOf('  openAbout(');
  const body = viewJs.slice(start, viewJs.indexOf('  closeAbout()', start));
  assert.ok(start >= 0);
  assert.match(body, /app-about-title'\)\.textContent/);
  assert.match(body, /app-about-summary'\)\.textContent/);
  assert.match(body, /text\.textContent = String\(feature\)/);
  assert.doesNotMatch(body, /innerHTML/);
});

test('first-run key is per app and deliberately not per deploy SHA', () => {
  assert.match(viewJs, /ABOUT_SEEN_PREFIX: 'usernode:app-about-seen:'/);
  const start = viewJs.indexOf('  _aboutStorageKey(');
  const keyFn = viewJs.slice(start, viewJs.indexOf('  _authoredAbout()', start));
  assert.match(keyFn, /encodeURIComponent/);
  assert.doesNotMatch(keyFn, /sha|version/i);
  assert.match(viewJs, /localStorage\.getItem\(key\) === '1'/);
  assert.match(viewJs, /_aboutSeenThisPage/);
});

test('automatic intro requires authored content; fallback stays on-demand', () => {
  const start = viewJs.indexOf('  maybeShowAbout(');
  const maybe = viewJs.slice(start, viewJs.indexOf('  openAbout(', start));
  assert.match(maybe, /if \(!about/);
  assert.match(viewJs, /has not published an introduction yet/);
});

test('deterministic capture opens About without recording first-run state', () => {
  const start = viewJs.indexOf("if (shot === 'app-about')");
  const shot = viewJs.slice(start, viewJs.indexOf('} else if (!shot)', start));
  assert.match(shot, /AppView\.openAbout\(\)/);
  assert.doesNotMatch(shot, /maybeShowAbout|localStorage/);
});
