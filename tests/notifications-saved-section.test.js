// #1280: the notifications drawer's pinned "Saved" section.
//
// Two halves, both exercised against the SHIPPED source rather than a copy:
//
//  1. The payload — GET /api/notifications carries `savedMessages` on the
//     first page only (it is a pinned section, not a paginated one), and
//     staging's ?demo=1 injects mock rows because `message_bookmarks` is
//     `staging:private` and a staging clone therefore has none.
//  2. The drawer — the controller keeps saves OUT of `items` (a save has no
//     unread state and must not touch the badge, the mark-all path or the
//     grouping transform), renders them through the store, and unsaves
//     optimistically from the section as well as from the message.
//
// Run with: node --test tests/notifications-saved-section.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const poolMod = require('../src/db/pool');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(
  path.join(ROOT, 'frontend', 'src', 'features', 'notifications', 'notifications.js'),
  'utf8'
);
const LIST_SRC = fs.readFileSync(
  path.join(ROOT, 'frontend', 'src', 'features', 'notifications', 'notifications-list.tsx'),
  'utf8'
);
const STORE_SRC = fs.readFileSync(
  path.join(ROOT, 'frontend', 'src', 'features', 'notifications', 'notifications-store.js'),
  'utf8'
);
const CHAT_SRC = fs.readFileSync(path.join(ROOT, 'public', 'js', 'group-chat.js'), 'utf8');
const ICONS_SRC = fs.readFileSync(
  path.join(ROOT, 'frontend', '@', 'components', 'ui', 'icons.tsx'), 'utf8'
);
const SCHEMA = fs.readFileSync(path.join(ROOT, 'src', 'db', 'schema.sql'), 'utf8');

// ── the payload ─────────────────────────────────────────────────────────

function makeMockPool({ saved = [] } = {}) {
  const calls = [];
  return {
    calls,
    query(sql, params) {
      calls.push({ sql: String(sql), params });
      if (/FROM message_bookmarks b/.test(sql)) {
        return Promise.resolve({ rows: saved });
      }
      if (/FROM notifications n/.test(sql)) return Promise.resolve({ rows: [] });
      if (/COUNT\(\*\)::int AS c FROM notifications/.test(sql)) {
        return Promise.resolve({ rows: [{ c: 0 }] });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
  };
}

function loadRoutes(env, pool) {
  const prevEnv = process.env.USERNODE_ENV;
  if (env == null) delete process.env.USERNODE_ENV;
  else process.env.USERNODE_ENV = env;
  const prevGetPool = poolMod.getPool;
  poolMod.getPool = () => pool;
  const routePath = require.resolve('../src/routes/notifications');
  delete require.cache[routePath];
  const mod = require('../src/routes/notifications');
  if (prevEnv == null) delete process.env.USERNODE_ENV;
  else process.env.USERNODE_ENV = prevEnv;
  poolMod.getPool = prevGetPool;
  delete require.cache[routePath];
  return mod;
}

function startServer(mod) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: 7, username: 'tester' }; next(); });
  app.use(mod.notificationsRoutes({}));
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve({ server, port: server.address().port }));
  });
}

const SAVED_ROW = {
  message_id: 31,
  saved_at: '2026-08-17T10:00:00.000Z',
  content: 'the deploy runbook lives in docs/deploy.md',
  thread_type: null,
  thread_ref: null,
  message_created_at: '2026-08-17T09:00:00.000Z',
  app_id: 5,
  app_slug: 'real-app',
  app_name: 'Real App',
  author: 'bob',
};

test('the first page carries savedMessages; cursor pages do not', async () => {
  const pool = makeMockPool({ saved: [SAVED_ROW] });
  const mod = loadRoutes('production', pool);
  const { server, port } = await startServer(mod);
  try {
    const first = await (await fetch(
      `http://127.0.0.1:${port}/api/notifications?limit=100`
    )).json();
    assert.equal(first.savedMessages.length, 1);
    assert.deepEqual(first.savedMessages[0], {
      messageId: 31,
      appId: 5,
      appSlug: 'real-app',
      appName: 'Real App',
      author: 'bob',
      content: 'the deploy runbook lives in docs/deploy.md',
      threadType: null,
      threadRef: null,
      savedAt: '2026-08-17T10:00:00.000Z',
      messageCreatedAt: '2026-08-17T09:00:00.000Z',
    });

    const paged = await (await fetch(
      `http://127.0.0.1:${port}/api/notifications?limit=100`
      + '&before=2026-07-01T00:00:00Z&before_id=1'
    )).json();
    assert.equal(paged.savedMessages, undefined,
      'a pinned section would only be re-sent on every scroll page');
  } finally {
    server.close();
  }
});

