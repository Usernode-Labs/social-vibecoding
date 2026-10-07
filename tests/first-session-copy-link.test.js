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
//     screen (since #4196 "Link copied", and the sheet stays open);
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
  // One "it went out" for both: said on the sheet, the note kept, posted
  // once, the made screen told how. The sheet stays open (#4196).
  assert.match(src, /const sent = useCallback\(async \(how: SentHow\) => \{\s+setStatus\(sentStatus\(how\)\);\s+setOut\(true\);\s+keepNote\(made\.slug, note\);\s+await postNote\(\);\s+onSent\(how\);\s+\}/);
  const share = src.slice(src.indexOf('const shareLink = useCallback'), src.indexOf('const copyLink = useCallback'));
  const copy = src.slice(src.indexOf('const copyLink = useCallback'), src.indexOf('const tile = '));
  assert.match(share, /await sent\('shared'\);/);
  assert.match(share, /await sent\('copied'\);/);
  assert.match(copy, /await sent\('copied'\);/);
  // The share sheet's own fallback copies the same text.
  assert.match(share, /const outcome = await copyText\(inviteText\(note, url\)\);/);
  // The copy is started before the press awaits anything: a link already made
  // is copied as it is; one still to make goes in as a promise.
  assert.match(copy, /setBusy\(true\); setError\(null\);\s+try \{\s+const ready = linkRef\.current;\s+const outcome = await copyText\(ready \? inviteText\(note, ready\)\s+: link\(\)\.then\(\(url\) => \(url \? inviteText\(note, url\) : null\)\)\);/);
  assert.equal((copy.match(/await /g) || []).length, 2, 'the copy, then the share\'s steps: nothing awaited before the copy, and no pause before the sheet says so');
  // Said on the sheet, which stays: "✓ Copied" on the button for a moment.
  assert.match(copy, /setCopied\(Date\.now\(\)\);\s+await sent\('copied'\);/);
  assert.match(src, /const t = window\.setTimeout\(\(\) => setCopied\(0\), COPIED_MS\);/);
  assert.match(src, /copied \? '✓ Copied' : 'Copy link'/);
  assert.match(src, /const COPIED_MS = 1200;/);
  const { sentStatus } = loadTsx(MADE);
  assert.equal(sentStatus('copied'), 'Link copied. Paste it in your group chat.');
  assert.equal(sentStatus('shared'), '✓ Link shared', 'never "Invite sent": the page cannot know a message went');
});

// #4196: "Clicking Share link just immediately goes back to the prior screen
// with ✓ Invite sent." The sheet closed the moment the share sheet resolved.
test('after a share or a copy the sheet stays open, says so, and Done closes it', () => {
  const src = read(MADE);
  const sheet = src.slice(src.indexOf('export function InviteSheet('), src.indexOf('export function PlanWaitsCard('));
  // Nothing in the sheet closes it but ✕, the backdrop, Escape and Done.
  assert.equal((sheet.match(/onClose\(\)/g) || []).length, 1, 'Escape');
  assert.equal((sheet.match(/onClick=\{onClose\}/g) || []).length, 3, 'the backdrop, ✕ and Done');
  assert.match(sheet, /\{out \? \(\s+<Button\s+type="button"\s+data-first-session-invite-done=""\s+onClick=\{onClose\}\s+layout="full"\s+variant="pillRaised"\s+size="pillLg"\s+ink="neutral"/);
  // Not drawn before anything went out.
  assert.doesNotMatch(renderSheet({ touch: false, share: true }), /data-first-session-invite-done/);
  // The made screen is told how, and does not close the sheet.
  assert.match(src, /onSent=\{\(how\) => setSentHow\(how\)\}/);
  assert.doesNotMatch(src, /setInviting\(false\); \}\}/);
});

test('a share: cancelled changes nothing; refused copies instead; a made link is shared from inside the press', () => {
  const src = read(MADE);
  const share = src.slice(src.indexOf('const shareLink = useCallback'), src.indexOf('const copyLink = useCallback'));
  // A link already made is not waited on, so the press can still open the share sheet.
  assert.match(share, /const url = linkRef\.current \|\| await link\(\);/);
  // Cancelled: back where it was, the status untouched.
  assert.match(share, /if \(\(err as Error\)\?\.name === 'AbortError'\) return;/);
  assert.match(share, /setBusy\(true\); setError\(null\);\s+try/, 'no status cleared on the way in');
  // Any other failure falls through to the copy; a refused copy leaves the
  // link ready for the next press.
  assert.match(share, /if \(outcome === 'copied'\) \{\s+setCopied\(Date\.now\(\)\);\s+await sent\('copied'\);\s+return;\s+\}/);
  assert.match(share, /setStatus\('Your link is ready\. Press Share again to send it\.'\);/);
  assert.doesNotMatch(share, /navigator\.clipboard\.writeText/, 'the copy goes through copyText and its fallbacks');
});

test('Escape closes the sheet, but not while it is dismissing the OS share sheet', () => {
  const src = read(MADE);
  assert.match(src, /if \(sharing\.current \|\| Date\.now\(\) - shareGoneAt\.current < SHARE_ESCAPE_MS\) return;\s+onClose\(\);/);
  const share = src.slice(src.indexOf('const shareLink = useCallback'), src.indexOf('const copyLink = useCallback'));
  assert.match(share, /sharing\.current = true;\s+try \{\s+await nav\.share\(/);
  assert.match(share, /\} finally \{\s+sharing\.current = false;\s+shareGoneAt\.current = Date\.now\(\);\s+\}/);
});

test('opening the sheet makes no link: one is made only by a press', () => {
  const src = read(MADE);
  const sheet = src.slice(src.indexOf('export function InviteSheet('), src.indexOf('export function PlanWaitsCard('));
  // The one POST that makes a link is link(), and only the two presses call it.
  assert.equal((sheet.match(/method: 'POST'/g) || []).length, 2, 'the link, and the note as a chat message');
  assert.equal((sheet.match(/\blink\(\)/g) || []).length, 2);
  assert.match(sheet, /const url = linkRef\.current \|\| await link\(\);/);
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
