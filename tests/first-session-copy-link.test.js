'use strict';

// Copy link in the made screen's invite sheet (#4180).
//
// The sheet (frontend/src/features/first-session/made.tsx InviteSheet) had
// one button, Share link, which opens the device's share sheet. On a Mac
// that is AirDrop, Mail, Messages, Notes, with no plain way to copy the link
// and paste it into a chat already open. Now:
//
//   - on a computer Copy link is the main button and Share… sits beside it;
//     on a phone Share link stays the main button and Copy link sits beside
//     it; with no share sheet at all, Copy link alone (inviteActions);
//   - Copy link copies the note and the link, the text the share sheet's
//     own fallback copied, and then does what a share does: keeps the note,
//     posts it once as the maker's first chat message, and tells the made
//     screen ("Invite sent");
//   - the copy survives Safari, which copies only inside the press and so
//     refused a `writeText` made after the press had waited on POST
//     .../invite-links: a link still being made goes on the clipboard as a
//     promise, from inside the press (copy-invite.ts copyText). The link is
//     not made early, since making one is what counts as an invite sent.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const MADE = 'frontend/src/features/first-session/made.tsx';
const COPY = 'frontend/src/features/first-session/copy-invite.ts';

const PROPS = {
  made: { slug: 'page-turners', name: 'Page Turners', emoji: '📚', description: null, example: null, conversationId: 3 },
  me: 'alex',
  onClose() {},
  onSent() {},
};

// The sheet, drawn on a device that is (or is not) touch and has (or has
// not) a share sheet: PlatformUI.isTouch() and navigator.share, as the
// browser has them.
function renderSheet({ touch, share }) {
  const saved = { ui: globalThis.PlatformUI, storage: globalThis.localStorage };
  globalThis.PlatformUI = { isTouch: () => touch };
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  if (share) navigator.share = async () => {};
  try {
    const { InviteSheet } = loadTsx(MADE);
    return renderToHtml(createElement(InviteSheet, PROPS));
  } finally {
    delete navigator.share;
    if (saved.ui === undefined) delete globalThis.PlatformUI; else globalThis.PlatformUI = saved.ui;
    if (saved.storage === undefined) delete globalThis.localStorage; else globalThis.localStorage = saved.storage;
  }
}

/** The sheet's buttons in order: [action, label, class]. */
function buttons(html) {
  return [...html.matchAll(/<button type="button" data-first-session-invite-action="(\w+)" class="([^"]*)">([^<]*)<\/button>/g)]
    .map((m) => [m[1], m[3], m[2]]);
}

test('which button leads: Copy link on a computer, Share link on a phone, Copy link alone without a share sheet', () => {
  const { inviteActions } = loadTsx(MADE);
  assert.deepEqual(inviteActions(false, true), ['copy', 'share']);
  assert.deepEqual(inviteActions(true, true), ['share', 'copy']);
  assert.deepEqual(inviteActions(false, false), ['copy']);
  assert.deepEqual(inviteActions(true, false), ['copy'], 'nothing to share with: Share link would only copy');
});

test('on a computer the sheet leads with Copy link, Share… beside it', () => {
  const [main, other, ...rest] = buttons(renderSheet({ touch: false, share: true }));
  assert.deepEqual(rest, []);
  assert.deepEqual([main[0], main[1]], ['copy', 'Copy link']);
  assert.deepEqual([other[0], other[1]], ['share', 'Share…']);
  // The main one is the sheet's accent pill; the other a white pill on the
  // sheet's zinc-100 ground, where pillNeutral's own zinc-100 would vanish.
  assert.match(main[2], /\bbg-violet-600\b/);
  assert.match(main[2], /\bflex-1\b/);
  assert.match(other[2], /\bbg-white\b/);
  assert.match(other[2], /\bshadow-sm\b/);
  assert.match(other[2], /\bdark:bg-zinc-800\b/, 'set apart from the sheet\'s own zinc-900 in dark mode');
  assert.doesNotMatch(other[2], /bg-violet|bg-zinc-100/);
});