test('staging + ?demo=1 injects mock saved rows, and nothing does outside it', async () => {
  const pool = makeMockPool();
  const staging = loadRoutes('staging', pool);
  let { server, port } = await startServer(staging);
  try {
    const demo = await (await fetch(
      `http://127.0.0.1:${port}/api/notifications?limit=100&demo=1`
    )).json();
    assert.equal(demo.savedMessages.length, 2, 'both mock saves are injected');
    assert.ok(demo.savedMessages.every((s) => s.appSlug === 'staging-demo'),
      'obviously-fake app attribution');
    assert.ok(demo.savedMessages.every((s) => /^\[Mock\]/.test(s.content)),
      'mock content is labelled as such');
    assert.ok(demo.savedMessages.some((s) => s.threadType === 'issue'),
      'one mock covers the topic-thread routing branch');

    const plain = await (await fetch(
      `http://127.0.0.1:${port}/api/notifications?limit=100`
    )).json();
    assert.deepEqual(plain.savedMessages, [], 'no mocks without ?demo=1');
  } finally {
    server.close();
  }

  const prod = loadRoutes('production', makeMockPool());
  ({ server, port } = await startServer(prod));
  try {
    const body = await (await fetch(
      `http://127.0.0.1:${port}/api/notifications?limit=100&demo=1`
    )).json();
    assert.deepEqual(body.savedMessages, [], 'the mock is a strict no-op in production');
  } finally {
    server.close();
  }
});

test('the bookmarks table is staging-private, like the notifications it renders beside', () => {
  assert.match(SCHEMA, /CREATE TABLE IF NOT EXISTS message_bookmarks/);
  assert.match(SCHEMA, /COMMENT ON TABLE message_bookmarks\s+IS 'staging:private'/);
  assert.match(SCHEMA, /UNIQUE\(user_id, message_id\)/,
    'one row per (user, message) is what makes saving idempotent');
});

// ── the drawer ──────────────────────────────────────────────────────────

test('saves are kept out of the notification feed proper', () => {
  assert.match(SRC, /\n  saved: \[\],/, 'the controller holds its own saved list');
  // The badge is unread-driven; a save has no unread state, so it must not
  // reach _badgeTotal.
  const badge = SRC.match(/_badgeTotal\(\) \{([\s\S]*?)\n  \},/);
  assert.ok(badge, '_badgeTotal() found');
  assert.doesNotMatch(badge[1], /saved/, 'saved messages must never inflate the bell badge');
  const bellItems = SRC.match(/_bellItems\(\) \{([\s\S]*?)\n  \},/);
  assert.ok(bellItems, '_bellItems() found');
  assert.doesNotMatch(bellItems[1], /saved/, 'the grouping transform still runs on items alone');
});

