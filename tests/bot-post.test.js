'use strict';

// Homeroom bot, one model, step 4 (11 Nov 2026, docs/plans/bot-one-model.md):
// one posting function for every word the bot says to people
// (src/services/bot-post.js), append-only. Pinned here: the one rule table,
// the said-once keys, the failure rule as Evan amended decision 6, and that
// the old ways of saying once, of rewriting a note and of streaming an
// answer's words are gone (#6405, #6409, #6581).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const botPost = require('../src/services/bot-post');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

// ── The rules ────────────────────────────────────────────────────────────

test('a request\'s thread hears only its question or plan, built and up for a vote, a failure note, live, and answers', () => {
  for (const kind of ['question', 'person', 'empty', 'overlap']) assert.equal(botPost.familyOf('issue', kind), 'question', kind);
  for (const kind of ['plan', 'spec']) assert.equal(botPost.familyOf('issue', kind), 'plan', kind);
  assert.equal(botPost.familyOf('issue', 'proposal'), 'proposal');
  for (const kind of ['build_failed', 'followup_failed', 'followup_person', 'blocked']) {
    assert.equal(botPost.isFailure('issue', kind), true, kind);
  }
  assert.equal(botPost.familyOf('issue', 'live'), 'live');
  for (const kind of ['reply', 'going_ahead', 'held_by_person', 'followup_working']) assert.equal(botPost.familyOf('issue', kind), 'answer', kind);
  // Anything else is recorded, never a message there.
  for (const kind of ['looking', 'held_builds_per_app', 'followup_answer', 'checks_retry', 'milestone', '']) {
    assert.equal(botPost.allowed('issue', kind), false, kind || '(none)');
  }
  // A change's thread, a chat, a reply thread and a person's chat with the
  // bot hear what the bot says to them; a change's notes on its checks are
  // failure notes there.
  for (const place of ['session', 'chat', 'category', 'message', 'governance', 'dm']) {
    assert.equal(botPost.allowed(place, 'anything_at_all'), true, place);
  }
  assert.equal(botPost.isFailure('session', 'checks_retry'), true);
  assert.equal(botPost.isFailure('session', 'followup_wait'), false);
  assert.equal(botPost.allowed('nowhere', 'question'), false, 'an unknown place hears nothing');
  // Notes, not answers, count as said twice.
  assert.ok(botPost.noteKinds().includes('build_failed'));
  assert.ok(!botPost.noteKinds().includes('reply'));
});

