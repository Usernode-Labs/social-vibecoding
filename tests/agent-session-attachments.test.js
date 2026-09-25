'use strict';

// The agent-session composer, reworked (#2779 follow-up): files sent with a
// message, the credits pill and the ring round Send, and the pending bubble
// that must give way to the saved row.
//
//   1. A FILE IS THE DEV CHAT'S FILE. Uploads go to chat_session_attachments
//      with agent_session_id set, through the dev chat's validator and caps;
//      only the owner reads them back, and a turn names only its own unsent
//      uploads.
//   2. THE MAYOR AND THE CODING AGENT SEE THEM. The message row lists them,
//      the history reads them back, and a build is handed the latest
//      message's files.
//   3. THE LIMIT IS ONE COLOUR RULE. Green above 40% left, yellow down to 15%,
//      red below, in a gray pill whatever the tone, and a ring that empties
//      clockwise from twelve o'clock.
//   4. ONE BUBBLE PER MESSAGE. The pending text goes the moment a newer user
//      row lands, whichever refresh brings it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { loadTsx, createElement, renderToHtml } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
const ATT_A = 'a'.repeat(32);
const ATT_B = 'b'.repeat(32);

// ── 1. The routes ──────────────────────────────────────────────────────

const poolMod = require('../src/db/pool');
const agentTurn = require('../src/services/mayor/agent-turn');

function recordingPool(handlers = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      for (const [pattern, fn] of Object.entries(handlers)) {
        if (new RegExp(pattern).test(sql)) return fn(sql, params);
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

async function withRoutes(user, handlers, fn) {
  const pool = recordingPool(handlers);
  const previous = poolMod.getPool;
  poolMod.getPool = () => pool;
  delete require.cache[require.resolve('../src/routes/agent-sessions')];
  const { agentSessionRoutes } = require('../src/routes/agent-sessions');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = user; next(); });
  app.use(agentSessionRoutes({}));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, target, body, { raw = false } = {}) => {
    const res = await fetch(`${base}${target}`, {
      method,
      headers: { 'content-type': raw ? 'application/octet-stream' : 'application/json' },
      body: body === undefined ? undefined : (raw ? body : JSON.stringify(body)),
    });
    const buffer = Buffer.from(await res.arrayBuffer());
    let json = null;
    try { json = JSON.parse(buffer.toString('utf8')); } catch { /* bytes */ }
    return { status: res.status, headers: res.headers, body: json, bytes: buffer };
  };
  try {
    await fn(call, pool);
  } finally {
    server.close();
    poolMod.getPool = previous;
    delete require.cache[require.resolve('../src/routes/agent-sessions')];
  }
}

const OPEN_SESSION = {
  id: 5, user_id: 7, title: 'Blue header', title_source: 'auto', status: 'open', focus_app_id: 3,
  focus_context: {}, active_change_id: null, active_turn: null,
  last_activity_at: new Date('2026-09-23T12:00:00Z'), created_at: new Date('2026-09-23T12:00:00Z'),
  archived_at: null, focus_app_slug: 'recipe-box', focus_app_name: 'Recipe box',
};