test('the section renders above the invites and the list, and only when non-empty', () => {
  const savedIdx = LIST_SRC.indexOf('id="notifications-saved"');
  const invitesIdx = LIST_SRC.indexOf('id="notifications-invites"');
  const listIdx = LIST_SRC.indexOf('id="notifications-list"');
  assert.ok(savedIdx > 0 && invitesIdx > savedIdx && listIdx > invitesIdx,
    'the saved section is the TOP section of the drawer');
  assert.match(LIST_SRC, /saved\.length \? \([\s\S]{0,400}Saved\n/,
    'the "Saved" header only renders when something is saved');
  assert.match(STORE_SRC, /saved: null,/,
    'the prerendered state is empty, so the SSG pass and hydration agree');
});

test('the section is rendered on every refresh, not on open', () => {
  // This asserted the opposite until THE UI OVERHAUL. The bell's panel was
  // presented on demand and FILLED at that moment — show() rendered all three
  // sections before handing the node to the kit, precisely so the sheet
  // measured the right height — so the paths that mattered were the two
  // branches of show() plus a refresh landing while it was already open.
  //
  // The list lives in the hamburger now, which is always mounted (translated
  // off-screen, not built on open). There is no "before presenting" to render
  // at, so the render is unconditional and the drawer opens onto CURRENT rows
  // rather than last-open's.
  const show = SRC.match(/\n  show\(\) \{([\s\S]*?)\n  \},/);
  assert.ok(show, 'show() found');
  assert.equal((show[1].match(/_renderSaved\(\)/g) || []).length, 0,
    'show() forwards to the drawer and renders nothing itself');
  assert.match(show[1], /HeaderMenu\?\.open\?\(\)|HeaderMenu\?\.open\?\.\(\)/,
    'it forwards to the drawer that actually presents the list');
  const refresh = SRC.match(/\n  async refresh\(options\) \{([\s\S]*?)\n  \},/);
  assert.ok(refresh, 'refresh() found');
  assert.match(refresh[1], /Notifications\._renderSaved\(\);/,
    'every refresh repaints the section');
  assert.ok(!/if \(Notifications\.open\)[\s\S]{0,80}_renderSaved/.test(refresh[1]),
    'and does so unconditionally — an always-mounted list has nothing to gate on');
});

test('unsaving is possible from the section as well as from the message', () => {
  assert.match(SRC, /_unsave\(messageId\)/, 'the drawer has its own unsave path');
  assert.match(SRC, /method: 'DELETE'/, 'it calls the same toggle endpoint');
  assert.match(SRC, /GroupChat\._paintBookmark/,
    "unsaving in the drawer repaints the message's own button when that chat is open");
  assert.match(LIST_SRC, /data-saved-unsave=/, 'the row carries a visible Unsave control');
  assert.match(LIST_SRC, /label: 'Unsave'/, 'and a swipe action on touch');
});

test('clicking a saved row opens the message rather than consuming it', () => {
  const handler = SRC.match(/_onSavedClick\(messageId\) \{([\s\S]*?)\n  \},/);
  assert.ok(handler, '_onSavedClick() found');
  assert.doesNotMatch(handler[1], /_unsave|DELETE/,
    'a save is not a to-do item — opening one must not clear it');
  assert.match(handler[1], /subTab: 'topic'/,
    'a message posted in a topic thread opens that discussion (#194 parity)');
  assert.match(handler[1], /subTab: 'chat'/, 'everything else lands on the app chat');
});

test('the drawer can be opened by URL, so the section is screenshot-able', () => {
  assert.match(SRC, /shot !== 'notifications'/, '?shot=notifications opens the drawer');
  const dapp = JSON.parse(fs.readFileSync(path.join(ROOT, 'dapp.json'), 'utf8'));
  const declared = (dapp.tests || []).filter((t) => /shot=notifications/.test(t.path || ''));
  assert.ok(declared.length >= 1,
    'a dapp.json test selects against the drawer this change adds a section to');
});

// ── the message-side button ─────────────────────────────────────────────

test('every message kind carries the save button', () => {
  const calls = CHAT_SRC.match(/GroupChat\._renderBookmarkBtn\(msg\)/g) || [];
  assert.equal(calls.length, 3,
    'ordinary messages, system/vote rows and spec-share cards all get one');
});

test('the message button draws the shell’s own bookmark, not a second one', () => {
  // frontend/@/components/ui/icons.tsx is the shell's icon set and
  // tests/shell-icon-set.test.js forbids an inline <svg> anywhere under
  // frontend/src — but public/js/** is a classic script that cannot import
  // the module, so this one glyph exists in two places. That is only safe
  // while the path data is identical, which is what this asserts: the
  // strings are read OUT of the module, so redrawing the glyph there
  // without updating the script fails here.
  const outline = ICONS_SRC.match(/BookmarkIcon',\s*\n\s*'([^']+)'/);
  const solid = ICONS_SRC.match(/BookmarkSolidIcon',\s*\n\s*'([^']+)'/);
  assert.ok(outline && solid, 'the module exports the outline/solid bookmark pair');
  assert.ok(CHAT_SRC.includes(outline[1]), 'the unsaved button draws the module’s outline');
  assert.ok(CHAT_SRC.includes(solid[1]), 'the saved button draws the module’s solid');
  assert.match(LIST_SRC, /BookmarkSolidIcon/,
    'the drawer row imports the glyph rather than inlining one');
});

test('the mark is hollow when unsaved and solid when saved', () => {
  const svg = CHAT_SRC.match(/_bookmarkSvg\(on\) \{([\s\S]*?)\n  \},/);
  assert.ok(svg, '_bookmarkSvg() found');
  assert.match(svg[1], /on\s*\?\s*\n?\s*' fill="currentColor">'/,
    'the saved mark is a fill');
  assert.match(svg[1], /fill="none" stroke="currentColor"/,
    'and the unsaved one is an outline — the state is the shape, not the opacity');
  // A class toggle alone would leave the previous state's mark on screen.
  const paint = CHAT_SRC.match(/_paintBookmark\(messageId, on\) \{([\s\S]*?)\n  \},/);
  assert.ok(paint, '_paintBookmark() found');
  assert.match(paint[1], /innerHTML = GroupChat\._bookmarkSvg\(!!on\)/,
    'an optimistic toggle redraws the mark, not just the classes');
});

test('the save button is available where react and edit are not', () => {
  const render = CHAT_SRC.match(/_renderBookmarkBtn\(msg\) \{([\s\S]*?)\n  \},/);
  assert.ok(render, '_renderBookmarkBtn() found');
  assert.doesNotMatch(render[1], /_readOnly/,
    '#621 read-only viewers may save what they can read — it writes nothing to the app');
  assert.match(render[1], /window\.App && App\.user/,
    'but there is no personal list to save into while signed out');
  assert.match(render[1], /aria-pressed=/, 'the toggle state is exposed, not just drawn');
});

test('the toggle is optimistic and reverts when the server refuses', () => {
  const toggle = CHAT_SRC.match(/async toggleBookmark\(messageId\) \{([\s\S]*?)\n  \},/);
  assert.ok(toggle, 'toggleBookmark() found');
  assert.match(toggle[1], /_paintBookmark\(messageId, next\)/, 'the button flips immediately');
  assert.match(toggle[1], /msg\.bookmarked = !next[\s\S]*_paintBookmark\(messageId, !next\)/,
    'a failed toggle puts both the state and the button back');
  assert.match(toggle[1], /Notifications\.refresh/,
    'the drawer only learns about a new save through a refresh');
});
