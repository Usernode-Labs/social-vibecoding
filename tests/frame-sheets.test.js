// The frame's sheets on the chrome (frontend/src/features/frame/frame-
// sheets.tsx): Notifications and the account menu, drawn with the kit's one
// sheet as the 2026-11-06 screen tour draws them (s05 to s07). They read
// what the bell's controller already keeps and call the shell's own entry
// points; nothing in them fetches or stores.
//
// Run with: node --test tests/frame-sheets.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { renderComponent } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const SHEETS = 'frontend/src/features/frame/frame-sheets.tsx';
const KIT = 'frontend/@/components/ui/kit.tsx';
const fixedStore = (state) => ({ get: () => state, set() {}, subscribe: () => () => {} });
const stubs = { '../notifications/notifications-store.js': { notificationsStore: fixedStore({ screenList: null }) } };
const row = (id, over) => ({ id, unread: true, time: '2h ago', label: 'Went live', segments: [{ t: 'strong', v: `Change ${id}` }], needsYou: false, who: null, appLine: 'GOAL! · Bruno', appName: 'GOAL!', appIconUrl: null, appIconEmoji: '⚽', ...over });

test('the kit\'s sheet is a dialog with the page\'s own head: a title, one sentence, then groups', () => {
  const html = renderComponent(KIT, 'Sheet', { kind: 'right', title: 'Notifications', purpose: 'One sentence.', closeLabel: 'Close', onClose() {}, children: 'BODY' });
  assert.match(html, /^<div class="fr fr-ovhost"><div class="fr-ov fr-right"><div class="fr-sheet" role="dialog" aria-modal="true" aria-labelledby="[^"]+" tabindex="-1">/);
  assert.match(html, /<button type="button" class="fr-ib fr-x" aria-label="Close">/);
  assert.match(html, /<div class="fr-head"><div class="fr-tx"><h2 class="fr-title" id="[^"]+">Notifications<\/h2><p class="fr-purpose">One sentence\.<\/p><\/div><\/div><div class="fr-stack">BODY<\/div>/);
  const src = read('frontend', '@', 'components', 'ui', 'kit.tsx');
  assert.match(src, /event\.key !== 'Escape'/, 'Escape closes it');
  assert.match(src, /event\.target === event\.currentTarget\) onClose\(\)/, 'so does a press on the dimmed page, and only there');
  assert.match(src, /before\?\.focus\?\./, 'and the focus goes back to where it was');
  assert.match(read('public', 'css', 'app.css'), /html\[data-skin\] \.fr\.fr-ovhost \{ position: fixed; inset: 0; z-index: 60; \}/, 'over the chrome and the screens');
});

test('Notifications: what needs an answer, then news, then what was seen', () => {
  const rows = [
    row(1, { needsYou: true, label: 'Your vote', appLine: 'Homeroom · #6412', appName: 'Homeroom', time: '1 min ago' }),
    row(2),
    row(3, { unread: false, time: '1d ago' }),
    row(4, { appName: null, appLine: '', who: 'evan', label: 'Mentioned you', segments: [{ t: 'text', v: 'see this' }] }),
  ];
  const html = renderComponent(SHEETS, 'NotificationsFrameSheet', { onClose() {}, rows }, { stubs, cache: false });
  assert.match(html, /<div class="fr-ov fr-right">/, 'the side sheet on a desktop');
  assert.match(html, /<h2 class="fr-title"[^>]*>Notifications<\/h2><p class="fr-purpose">1 needs an answer\. The rest is news\.<\/p>/);
  const order = ['>Needs an answer<', '>News<', '>Earlier<'].map((w) => html.indexOf(w));
  assert.ok(order.every((at, i) => at > -1 && (i === 0 || at > order[i - 1])), `three groups in a fixed order: ${order}`);
  assert.match(html, /<span class="fr-t">Your vote: Change 1<\/span><span class="fr-s">Homeroom · #6412 · 1 min ago<\/span><\/span><span class="fr-pill fr-act" data-kind="act">Answer<\/span>/,
    'a row that waits for you says what it asks, and ends in the blue word');
  assert.match(html, /<span class="fr-t">Change 2<\/span><span class="fr-s">Went live · GOAL! · Bruno<\/span><\/span><span class="fr-meta">2h ago<\/span>/, 'news ends in the time');
  assert.equal((html.match(/data-kind="act"/g) || []).length, 1, 'blue only where it waits for you');
  assert.match(html, /<span class="fr-av"[^>]*>e<\/span><span class="fr-tx"><span class="fr-t">see this<\/span>/, 'a person leads a row that has no project');
  assert.match(html, /<button type="button" class="fr-btn fr-quiet fr-block"><svg[^>]*>.*?<\/svg>Mark all read<\/button>/s, 'the sheet\'s one button');
});