test('both buttons are the Button primitive: the accent pill, and pillRaised beside it', () => {
  const src = read(MADE);
  const sheet = src.slice(src.indexOf('export function InviteSheet('), src.indexOf('export function PlanWaitsCard('));
  assert.match(sheet, /layout=\{main \? 'flex' : 'shrink'\}\s+variant=\{main \? 'pillAccent' : 'pillRaised'\}\s+size="pillLg"\s+ink=\{main \? 'solidLate' : 'neutral'\}/);
  // The close button is the sheet's one hand-written <button>.
  assert.equal((sheet.match(/<button\b/g) || []).length, 1);
  assert.match(read('frontend/@/components/ui/button.tsx'),
    /pillRaised: 'rounded-full bg-white shadow-sm hover:bg-zinc-50 dark:bg-zinc-800 dark:hover:bg-zinc-700',/);
});

test('on a phone Share link stays the main button, Copy link beside it', () => {
  const [main, other, ...rest] = buttons(renderSheet({ touch: true, share: true }));
  assert.deepEqual(rest, []);
  assert.deepEqual([main[0], main[1]], ['share', 'Share link']);
  assert.deepEqual([other[0], other[1]], ['copy', 'Copy link']);
  assert.match(main[2], /\bbg-violet-600\b/);
  assert.match(other[2], /\bbg-white\b/);
});

test('with no share sheet, Copy link is the only button', () => {
  for (const touch of [false, true]) {
    const all = buttons(renderSheet({ touch, share: false }));
    assert.deepEqual(all.map(([action, label]) => [action, label]), [['copy', 'Copy link']], `touch: ${touch}`);
    assert.match(all[0][2], /\bbg-violet-600\b/);
  }
});

test('the buttons sit where Share link sat: after the note, before the status and the link\'s terms', () => {
  const html = renderSheet({ touch: false, share: true });
  const at = (needle) => {
    const i = html.indexOf(needle);
    assert.ok(i >= 0, needle);
    return i;
  };
  assert.ok(at('Your note is also your first message in the group chat.') < at('data-first-session-invite-action="copy"'));
  assert.ok(at('data-first-session-invite-action="copy"') < at('data-first-session-invite-action="share"'));
  assert.ok(at('data-first-session-invite-action="share"') < at('Anyone with the link can join for the next 7 days, up to 25 people.'));
});