test('an upload lands on the conversation, through the dev chat\'s validator and cap', async () => {
  await withRoutes({ id: 7 }, {}, async (call) => {
    const foreign = await call('POST', '/api/agent-sessions/5/attachments?filename=shot.png', PNG, { raw: true });
    assert.equal(foreign.status, 404, 'not this user\'s open conversation');
  });
  let stored = 0;
  const handlers = {
    'SELECT id FROM agent_sessions WHERE id = \\$1 AND user_id = \\$2 AND status = \'open\'': () => ({ rows: [{ id: 5 }] }),
    'COALESCE\\(SUM\\(size_bytes\\), 0\\)': () => ({ rows: [{ total: String(stored) }] }),
  };
  await withRoutes({ id: 7 }, handlers, async (call, pool) => {
    const ok = await call('POST', '/api/agent-sessions/5/attachments?filename=shot.png', PNG, { raw: true });
    assert.equal(ok.status, 200);
    assert.match(ok.body.id, /^[a-f0-9]{32}$/);
    assert.deepEqual({ ...ok.body, id: 'x' }, { id: 'x', kind: 'image', filename: 'shot.png', contentType: 'image/png', sizeBytes: PNG.length, meta: null });
    const insert = pool.calls.find((c) => /INSERT INTO chat_session_attachments/.test(c.sql));
    assert.match(insert.sql, /VALUES \(\$1, NULL, \$2, \$3/, 'no change: the row names the conversation');
    assert.deepEqual(insert.params.slice(1, 5), [5, 7, 'image', 'shot.png']);
    const sum = pool.calls.find((c) => /SUM\(size_bytes\)/.test(c.sql));
    assert.match(sum.sql, /WHERE agent_session_id = \$1/, 'the 50 MB is per conversation');

    const liar = await call('POST', '/api/agent-sessions/5/attachments?filename=shot.png', Buffer.from('not a png'), { raw: true });
    assert.equal(liar.status, 400, 'the bytes decide, not the name');
    const nameless = await call('POST', '/api/agent-sessions/5/attachments', PNG, { raw: true });
    assert.equal(nameless.status, 400);

    stored = 50 * 1024 * 1024;
    const full = await call('POST', '/api/agent-sessions/5/attachments?filename=shot.png', PNG, { raw: true });
    assert.equal(full.status, 400);
    assert.match(full.body.error, /attachment storage is full \(50 MB max\)/);
  });
});

test('a file is served to its owner only: images inline, the rest as downloads, never sniffed', async () => {
  const rowsFor = { [ATT_A]: { kind: 'image', filename: 'shot.png', content_type: 'image/png', data: PNG },
    [ATT_B]: { kind: 'text', filename: 'notes.txt', content_type: 'text/plain; charset=utf-8', data: Buffer.from('hi') } };
  await withRoutes({ id: 7 }, {
    'FROM chat_session_attachments att': (_sql, params) => ({ rows: rowsFor[params[0]] ? [rowsFor[params[0]]] : [] }),
  }, async (call, pool) => {
    const image = await call('GET', `/api/agent-sessions/5/attachments/${ATT_A}`);
    assert.equal(image.status, 200);
    assert.ok(image.bytes.equals(PNG));
    assert.equal(image.headers.get('content-type'), 'image/png');
    assert.equal(image.headers.get('x-content-type-options'), 'nosniff');
    assert.match(image.headers.get('content-disposition'), /^inline; filename="shot\.png"/);
    const text = await call('GET', `/api/agent-sessions/5/attachments/${ATT_B}`);
    assert.match(text.headers.get('content-disposition'), /^attachment; filename="notes\.txt"/);
    const query = pool.calls.find((c) => /FROM chat_session_attachments att/.test(c.sql));
    assert.match(query.sql, /JOIN agent_sessions s ON s\.id = att\.agent_session_id/);
    assert.match(query.sql, /att\.agent_session_id = \$2 AND s\.user_id = \$3/, 'the owner check is in the query');
    assert.deepEqual(query.params, [ATT_A, 5, 7]);
    assert.equal((await call('GET', `/api/agent-sessions/5/attachments/${'c'.repeat(32)}`)).status, 404);
    assert.equal((await call('GET', '/api/agent-sessions/5/attachments/../../x')).status, 404);
    assert.equal((await call('GET', '/api/agent-sessions/5/attachments/NOTHEX')).status, 404);
  });
});

test('a turn names only its own unsent uploads, and files alone are a message', async () => {
  const saved = { runAgentTurn: agentTurn.runAgentTurn, resolveAgentMayor: agentTurn.resolveAgentMayor };
  const runs = [];
  agentTurn.resolveAgentMayor = async () => ({ ok: true, apiKey: 'k' });
  agentTurn.runAgentTurn = async (args) => { runs.push(args); args.res.end(); };
  const unsent = new Map([
    [ATT_A, { id: ATT_A, kind: 'image', filename: 'shot.png', content_type: 'image/png', size_bytes: PNG.length, meta: null }],
    [ATT_B, { id: ATT_B, kind: 'zip', filename: 'site.zip', content_type: 'application/zip', size_bytes: 900, meta: { entryCount: 2 } }],
  ]);
  try {
    await withRoutes({ id: 7 }, {
      'FROM agent_sessions s': () => ({ rows: [OPEN_SESSION] }),
      'FROM chat_session_attachments\\s+WHERE id = ANY': (_sql, params) => ({ rows: params[0].map((id) => unsent.get(id)).filter(Boolean) }),
      'UPDATE agent_sessions\\s+SET active_turn': () => ({ rows: [{ id: 5 }] }),
    }, async (call, pool) => {
      const filesOnly = await call('POST', '/api/agent-sessions/5/turns', { attachmentIds: [ATT_B, ATT_A] });
      assert.equal(filesOnly.status, 200);
      assert.equal(runs.length, 1);
      assert.equal(runs[0].messageText, '(attached files)', 'the dev chat\'s stand-in, which the transcript hides');
      assert.deepEqual(runs[0].attachments.map((a) => [a.id, a.kind, a.filename, a.contentType, a.sizeBytes, a.meta || null]), [
        [ATT_B, 'zip', 'site.zip', 'application/zip', 900, { entryCount: 2 }],
        [ATT_A, 'image', 'shot.png', 'image/png', PNG.length, null],
      ], 'in the order they were attached');
      const check = pool.calls.find((c) => /FROM chat_session_attachments\s+WHERE id = ANY/.test(c.sql));
      assert.match(check.sql, /agent_session_id = \$2 AND user_id = \$3 AND message_id IS NULL/);
      assert.deepEqual(check.params.slice(1), [5, 7]);

      unsent.delete(ATT_A);
      const leases = pool.calls.filter((c) => /SET active_turn/.test(c.sql)).length;
      const gone = await call('POST', '/api/agent-sessions/5/turns', { message: 'and this', attachmentIds: [ATT_A] });
      assert.equal(gone.status, 400, 'already sent, someone else\'s, or swept');
      assert.match(gone.body.error, /Attach them again/);
      assert.equal(pool.calls.filter((c) => /SET active_turn/.test(c.sql)).length, leases, 'refused before the lease: nothing recorded');

      for (const attachmentIds of ['x', ['nope'], [ATT_A, ATT_A, ATT_A, ATT_A, ATT_B]]) {
        assert.equal((await call('POST', '/api/agent-sessions/5/turns', { message: 'hi', attachmentIds })).status, 400, JSON.stringify(attachmentIds));
      }
      assert.equal((await call('POST', '/api/agent-sessions/5/turns', { attachmentIds: [] })).status, 400, 'nothing at all is still nothing');
      assert.equal(runs.length, 1);
    });
  } finally {
    Object.assign(agentTurn, saved);
  }
});

// ── 2. The Mayor and the coding agent see them ─────────────────────────

test('the message row lists its files and claims them; the history and a build read them back', () => {
  const src = read('src/services/mayor/agent-turn.js');
  assert.match(src, /JSON\.stringify\(\{ agentTurnId: turnId, \.\.\.\(attachments\.length \? \{ attachments \} : \{\}\) \}\)/);
  assert.match(src, /UPDATE chat_session_attachments SET message_id = \$1\s+WHERE id = ANY\(\$2\) AND agent_session_id = \$3 AND message_id IS NULL/,
    'linked, so the orphan sweep leaves them alone');
  assert.match(src, /d\.attachments\.loadForHistory\(pool, history\)/);
  assert.match(src, /historyToMessages\(history, d\.buildMayorMessages, historyAttachments\)/);

  const built = [];
  const buildMayorMessages = (rows, map) => { built.push(map); return rows.map((r) => ({ role: r.role, content: r.content })); };
  const map = new Map([[11, [{ id: ATT_A }]]]);
  agentTurn.historyToMessages([{ id: 11, role: 'user', content: 'hi', metadata: {} }], buildMayorMessages, map);
  assert.equal(built[0], map, 'the files reach the dev chat\'s message builder');

  const { dispatchAttachmentIds, withTrailingUserText } = agentTurn;
  const rows = [
    { role: 'user', metadata: { attachments: [{ id: ATT_A }] } },
    { role: 'assistant', metadata: {} },
    { role: 'user', metadata: { attachments: [{ id: ATT_B }, { id: 3 }] } },
    { role: 'assistant', metadata: {} },
  ];
  assert.deepEqual(dispatchAttachmentIds(rows, [{ id: ATT_A }]), [ATT_A], 'this turn\'s own files first');
  assert.deepEqual(dispatchAttachmentIds(rows, []), [ATT_B], 'a follow-up turn: the latest message\'s');
  assert.deepEqual(dispatchAttachmentIds([...rows, { role: 'user', metadata: {} }], []), [], 'and none when it had none');

  const withFiles = [{ role: 'user', content: [{ type: 'image' }, { type: 'text', text: 'fix it' }] }];
  assert.deepEqual(withTrailingUserText(withFiles, 'note'),
    [{ role: 'user', content: [{ type: 'image' }, { type: 'text', text: 'fix it' }, { type: 'text', text: 'note' }] }],
    'a note joins a message with files as one more block, never a second user message');
  assert.deepEqual(withTrailingUserText([{ role: 'user', content: 'a' }], 'b'), [{ role: 'user', content: 'a\n\nb' }]);

  const dispatch = read('src/services/mayor/agent-dispatch.js');
  assert.match(dispatch, /attachmentsBlock = d\.attachments\.buildDispatchBlock\(await d\.attachments\.loadByIds\(pool, attachmentIds\)\)/);
  assert.match(src, /attachmentIds: dispatchAttachmentIds\(rows, messageText \? attachments : \[\]\)/);
});

test('the coding agent downloads a conversation\'s files through the change it builds', () => {
  const internal = read('src/routes/internal.js');
  const through = /agent_session_id = \(SELECT agent_session_id FROM chat_sessions WHERE id = \$\d\)/g;
  assert.equal((internal.match(through) || []).length, 2, 'the listing and the download');
  assert.match(internal, /WHERE message_id IS NOT NULL\s+AND \(session_id = \$1\s+OR agent_session_id/, 'sent files only');

  const schema = read('src/db/schema.sql');
  assert.match(schema, /ADD COLUMN IF NOT EXISTS agent_session_id INTEGER REFERENCES agent_sessions\(id\) ON DELETE CASCADE/);
  assert.match(schema, /ALTER TABLE chat_session_attachments ALTER COLUMN session_id DROP NOT NULL/);
  assert.match(schema, /CHECK \(session_id IS NOT NULL OR agent_session_id IS NOT NULL\)/, 'every row names one or the other');
  assert.ok(schema.indexOf('ADD COLUMN IF NOT EXISTS agent_session_id INTEGER REFERENCES agent_sessions(id)')
    > schema.indexOf('CREATE TABLE IF NOT EXISTS agent_sessions ('), 'after the table it references');
});

// ── 3. The limit ───────────────────────────────────────────────────────

const parts = loadTsx('frontend/src/features/agent-session/composer-parts.tsx');

test('the limit is green above 40% left, yellow down to 15%, red below; nothing without an allowance', () => {
  const figures = (remainingCents, extra = {}) => ({ limitCents: 5000, remainingCents, spentCents: 5000 - remainingCents, byokCents: 0, weekly: true, level: 'ok', ...extra });
  assert.equal(parts.creditView(figures(2001)).tone, 'green');
  assert.equal(parts.creditView(figures(2000)).tone, 'yellow', '40% exactly is yellow');
  assert.equal(parts.creditView(figures(751)).tone, 'yellow');
  assert.equal(parts.creditView(figures(750)).tone, 'red', '15% exactly is red');
  assert.equal(parts.creditView(figures(4934)).label, '$49 left', 'whole dollars from $10');
  assert.equal(parts.creditView(figures(410)).label, '$4.10 left', 'cents below $10');
  assert.equal(parts.creditView(figures(0)).label, 'None left');
  assert.equal(parts.creditView(figures(-30)).fraction, 0, 'overspent reads empty, not negative');
  assert.equal(parts.creditView(figures(4934)).description, '$49.34 of this week’s $50.00 left');
  assert.equal(parts.creditView(figures(100, { weekly: false })).description, '$1.00 of today’s $50.00 left');
  assert.equal(parts.creditView(null), null);
  assert.equal(parts.creditView(figures(100, { limitCents: 0 })), null);
  assert.equal(parts.creditView(figures(100, { level: 'locked' })), null);
  assert.equal(parts.creditView(figures(100, { level: 'unavailable' })), null);
});

test('the pill is gray in every state and only its ink changes; the ring empties clockwise from the top', () => {
  const view = (remainingCents) => parts.creditView({ limitCents: 5000, remainingCents, spentCents: 0, byokCents: 0, weekly: true, level: 'ok' });
  const pill = (credit) => renderToHtml(createElement(parts.CreditPill, { credit, onOpen() {} }));
  const inks = { green: 'text-zinc-900 dark:text-white', yellow: 'text-amber-700 dark:text-amber-400', red: 'text-red-600 dark:text-red-400' };
  for (const [cents, tone] of [[4000, 'green'], [1500, 'yellow'], [300, 'red']]) {
    const html = pill(view(cents));
    assert.match(html, /bg-zinc-100 [^"]*dark:bg-zinc-700/, `${tone}: the same gray pill`);
    assert.ok(html.includes(inks[tone]), `${tone}: its own ink`);
    assert.match(html, new RegExp(`data-agent-session-credits="${tone}"`));
  }
  assert.match(pill(view(4934)), /aria-label="Credits: \$49\.34 of this week’s \$50\.00 left"[^>]*>\$49 left</);

  const ring = (credit) => renderToHtml(createElement(parts.CreditRing, { credit }, createElement('button', null, 'Send')));
  const half = ring(view(2500));
  assert.match(half, /<svg class="pointer-events-none -scale-x-100 absolute inset-0"/, 'mirrored: it empties clockwise');
  assert.match(half, /transform="rotate\(-90 24 24\)"/, 'from twelve o\'clock');
  const circumference = 2 * Math.PI * 22;
  assert.equal(circumference.toFixed(2), '138.23', 'the primitive\'s written-out circumference agrees with its radius');
  assert.ok(half.includes(`stroke-dasharray="${(circumference / 2).toFixed(1)} 138.23"`), 'the arc is what is left');
  assert.match(half, /class="stroke-emerald-500 dark:stroke-emerald-400"/, 'in the tone\'s colour');
  assert.match(read('frontend/src/features/agent-session/composer-parts.tsx'), /import \{ ProgressHalo \} from '@\/components\/ui\/progress-ring';/,
    'drawn by the shell primitive: a raw <svg> in a feature file is refused (tests/shell-icon-set.test.js)');
  assert.match(half, /<button>Send<\/button><\/span>$/, 'Send sits inside it');
  assert.doesNotMatch(ring(view(0)), /stroke-dasharray/, 'nothing left: the track alone');
  assert.equal(ring(null), '<button>Send</button>', 'no allowance: a bare Send');
});

test('the sheet spells out the credits the pill abbreviates', () => {
  const credit = parts.creditView({ limitCents: 5000, remainingCents: 1200, spentCents: 3800, byokCents: 60, weekly: true, level: 'ok' });
  const html = renderToHtml(createElement(parts.ModelSheetBody, { groups: [], value: '', onPick() {}, onClose() {}, effort: null, credit }));
  assert.match(html, /data-agent-session-sheet-credits/);
  assert.match(html, />This week’s credits</);
  assert.match(html, /role="meter" aria-label="Credits left" aria-valuemin="0" aria-valuemax="50" aria-valuenow="12"/);
  assert.match(html, /style="width:24%"/);
  assert.match(html, />\$12\.00 of this week’s \$50\.00 left</);
  assert.match(html, />Your key: \$0\.60 today</);
});

// ── 4. Files in the composer and the transcript ────────────────────────

test('the tray takes four files at most, refuses the oversized, and names a pasted screenshot', () => {
  const att = loadTsx('frontend/src/features/agent-session/attachments.ts');
  const f = (name, size = 10) => ({ name, size });
  const five = att.acceptFiles(0, [f('a.png'), f('b.txt'), f('c.zip'), f('d.pdf'), f('e.png')]);
  assert.deepEqual(five.accepted.map((x) => x.name), ['a.png', 'b.txt', 'c.zip', 'd.pdf']);
  assert.equal(five.error, 'You can attach up to 4 files to one message.');
  assert.equal(att.acceptFiles(3, [f('a.png'), f('b.png')]).accepted.length, 1, 'counting what is already there');
  const big = att.acceptFiles(0, [f('huge.png', 5 * 1024 * 1024), f('ok.png')]);
  assert.deepEqual(big.accepted.map((x) => x.name), ['ok.png'], 'one refusal does not drop the rest');
  assert.equal(big.error, '"huge.png" is too big. Images max 4 MB.');
  assert.equal(att.refusal('site.zip', 21 * 1024 * 1024), '"site.zip" is too big. Zip archives max 20 MB.');
  assert.equal(att.refusal('dump.bin', 11 * 1024 * 1024), '"dump.bin" is too big. Files max 10 MB.');
  assert.equal(att.refusal('empty.txt', 0), '"empty.txt" is empty.');
  assert.equal(att.badgeFor('image', 'a.png'), null);
  assert.equal(att.badgeFor('zip', 'a.zip'), 'ZIP');
  assert.equal(att.badgeFor('file', 'notes.markdown'), 'MARK');
  assert.equal(att.badgeFor('file', 'Makefile'), 'FILE');
  const now = new Date('2026-09-24T17:10:05Z');
  assert.equal(att.pastedName({ name: 'image.png', type: 'image/png' }, 0, now), 'pasted-2026-09-24-17-10-05.png');
  assert.equal(att.pastedName({ name: '', type: 'image/jpeg' }, 1, now), 'pasted-2026-09-24-17-10-05-2.jpeg');
  assert.equal(att.pastedName({ name: 'mock.png', type: 'image/png' }, 0, now), 'mock.png');
  assert.equal(att.formatSize(900), '900 B');
  assert.equal(att.formatSize(2048), '2 KB');
  assert.equal(att.formatSize(3 * 1024 * 1024), '3.0 MB');
});

test('a sent message shows its files, and the files-only stand-in is never shown as words', () => {
  const transcript = loadTsx('frontend/src/features/agent-session/transcript.ts');
  const listed = [{ id: ATT_A, filename: 'shot.png', kind: 'image', sizeBytes: 70 }, { id: 'bad', filename: 'x' }, null];
  assert.deepEqual(transcript.userMessage('(attached files)', listed), { text: '', attachments: [listed[0]] });
  assert.equal(transcript.userMessage('(attached files)', []).text, '(attached files)', 'without files it is what they typed');
  assert.equal(transcript.userMessage('look at this', listed).text, 'look at this');

  const html = renderToHtml(createElement(parts.SentAttachments, {
    sessionId: 5,
    attachments: [
      { id: ATT_A, filename: 'shot.png', kind: 'image', sizeBytes: 70 },
      { id: ATT_B, filename: 'notes.txt', kind: 'text', sizeBytes: 2048 },
    ],
  }));
  assert.match(html, /data-agent-session-attachments="2"/);
  assert.match(html, new RegExp(`<a href="/api/agent-sessions/5/attachments/${ATT_A}" target="_blank" rel="noopener noreferrer"[^>]*><img src="/api/agent-sessions/5/attachments/${ATT_A}" alt="shot.png"`));
  assert.match(html, new RegExp(`<a href="/api/agent-sessions/5/attachments/${ATT_B}" download="notes.txt"`));
  assert.match(html, />2 KB</);
  assert.equal(renderToHtml(createElement(parts.SentAttachments, { sessionId: null, attachments: [] })), '');
});

// ── 5. One bubble per message ──────────────────────────────────────────

test('the pending bubble goes when a newer user row lands, from any refresh', () => {
  globalThis.window = { location: { hash: '' }, App: {}, UsernodeReact: {}, PlatformUI: { toast() {} } };
  try {
    const store = loadTsx('frontend/src/features/agent-session/store.ts');
    const turn = { pendingUserText: 'Build the spec', pendingAfterId: 40 };
    const row = (id, role) => ({ id, role, content: '', metadata: {} });
    assert.equal(store.settlePending(turn, [row(40, 'user'), row(41, 'assistant')]), turn, 'only older rows: it stays');
    assert.deepEqual(store.settlePending(turn, [row(40, 'user'), row(42, 'user')]), { pendingUserText: null, pendingAfterId: null });
    const fresh = { pendingUserText: 'first', pendingAfterId: null };
    assert.equal(store.settlePending(fresh, [row(1, 'user')]).pendingUserText, null, 'a new conversation: any user row');
    const none = { pendingUserText: null, pendingAfterId: null };
    assert.equal(store.settlePending(none, [row(9, 'user')]), none);

    const src = read('frontend/src/features/agent-session/store.ts');
    assert.match(src, /publish\(\(current\) => \(\{ messages: all, turn: settlePending\(current\.turn, all\) \}\)\)/,
      'every messages refresh settles it, not only the turn\'s own end');

    // A coding agent's bare phase marker reads as words, never as "[phase]".
    assert.equal(store.progressLine('Reading the header'), 'Reading the header');
    assert.equal(store.progressLine('[codex]'), 'The coding agent is working');
    globalThis.window.ccPhaseLabel = (phase) => (phase === 'tests' ? 'Running the tests' : phase);
    assert.equal(store.progressLine('[tests]'), 'Running the tests');
    assert.equal(store.progressLine('[mystery]'), 'The coding agent is working', 'a label that is only the marker is no label');
  } finally {
    delete globalThis.window;
  }
});

test('the message box re-fits its hint when it gets its width, not only when its text changes', () => {
  // Mounted while its screen is hidden, the box measured 0 and kept one line,
  // clipping the hint's second line on a phone until something was typed.
  const panel = read('frontend/src/features/agent-session/index.tsx');
  assert.match(panel, /useEffect\(\(\) => \{ fitField\(\); \}, \[value, placeholder, fitField\]\);/);
  assert.match(panel, /new ResizeObserver\(\(\) => \{\s*if \(field\.clientWidth === width\) return;\s*width = field\.clientWidth;\s*fitField\(\);/,
    'on a width change only, so the height it sets cannot loop');
  assert.match(panel, /return \(\) => observer\.disconnect\(\);/);
});

test('the attach button draws a paperclip and says it attaches files (#3080)', () => {
  // It only ever opened the file picker, so a "+" promised more than it did.
  const panel = read('frontend/src/features/agent-session/index.tsx');
  const button = panel.match(/<button[^>]*?data-agent-session-attach[\s\S]*?<\/button>/);
  assert.ok(button, 'the attach button is still marked data-agent-session-attach');
  assert.match(button[0], /aria-label="Attach photos or files"/);
  assert.match(button[0], /title="Attach photos or files"/);
  assert.match(button[0], /<PaperclipIcon className="h-5 w-5" aria-hidden="true" \/>/);
  assert.doesNotMatch(button[0], /PlusIcon/);
});
