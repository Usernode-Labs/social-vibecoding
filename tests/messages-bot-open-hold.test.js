'use strict';
// The Homeroom bot's chat opens at its final shape (iPhone app and desktop,
// 19 October 2026). Recorded on the iPhone simulator, one open drew about six
// layouts in 350 ms: a spinner; the first page with every request a two-line
// row and a letter for its tile (the bot's tray had not answered, so nothing
// counted as settled); the settled rows folding into "N finished"; then page
// after page read in to fill the emptied screen, each adding days above,
// changing the oldest day's count and pushing the newest row down.
//
// Three parts:
//   1. frontend/src/features/messages/open-hold.ts, the decision, executed;
//   2. the conversation holds the bot's chat behind its spinner until then,
//      with its rows laid out underneath (app.css hides them), and never
//      longer than OPEN_HOLD_MS;
//   3. the bot's chat reads pages of 100, the server's most, so the fill
//      behind the spinner is a read or two rather than five.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const SCREEN = read('frontend/src/features/messages/index.tsx');
const STORE = read('frontend/src/features/messages/store.ts');
const API = read('frontend/src/features/messages/api.ts');
const CSS = read('public/css/app.css');
const THREAD = SCREEN.slice(SCREEN.indexOf('function ConversationThread('), SCREEN.indexOf('function ThreadActivityRow('));

// ── 1. The decision ──────────────────────────────────────────────────

const OPENED = { trayRead: true, hasOlder: true, loadingOlder: false, olderFailed: false, short: false, expired: false };

test('openHoldDone: shown once the tray has answered and the screen is full', () => {
  const { openHoldDone } = loadTsx('frontend/src/features/messages/open-hold.ts');
  assert.equal(openHoldDone(OPENED), true, 'tray read, screen full');
  assert.equal(openHoldDone({ ...OPENED, trayRead: false }), false,
    'before the tray answers, every row would be drawn as still open');
  assert.equal(openHoldDone({ ...OPENED, short: true }), false,
    'a short screen with older pages left is still filling');
  assert.equal(openHoldDone({ ...OPENED, loadingOlder: true }), false,
    'a page on its way changes what is drawn');
});

test('openHoldDone: nothing older, a failed read or the time cap end it', () => {
  const { openHoldDone } = loadTsx('frontend/src/features/messages/open-hold.ts');
  assert.equal(openHoldDone({ ...OPENED, short: true, hasOlder: false }), true,
    'a short chat with nothing older is as full as it gets');
  assert.equal(openHoldDone({ ...OPENED, short: true, olderFailed: true }), true,
    'a failed page reads no more until the button is pressed');
  assert.equal(openHoldDone({ ...OPENED, trayRead: false, short: true, loadingOlder: true, expired: true }), true,
    'never held longer than OPEN_HOLD_MS, whatever has not answered');
});

test('the cap is a couple of seconds', () => {
  const { OPEN_HOLD_MS } = loadTsx('frontend/src/features/messages/open-hold.ts');
  assert.ok(OPEN_HOLD_MS >= 1000 && OPEN_HOLD_MS <= 4000, String(OPEN_HOLD_MS));
});

// ── 2. The conversation ──────────────────────────────────────────────

test('only the bot\'s chat holds, and only while it opens with something to draw', () => {
  assert.match(SCREEN, /import \{ OPEN_HOLD_MS, openHoldDone \} from '\.\/open-hold';/);
  assert.match(THREAD, /const \{ work: botWork, failed: botWorkFailed \} = useBotWork\(\);/);
  assert.match(THREAD, /const holding = botDm && !!conversationId && shownFor !== conversationId && snap\.messages\.length > 0;/);
  // Closing it (the id goes) starts the next open over.
  assert.match(THREAD, /if \(conversationId\) return;\s*setShownFor\(null\);\s*setHoldOverFor\(null\);\s*\}, \[conversationId\]\);/);
  assert.match(THREAD, /window\.setTimeout\(\(\) => setHoldOverFor\(id\), OPEN_HOLD_MS\)/);
  assert.match(THREAD, /return \(\) => window\.clearTimeout\(timer\);\s*\}, \[holding, conversationId\]\);/);
});