test('the table is the one rule: THREAD_KINDS and its check are gone', () => {
  const live = read('src/services/homeroom-bot-live.js');
  assert.doesNotMatch(live, /THREAD_KINDS|saidInThread|FAILURE_KINDS/);
  assert.match(live, /const placeRefused = !botPost\.allowed\('issue', kind\);/);
  const bot = read('src/services/homeroom-bot.js');
  // A thread note goes through the posting function, whose rules decide.
  const note = bot.slice(bot.indexOf('async function postThreadNote('), bot.indexOf('// #4610: the plain cause of a reply turn'));
  assert.match(note, /require\('\.\/bot-post'\)\.post\(pool, \{/);
  assert.doesNotMatch(note, /\.sendBotMessage\(|INSERT INTO homeroom_bot_posts/, 'no bypass');
});

// ── Keys and words ───────────────────────────────────────────────────────

test('a post is keyed kind:subject:version', () => {
  assert.equal(botPost.keyOf({ kind: 'build_failed', subject: botPost.requestSubject(3, 12), version: 'run-40' }),
    'build_failed:request:3-12:run-40');
  assert.equal(botPost.keyOf({ kind: 'checks_retry', subject: botPost.changeSubject(6564), version: 'look-3' }),
    'checks_retry:change:6564:look-3');
  assert.equal(botPost.placeSubject(3, { type: 'issue', ref: 12 }), 'place:3:issue:12');
  assert.notEqual(botPost.freshVersion(), botPost.freshVersion(), 'a fresh version is never asked for twice');
});

test('a note\'s words leave out the people it tags, so a different tag is not new words', () => {
  assert.equal(botPost.wordsOf('@ada @sam  I couldn\'t   build it.'), 'I couldn\'t build it.');
  assert.equal(botPost.digestOf('@ada I couldn\'t build it.'), botPost.digestOf('@sam I couldn\'t build it.'));
  assert.notEqual(botPost.digestOf('I couldn\'t build it.'), botPost.digestOf('I couldn\'t plan it.'));
  assert.equal(botPost.digestOf('  '), null);
});

// ── The posting function, against a database that answers as one ───────

function db(rows = {}) {
  const queries = [];
  return {
    queries,
    async query(sql, params) {
      const s = String(sql);
      queries.push({ s, params });
      if (/INSERT INTO bot_posts/.test(s)) return { rows: [rows.claim || { id: 5, fresh: true, outcome: 'pending' }] };
      // A pending post's lapsed claim, taken over (or held by another pass).
      if (/SET claimed_at = NOW\(\), claimed_by = \$2/.test(s)) return { rows: rows.held ? [] : [rows.claim || {}] };
      if (/FROM bot_posts p\s+JOIN chat_messages m/.test(s)) return { rows: rows.last ? [rows.last] : [] };
      if (/SELECT 1 FROM chat_messages r/.test(s)) return { rows: rows.replied ? [{}] : [] };
      if (/INSERT INTO homeroom_bot_posts/.test(s)) return { rows: [{ id: 80 }] };
      return { rows: [] };
    },
  };
}
const wsSent = () => {
  const sent = [];
  return {
    sent,
    async sendBotMessage(_db, appId, msg) { sent.push({ appId, ...msg }); return { id: 300 + sent.length, createdAt: 'now' }; },
    async sendSystemMessage(_db, appId, content, msgType, metadata, thread) { sent.push({ appId, content, msgType, metadata, thread }); return { id: 900 }; },
  };
};
const BOT = { id: 2, username: 'homeroom_bot' };
const settled = (d) => d.queries.filter((q) => /SET outcome = \$2/.test(q.s)).map((q) => [q.params[1], q.params[2]]);

test('post: said once by its key, its message named on its record in the message\'s own transaction', async () => {
  const d = db();
  const ws = wsSent();
  const out = await botPost.post(d, {
    place: { type: 'session', ref: 51 }, appId: 3, kind: 'checks_retry', words: 'Running the checks again.', author: BOT,
    sessionId: 51, version: 'look-2',
  }, { ws });
  assert.deepEqual([out.outcome, out.messageId], ['said', 301]);
  assert.equal(d.queries[0].params[0], 'checks_retry:change:51:look-2');
  assert.equal(typeof ws.sent[0].onInsert, 'function', 'its record is written with the message');
  assert.deepEqual(settled(d), [['said', null]]);
  // Asked again: said before, nothing said.
  const again = db({ claim: { id: 5, fresh: false, outcome: 'said', chat_message_id: 301 } });
  const ws2 = wsSent();
  const twice = await botPost.post(again, {
    place: { type: 'session', ref: 51 }, appId: 3, kind: 'checks_retry', words: 'Running the checks again.', author: BOT,
    sessionId: 51, version: 'look-2',
  }, { ws: ws2 });
  assert.deepEqual([twice.outcome, twice.messageId, ws2.sent.length], ['again', 301, 0]);
  // Taken up after a restart whose message had gone out: said, not sent again.
  const taken = db({ claim: { id: 5, fresh: false, outcome: 'pending', chat_message_id: 301 } });
  const ws3 = wsSent();
  const up = await botPost.post(taken, {
    place: { type: 'issue', ref: 12 }, appId: 3, kind: 'question', words: 'Which one?', author: BOT, issueNumber: 12, version: 'run-9',
  }, { ws: ws3 });
  assert.deepEqual([up.outcome, ws3.sent.length], ['said', 0]);
  assert.deepEqual(settled(taken), [['said', null]]);
});

test('post: a kind the place does not hear is recorded as refused, and never a message', async () => {
  const d = db();
  const ws = wsSent();
  const out = await botPost.post(d, {
    place: { type: 'issue', ref: 12 }, appId: 3, kind: 'milestone', words: 'Halfway there.', author: BOT, issueNumber: 12,
  }, { ws });
  assert.deepEqual([out.outcome, out.why], ['refused', 'not_in_place']);
  assert.equal(ws.sent.length, 0);
  assert.deepEqual(settled(d), [['refused', 'not_in_place']]);
  assert.ok(d.queries.some((q) => /INSERT INTO homeroom_bot_posts/.test(q.s)), 'and on the request\'s record');
});

test('post: the same failure words with nobody writing since say nothing; new words or a reply since are a new note', async () => {
  const words = 'I couldn\'t finish building this.';
  const last = { id: 4, kind: 'build_failed', chat_message_id: 222, words_digest: botPost.digestOf(words) };
  const spec = { place: { type: 'issue', ref: 12 }, appId: 3, kind: 'build_failed', words, author: BOT, issueNumber: 12 };
  const repeat = db({ last });
  const ws = wsSent();
  const out = await botPost.post(repeat, spec, { ws });
  assert.deepEqual([out.outcome, out.messageId, ws.sent.length], ['repeat', 222, 0], 'the status card already shows it');
  assert.deepEqual(settled(repeat), [['repeat', 'same_words']]);
  // Somebody replied since: a new note, the older one's buttons retired.
  const replied = db({ last, replied: true });
  const ws2 = wsSent();
  assert.equal((await botPost.post(replied, spec, { ws: ws2 })).outcome, 'said');
  assert.equal(ws2.sent.length, 1);
  const retire = replied.queries.find((q) => /chat_message_id = ANY\(\$1::int\[\]\)/.test(q.s));
  assert.deepEqual(retire.params[0], [222], 'the older note\'s buttons are looked up to retire');
  // Different words: a new note.
  const other = db({ last: { ...last, words_digest: botPost.digestOf('I couldn\'t plan it.') } });
  const ws3 = wsSent();
  assert.equal((await botPost.post(other, spec, { ws: ws3 })).outcome, 'said');
  // The bot's last note there is not a failure: a new note too.
  const after = db({ last: { ...last, kind: 'proposal' } });
  const ws4 = wsSent();
  assert.equal((await botPost.post(after, spec, { ws: ws4 })).outcome, 'said');
});

test('post: a send that fails throws, its claim let go, so the caller\'s retry says it; a soft caller is told `failed`', async () => {
  const spec = { place: { type: 'issue', ref: 12 }, appId: 3, kind: 'reply', words: 'Here is the answer.', author: BOT, issueNumber: 12, version: 'turn-a' };
  const down = { async sendBotMessage() { throw new Error('room down'); } };
  const d = db();
  await assert.rejects(botPost.post(d, spec, { ws: down }), /room down/, 'the voice, a follow-up: their work is retried');
  const released = d.queries.filter((q) => /SET claimed_at = NULL/.test(q.s));
  assert.equal(released.length, 1, 'its claim let go, so the retry takes it up at once');
  assert.deepEqual(settled(d), [], 'left pending: never settled as said');
  const soft = db();
  const out = await botPost.post(soft, { ...spec, soft: true }, { ws: down });
  assert.deepEqual([out.outcome, out.error], ['failed', 'room down']);
  assert.equal(soft.queries.filter((q) => /SET claimed_at = NULL/.test(q.s)).length, 1);
});

test('post: a pending post another pass is saying is not said again here: thrown, or `busy` to a soft caller', async () => {
  const spec = { place: { type: 'issue', ref: 12 }, appId: 3, kind: 'question', words: 'Which one?', author: BOT, issueNumber: 12, version: 'run-9' };
  const claim = { id: 5, fresh: false, outcome: 'pending', chat_message_id: null };
  const ws = wsSent();
  await assert.rejects(botPost.post(db({ claim, held: true }), spec, { ws }), (err) => err.code === 'post_busy');
  const soft = await botPost.post(db({ claim, held: true }), { ...spec, soft: true }, { ws });
  assert.deepEqual([soft.outcome, soft.busy], ['busy', true]);
  assert.equal(ws.sent.length, 0, 'nothing sent');
  // Its claim lapsed (a crash): taken over, by one conditional UPDATE, and said.
  const lapsed = db({ claim });
  const up = await botPost.post(lapsed, spec, { ws });
  assert.equal(up.outcome, 'said');
  const take = lapsed.queries.find((q) => /SET claimed_at = NOW\(\), claimed_by = \$2/.test(q.s));
  assert.match(take.s, /outcome = 'pending'\s+AND \(claimed_at IS NULL OR claimed_at < NOW\(\) - make_interval\(secs => \$3\) OR \(\$4 AND claim_durable\)\)/);
  assert.deepEqual([take.params[0], take.params[2], take.params[3]], [5, botPost.CLAIM_LEASE_SECONDS, false],
    'only once its claim lapsed: no durable work of its own asks');
  assert.equal(take.params[1], lapsed.queries[0].params[11], 'under the token its ask claimed with');
});

test('post: a message written after its claim was lost rolls back, and the pass that took it over says it', async () => {
  const spec = { place: { type: 'issue', ref: 12 }, appId: 3, kind: 'question', words: 'Which one?', author: BOT, issueNumber: 12, version: 'run-9' };
  // The room runs the record in the message's transaction; the record
  // finds the claim another pass's now.
  const tx = { async query() { return { rowCount: 0, rows: [] }; } };
  const ws = { async sendBotMessage(_db, _app, msg) { await msg.onInsert(tx, { messageId: 41 }); return { id: 41 }; } };
  await assert.rejects(botPost.post(db(), spec, { ws }), (err) => err.code === 'post_claim_lost');
  const soft = await botPost.post(db(), { ...spec, soft: true }, { ws });
  assert.equal(soft.outcome, 'busy');
  // The record it writes names the message only for the claim's holder.
  const recorded = [];
  const ok = { async query(sql, params) { recorded.push({ sql, params }); return { rowCount: 1, rows: [] }; } };
  const ws2 = { async sendBotMessage(_db, _app, msg) { await msg.onInsert(ok, { messageId: 42 }); return { id: 42 }; } };
  const d = db();
  assert.equal((await botPost.post(d, spec, { ws: ws2 })).outcome, 'said');
  assert.match(recorded[0].sql, /chat_message_id IS NULL AND \(\$3::text IS NULL OR claimed_by = \$3::text\)/);
  assert.deepEqual(recorded[0].params, [5, 42, d.queries[0].params[11]]);
});

test('the failure rule reads the last note by its message, and a reply under any message since it', () => {
  const src = read('src/services/bot-post.js');
  const last = src.slice(src.indexOf('const LAST_NOTE_SQL'), src.indexOf('const REPLIED_SINCE_SQL'));
  assert.match(last, /ORDER BY p\.chat_message_id DESC LIMIT 1/);
  const replied = src.slice(src.indexOf('const REPLIED_SINCE_SQL'), src.indexOf('const PROJECT_SQL'));
  assert.match(replied, /r\.thread_type = 'message' AND r\.thread_ref IN \(/);
  assert.match(replied, /root\.thread_type = \$3 AND root\.thread_ref = \$4 AND root\.id >= \$2/);
  assert.match(replied, /u\.is_synthetic IS TRUE/, 'a bot\'s message is nobody replying');
});

test('post: a database that answers nothing, or fails, still says it (unrecorded), unless the caller is strict', async () => {
  const ws = wsSent();
  const silent = { async query() { return { rows: [] }; } };
  const out = await botPost.post(silent, {
    place: { type: 'message', ref: 7 }, appId: 3, kind: 'reply', words: 'Hello.', author: BOT,
  }, { ws });
  assert.equal(out.outcome, 'said');
  const broken = { async query() { throw new Error('db down'); } };
  assert.equal((await botPost.post(broken, { place: { type: 'message', ref: 7 }, appId: 3, kind: 'reply', words: 'Hi.', author: BOT }, { ws })).outcome, 'said');
  await assert.rejects(botPost.post(broken, { place: { type: 'message', ref: 7 }, appId: 3, kind: 'reply', words: 'Hi.', author: BOT, strict: true }, { ws }), /db down/);
});

// ── What is gone ─────────────────────────────────────────────────────────

// No bot rewrites words it showed. The only content writes left on
// chat_messages are a person editing their own message (ws.js, checked
// against its author) and a deletion blanking it (app-chat.js).
test('no bot UPDATE of chat_messages content remains', () => {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(__dirname, '..', dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (/\.(js|ts)$/.test(entry.name)) files.push(rel);
    }
  };
  walk('src');
  const writes = [];
  for (const rel of files) {
    const src = read(rel);
    for (const m of src.matchAll(/UPDATE chat_messages\b[\s\S]{0,400}?\bSET\b([\s\S]{0,400}?)(?:\bWHERE\b|\bFROM\b|`)/g)) {
      if (/\bcontent\s*=/.test(m[1])) writes.push(`${rel}: ${m[0].slice(0, 80).replace(/\s+/g, ' ')}`);
    }
  }
  assert.deepEqual(writes.map((w) => w.split(':')[0]).sort(), ['src/services/app-chat.js', 'src/services/ws.js'],
    `only a person's edit and a deletion write a message's content:\n${writes.join('\n')}`);
  assert.match(read('src/services/app-chat.js'), /SET deleted_at = NOW\(\), content = '',/);
  assert.match(read('src/services/ws.js'), /row\.user_id !== client\.user\.id/, 'an edit is its author\'s');
  // And nothing tells a room a bot message's words changed.
  for (const rel of files.filter((f) => /homeroom-bot|bot-post|bot-cards|design-|plan-updates|change-claims|thread-followups/.test(f))) {
    assert.doesNotMatch(read(rel), /type: 'chat_edit'/, rel);
  }
});

test('the six ways of saying once, and the failure rewrites, are gone', () => {
  const live = read('src/services/homeroom-bot-live.js');
  for (const gone of ['updateRepeatedBuildFailure', 'replaceFailurePost', 'FAILURE_TRIES_MARK', 'threadMessageOf', 'takeUpPending',
    'repliedUnderMessage', 'PLAN_ROW_ENDINGS', 'Tried ${tries} times', 'pending IS TRUE']) {
    assert.ok(!live.includes(gone), `homeroom-bot-live.js still has ${gone}`);
  }
  const bot = read('src/services/homeroom-bot.js');
  for (const gone of ['runPosted', 'postOnce', 'postThreadNoteNow', 'noteFollowUpWaitNow', "look.once(`note:", "look.once(`wait:",
    "look.once('handOffRepeat'"]) {
    assert.ok(!bot.includes(gone), `homeroom-bot.js still has ${gone}`);
  }
  // The voice's reply is found by its key. Its mark is read only when the
  // key names none, for a turn retried across the release (two days, one
  // release: TURN_MARK_SQL).
  const voice = read('src/services/homeroom-bot-voice.js');
  assert.match(voice, /FROM bot_posts p\s+JOIN chat_messages m ON m\.id = p\.chat_message_id/);
  const marks = voice.match(/metadata->'homeroomBot'->'turn'->>'key' = \$3/g) || [];
  assert.equal(marks.length, 1, 'one read of the mark');
  assert.match(voice, /const TURN_MARK_SQL = `[^`]*->>'key' = \$3\s+AND created_at > NOW\(\) - INTERVAL '2 days'/);
  assert.match(voice, /const m = keyed \|\| \(await pool\.query\(TURN_MARK_SQL, /);
  // A held answer is claimed in bot_posts, never a pending projection row.
  const machine = read('src/workflow/bot-voice/machine.ts');
  assert.doesNotMatch(machine, /INSERT INTO homeroom_bot_posts/);
  for (const rel of ['src/services/homeroom-bot-live.js', 'src/services/homeroom-bot.js', 'src/services/bot-post.js', 'src/workflow/bot-voice/machine.ts']) {
    assert.doesNotMatch(read(rel), /homeroom_bot_posts[^`]*pending[^`]*TRUE/, `${rel} writes no pending projection`);
  }
  // A plan's row keeps its words; only its status moves.
  const plan = live.slice(live.indexOf('async function notePlanRows'), live.indexOf('async function shareSpecVersion'));
  assert.doesNotMatch(plan, /content\s*=/);
});

test('#6405, #6409, #6581: no answer\'s words are shown before they are final, so none is re-streamed or wiped', () => {
  const dm = require('../src/services/homeroom-bot-dm');
  assert.deepEqual(dm.typingDoing({ kind: 'writing', text: 'half an answer', from: 4 }), { kind: 'writing' });
  assert.equal(dm.draftTail, undefined);
  assert.equal(dm.MAX_DRAFT_CHARS, undefined);
  const store = read('frontend/src/features/messages/store.ts');
  assert.doesNotMatch(store, /MAX_BOT_DRAFT_CHARS|MAX_BOT_HELD_DRAFT_CHARS|priorDraft|draft\?: string/);
  const card = read('frontend/src/features/messages/bot-working.tsx');
  assert.doesNotMatch(card, /botDraftText|data-bot-working-draft|MessageMarkdown/);
  // The voice and the design bot only ever name a step for the working card.
  for (const rel of ['src/services/homeroom-bot-voice.js', 'src/services/design-bot.js', 'src/services/design-threads.js']) {
    assert.doesNotMatch(read(rel), /kind: 'writing', text|doing\(\{[^}]*text:/, rel);
  }
});