test('Notifications with nothing unread offers no button, and says so in its sentence', () => {
  const seen = renderComponent(SHEETS, 'NotificationsFrameSheet', { onClose() {}, rows: [row(3, { unread: false })] }, { stubs, cache: false });
  assert.match(seen, /<p class="fr-purpose">Nothing needs an answer\. This is news\.<\/p>/);
  assert.doesNotMatch(seen, /Mark all read/);
  assert.doesNotMatch(seen, />Needs an answer<|>News</, 'an empty group is not drawn');
  const none = renderComponent(SHEETS, 'NotificationsFrameSheet', { onClose() {}, rows: [] }, { stubs, cache: false });
  assert.match(none, /<p class="fr-purpose">Nothing yet\. What happens in your communities shows up here\.<\/p>/);
});

test('the bell\'s own controller reads, marks and opens; the sheet only asks it to', () => {
  const src = read('frontend', 'src', 'features', 'frame', 'frame-sheets.tsx');
  assert.match(src, /controller\(\)\?\.refresh\?\.\(\)/);
  assert.match(src, /controller\(\)\?\.markAllRead\?\.\(\)/);
  assert.match(src, /onDone\(\); controller\(\)\?\._onItemClick\?\.\(view\.id\)/, 'a press closes the sheet, then opens the thing');
  assert.doesNotMatch(src, /\bfetch\(/, 'nothing is fetched here');
});

test('the account menu: you, Homeroom, then sign out, as single-line rows', () => {
  const html = renderComponent(SHEETS, 'AccountMenuSheet', { onClose() {}, username: 'snait' }, { stubs, cache: false });
  assert.match(html, /<div class="fr-ov fr-pop">/, 'small, anchored to the corner');
  assert.match(html, /<h2 class="fr-title"[^>]*>snait<\/h2><p class="fr-purpose">@snait<\/p>/);
  const order = ['>Your profile<', '>Settings<', '>Dark theme<', '>Invite people<', '>About Homeroom<', '>Sign out<'].map((w) => html.indexOf(w));
  assert.ok(order.every((at, i) => at > -1 && (i === 0 || at > order[i - 1])), `the rows in the tour's order: ${order}`);
  assert.equal((html.match(/class="fr-row fr-sm"/g) || []).length, 6, 'every row is the single-line kind');
  assert.match(html, /Dark theme<\/span><\/span><button type="button" role="switch" aria-checked="false" aria-label="Dark theme" class="fr-tog"><\/button>/, 'the theme is a switch on a row');
  assert.match(html, /<h2 class="fr-cap">Homeroom<\/h2>/);
  const src = read('frontend', 'src', 'features', 'frame', 'frame-sheets.tsx');
  for (const call of ["win.App?.navigateToSettings?.()", "win.Theme?.set?.(next ? 'dark' : 'light')", 'win.AppContext?.openInvite?.()', "win.App?.navigateToSettings?.('about')", 'win.Settings?.logout?.()']) {
    assert.ok(src.includes(call), `${call} is the shell's own entry point`);
  }
});

test('the sheets\' words are catalog text', () => {
  const n = JSON.parse(read('frontend', 'locales', 'en', 'notifications.json'));
  for (const k of ['frame.title', 'frame.purposeNeeds_one', 'frame.purposeNeeds_other', 'frame.purposeNews', 'frame.purposeEmpty', 'frame.needsAnswer', 'frame.news', 'frame.earlier', 'frame.answer', 'frame.markAllRead']) {
    assert.ok(n[k] && typeof n[k].text === 'string' && n[k].description, k);
  }
  const c = JSON.parse(read('frontend', 'locales', 'en', 'core.json'));
  for (const k of ['frame.menu.handle', 'frame.menu.profile', 'frame.menu.darkTheme', 'frame.menu.invite', 'frame.menu.about', 'frame.menu.signOut', 'frame.menu.open', 'common.close']) {
    assert.ok(c[k] && typeof c[k].text === 'string' && c[k].description, k);
  }
});