test('Copy link copies the note and the link, then does what a share does', () => {
  const { inviteText } = loadTsx(COPY);
  assert.equal(inviteText('Come try it with me!', 'https://h.test/invite/abc'), 'Come try it with me! https://h.test/invite/abc');
  assert.equal(inviteText('  Read with us  ', 'https://h.test/invite/abc'), 'Read with us https://h.test/invite/abc');
  assert.equal(inviteText('   ', 'https://h.test/invite/abc'), 'https://h.test/invite/abc', 'no note: the link alone');

  const src = read(MADE);
  // One "it went out" for both: the note kept, posted once, the made screen told.
  assert.match(src, /const sent = useCallback\(async \(\) => \{\s+keepNote\(made\.slug, note\);\s+await postNote\(\);\s+onSent\(\);\s+\}/);
  const share = src.slice(src.indexOf('const shareLink = useCallback'), src.indexOf('const copyLink = useCallback'));
  const copy = src.slice(src.indexOf('const copyLink = useCallback'), src.indexOf('const tile = '));
  assert.match(share, /await sent\(\);/);
  assert.match(copy, /await sent\(\);/);
  // The share sheet's own fallback copies the same text.
  assert.match(share, /navigator\.clipboard\.writeText\(inviteText\(note, url\)\)/);
  // The copy is started before the press awaits anything: a link already made
  // is copied as it is; one still to make goes in as a promise.
  assert.match(copy, /setBusy\(true\); setError\(null\); setStatus\(null\);\s+try \{\s+const ready = linkRef\.current;\s+const outcome = await copyText\(ready \? inviteText\(note, ready\)\s+: link\(\)\.then\(\(url\) => \(url \? inviteText\(note, url\) : null\)\)\);/);
  assert.equal((copy.match(/await /g) || []).length, 3, 'the copy, the pause on "Copied", the share\'s steps: nothing awaited before the copy');
  // Said on the sheet, and seen before it goes.
  assert.match(copy, /setCopied\(true\);\s+setStatus\('Link copied\. Paste it in your group chat\.'\);\s+await new Promise\(\(done\) => \{ setTimeout\(done, COPIED_MS\); \}\);\s+await sent\(\);/);
  assert.match(src, /copied \? '✓ Copied' : 'Copy link'/);
  assert.match(src, /const COPIED_MS = 1200;/);
});

test('Share link without a share sheet keeps the sheet up: the made screen is told when it closes', () => {
  const src = read(MADE);
  const share = src.slice(src.indexOf('const shareLink = useCallback'), src.indexOf('const copyLink = useCallback'));
  const sheet = src.slice(src.indexOf('export function InviteSheet('), src.indexOf('export function PlanWaitsCard('));
  // A finished share still closes the sheet with "Invite sent" at once.
  assert.match(share, /if \(shared\) \{ await sent\(\); return; \}/, 'only a finished share closes through sent()');
  // The fallback copy says so on the sheet instead: the note kept and posted
  // as the copy happens, and nothing marked sent until the sheet closes.
  assert.match(share, /await navigator\.clipboard\.writeText\(inviteText\(note, url\)\);\s+setStatus\('Link copied\. Paste it in your group chat\.'\);\s+keepNote\(made\.slug, note\);\s+await postNote\(\);\s+wentOut\.current = true;/);
  assert.doesNotMatch(share.slice(share.indexOf('writeText')), /await sent\(\)|onSent\(\)/,
    'the copy alone does not tell the made screen');
  // Every way out of the sheet then says the invite went out (close).
  assert.match(sheet, /const close = useCallback\(\(\) => \{ if \(wentOut\.current\) onSent\(\); else onClose\(\); \}, \[onClose, onSent\]\);/);
  assert.equal((sheet.match(/onClick=\{close\}/g) || []).length, 2, 'the backdrop and the ✕ both leave through close');
  assert.doesNotMatch(sheet, /onClick=\{onClose\}/, 'nothing closes by hand any more');
  assert.match(sheet, /if \(e\.key === 'Escape'\) close\(\);/);
  assert.match(sheet, /\}, \[close\]\);/);
});