test('it is shown from a layout effect after the fill, measuring what that read', () => {
  const fill = THREAD.indexOf('if (needsMoreHistory(el)) maybeLoadOlder();');
  const reveal = THREAD.indexOf('if (openHoldDone({');
  assert.ok(fill > 0 && reveal > fill, 'the reveal reads the scroller after the fill has');
  assert.match(THREAD, /\}, \[snap\.messages, snap\.nextBefore, snap\.loadingOlder, botWork\]\);/,
    'the tray folding rows into "N finished" can leave the screen short: the fill looks again');
  const effect = THREAD.slice(THREAD.lastIndexOf('useIsomorphicLayoutEffect(', reveal), THREAD.indexOf('});', reveal) + 3);
  assert.match(effect, /if \(!holding \|\| !el\) return;/);
  assert.match(effect, /trayRead: !!botWork \|\| botWorkFailed,/);
  assert.match(effect, /hasOlder: !!snap\.nextBefore,/);
  assert.match(effect, /loadingOlder: snap\.loadingOlder,/);
  assert.match(effect, /short: needsMoreHistory\(el\),/);
  assert.match(effect, /expired: holdOverFor === conversationId,/);
  assert.match(effect, /\}\)\) setShownFor\(conversationId\);/);
  // The hooks come before the conversation's early returns (hook order).
  assert.ok(reveal < THREAD.indexOf('if (!!snap.route.embedded !== embedded)'));
});

test('while it holds, the spinner stays up over rows laid out but hidden', () => {
  assert.match(THREAD, /data-opening=\{holding \? '' : undefined\}>/,
    'marked on the pane, so the scroller keeps its class string and attributes');
  assert.match(THREAD, /\{holding \? <div className="messages-state" data-opening-state=""><span className="messages-spinner" \/>\{t\('messages:thread\.loading'\)\}<\/div> : null\}/,
    'the same words and spinner as before the first page, so the open reads as one wait');
  assert.match(THREAD, /\{snap\.loadingThread && !snap\.messages\.length \? <div className="messages-state">/,
    'and the first one is untouched (#2907): holding needs messages, so only one is ever drawn');
  assert.match(CSS, /\.messages-thread-pane\[data-opening\] > \.messages-thread-scroll > :not\(\.messages-state\),\s*\.messages-thread-pane\[data-opening\] > \[data-transcript-overlay\] \{\s*visibility: hidden;\s*\}/,
    'visibility, not display: the rows keep their height, which is what "is the screen full" measures');
  assert.match(CSS, /\.messages-thread-pane\[data-opening\] > \.messages-thread-scroll > \.messages-state \{\s*position: sticky;\s*top: 0;\s*\}/,
    'the spinner stays in view however far down the hidden rows are scrolled');
});

// ── 3. Pages of 100 in the bot's chat ────────────────────────────────

test('the bot\'s chat reads the server\'s most per page; every other chat 50', () => {
  assert.match(API, /export async function listMessages\(id: number, before\?: number \| null, options\?: ReadOptions, limit = 50\)/);
  assert.match(API, /new URLSearchParams\(\{ limit: String\(limit\) \}\)/);
  assert.match(STORE, /return conversation\?\.homeroomBot === true \? 100 : 50;/);
  const open = STORE.slice(STORE.indexOf('export async function loadThread('), STORE.indexOf('export async function loadNewer('));
  assert.equal((open.match(/api\.listMessages\(conversationId, null, read, pageSize\(active\)\)/g) || []).length, 2,
    'the opening read and its fallback from a linked message');
  const older = STORE.slice(STORE.indexOf('export async function loadOlder('), STORE.indexOf('function validId('));
  assert.match(older, /api\.listMessages\(conversationId, state\.nextBefore, undefined, pageSize\(state\.active\)\)/);
  const server = read('src/services/conversations.js');
  assert.match(server, /return Math\.min\(Math\.max\(Number\(limit\) \|\| 50, 1\), 100\);/,
    '100 is the most a page can be; asking for more would read the same');
});

test('a page of the bot\'s chat asks for 100 on the wire', async (t) => {
  const seen = [];
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    return { ok: true, json: async () => ({ messages: [] }) };
  };
  const api = loadTsx('frontend/src/features/messages/api.ts');
  await api.listMessages(42);
  await api.listMessages(42, 9, undefined, 100);
  assert.match(seen[0], /\/api\/conversations\/42\/messages\?limit=50$/);
  assert.match(seen[1], /\/api\/conversations\/42\/messages\?limit=100&before=9$/);
});