test('opening the sheet makes no link: one is made only by a press', () => {
  const src = read(MADE);
  const sheet = src.slice(src.indexOf('export function InviteSheet('), src.indexOf('export function PlanWaitsCard('));
  // The one POST that makes a link is link(), and only the two presses call it.
  assert.equal((sheet.match(/method: 'POST'/g) || []).length, 2, 'the link, and the note as a chat message');
  assert.equal((sheet.match(/\blink\(\)/g) || []).length, 2);
  assert.match(sheet, /const url = await link\(\);/);
  assert.match(sheet, /: link\(\)\.then\(/);
  // No effect reaches for it.
  for (const effect of sheet.match(/useEffect\(\(\) => \{[\s\S]*?\n {2}\}, \[[^\]]*\]\);/g) || []) {
    assert.doesNotMatch(effect, /\blink\(\)|invite-links`, \{\s+method: 'POST'/);
  }
});

// ── copyText, against a stand-in clipboard ─────────────────────────────

function fakeClipboard({ write = 'ok', writeText = 'ok' } = {}) {
  const log = [];
  return {
    log,
    clipboard: {
      write: write === null ? undefined : async (items) => {
        log.push(['write', items.length]);
        const blob = await items[0].items['text/plain'];
        log.push(['wrote', await blob.text()]);
        if (write === 'refuse') throw new Error('NotAllowedError');
      },
      writeText: writeText === null ? undefined : async (text) => {
        log.push(['writeText', text]);
        if (writeText === 'refuse') throw new Error('NotAllowedError');
      },
    },
    Item: class { constructor(items) { this.items = items; } },
  };
}

function later() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

test('copyText: a link already made is written at once', async () => {
  const { copyText } = loadTsx(COPY);
  const { clipboard, Item, log } = fakeClipboard();
  const outcome = copyText('Come try it with me! https://h.test/invite/abc', { clipboard, Item, fallback: () => false });
  assert.deepEqual(log, [['writeText', 'Come try it with me! https://h.test/invite/abc']], 'in the same tick as the press');
  assert.equal(await outcome, 'copied');
});

test('copyText: a link still being made is handed to the clipboard inside the press, as a promise (Safari)', async () => {
  const { copyText } = loadTsx(COPY);
  const { clipboard, Item, log } = fakeClipboard();
  const link = later();
  const outcome = copyText(link.promise, { clipboard, Item, fallback: () => false });
  // Before the link has come, the write has already been asked for.
  assert.deepEqual(log, [['write', 1]]);
  link.resolve('Come try it with me! https://h.test/invite/abc');
  assert.equal(await outcome, 'copied');
  assert.deepEqual(log, [['write', 1], ['wrote', 'Come try it with me! https://h.test/invite/abc']], 'no writeText after it');
});

test('copyText: no link, nothing copied and nothing left unhandled', async () => {
  const { copyText } = loadTsx(COPY);
  for (const settles of [Promise.resolve(null), Promise.reject(new Error('offline'))]) {
    const { clipboard, Item, log } = fakeClipboard();
    assert.equal(await copyText(settles, { clipboard, Item, fallback: () => true }), 'no-link');
    assert.deepEqual(log.filter(([kind]) => kind !== 'write'), []);
  }
  // Without ClipboardItem too.
  const { clipboard } = fakeClipboard();
  assert.equal(await copyText(Promise.resolve(null), { clipboard, Item: null, fallback: () => true }), 'no-link');
});

test('copyText: without ClipboardItem, or when the promised write is refused, the text is copied once it is here', async () => {
  const { copyText } = loadTsx(COPY);
  {
    const { clipboard, log } = fakeClipboard();
    assert.equal(await copyText(Promise.resolve('Hi https://h.test/invite/a'), { clipboard, Item: null, fallback: () => false }), 'copied');
    assert.deepEqual(log, [['writeText', 'Hi https://h.test/invite/a']]);
  }
  {
    const { clipboard, Item, log } = fakeClipboard({ write: 'refuse' });
    assert.equal(await copyText(Promise.resolve('Hi https://h.test/invite/a'), { clipboard, Item, fallback: () => false }), 'copied');
    assert.deepEqual(log.at(-1), ['writeText', 'Hi https://h.test/invite/a']);
  }
  {
    // Every way refused but the hidden textarea.
    const { clipboard, Item } = fakeClipboard({ write: 'refuse', writeText: 'refuse' });
    const textarea = [];
    assert.equal(await copyText(Promise.resolve('Hi https://h.test/invite/a'), { clipboard, Item, fallback: (t) => { textarea.push(t); return true; } }), 'copied');
    assert.deepEqual(textarea, ['Hi https://h.test/invite/a']);
  }
  {
    const { clipboard, Item } = fakeClipboard({ write: 'refuse', writeText: 'refuse' });
    assert.equal(await copyText('Hi', { clipboard, Item, fallback: () => false }), 'refused');
    assert.equal(await copyText('Hi', { clipboard: null, Item: null, fallback: () => false }), 'refused');
  }
});

test('the sheet says what went wrong in its own words', () => {
  const src = read(MADE);
  assert.match(src, /if \(outcome === 'no-link'\) \{ setError\(\(was\) => was \|\| 'Could not make a link\. Try again\.'\); return; \}/,
    'the server\'s own reason (link()) when it gave one');
  assert.match(src, /if \(outcome === 'refused'\) \{ setError\('Could not copy the link\. Try again\.'\); return; \}/,
    'pressed again, the link is made and the copy is written at once');
  // The textarea fallback is the message menu's own.
  assert.match(read(COPY), /import \{ legacyCopy \} from '\.\.\/message-actions\/clipboard';/);
  assert.match(read('frontend/src/features/message-actions/clipboard.ts'), /export function legacyCopy\(text: string\): boolean \{/);
});
