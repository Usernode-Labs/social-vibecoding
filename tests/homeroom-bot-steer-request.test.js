'use strict';

// #6684: a comment on a request while Homeroom bot builds it reaches the
// build, is queued in the change's next update, or is offered as its own
// request. The request's own discussion works as the private chat does, with
// no tap needed for the change's next update (the words are already public
// on the request). These pin the tools, the note's origin, the reply's card,
// the forwarding, and that a stranger changes nothing. The lifecycle against
// the schema is tests/bot-parity-p5-steer-postgres.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');

const steer = require('../src/services/homeroom-bot-steer');
const tool = require('../src/services/homeroom-bot-thread-tools/steer');
const voice = require('../src/services/homeroom-bot-voice');

const names = (tools) => tools.map((t) => t.function.name);

test('#6684: on a request the bot is building, a requester gets the three steering tools and not ask_changed', () => {
  const steerable = names(voice.toolsFor({ type: 'issue', ref: 12 }, { steerable: true }));
  assert.ok(steerable.includes('add_to_build'));
  assert.ok(steerable.includes('stop_and_redo'));
  assert.ok(steerable.includes('offer_follow_up_request'));
  assert.ok(!steerable.includes('ask_changed'), 'the comment goes to the build, not a re-read');
  // A stranger, or nobody building it, is as before.
  const ordinary = names(voice.toolsFor({ type: 'issue', ref: 12 }, {}));
  assert.ok(ordinary.includes('ask_changed'));
  assert.ok(!ordinary.includes('add_to_build'));
  // The private chat's own tools are unchanged.
  assert.deepEqual(names(tool.tools({ user: { id: 3 }, deps: {} })), ['add_to_build', 'stop_and_redo']);
});

// A request's build under way, its note, and its card's title, without a
// database. The note itself is the service's own (noteFromRequest), not the
// thread tool's: the request's discussion is a public surface and loads no
// thread-tool module but pictures (tests/homeroom-bot-prod-debug.test.js).
function requestPool({ lastSteps = false } = {}) {
  const writes = [];
  return {
    writes,
    async query(sql, params = []) {
      writes.push({ sql, params });
      if (/FROM homeroom_bot_build_notes WHERE app_id/.test(sql)) return { rows: [] };
      if (/INSERT INTO homeroom_bot_build_notes/.test(sql)) return { rows: [{ id: 55 }] };
      if (/SELECT COALESCE/.test(sql)) return { rows: [{ title: 'Dark mode' }] };
      if (/LEFT JOIN chat_sessions bs/.test(sql)) {
        return lastSteps ? { rows: [] } : { rows: [{ run_id: 70, session_id: 900, session_status: 'active' }] };
      }
      if (/bs\.status <> 'active'/.test(sql)) {
        return lastSteps ? { rows: [{ run_id: 70, session_id: 900 }] } : { rows: [] };
      }
      return { rows: [] };
    },
  };
}

const STEER_DEPS = { dm: { requesterOf: async () => ({ userId: 1 }) }, batches: { managesApp: async () => false } };
const GYM = { id: 2, slug: 'gym', name: 'Gym Tracker' };

test('#6684: a comment is a note with origin request, and its card is returned for the reply', async () => {
  const pool = requestPool();
  const out = await steer.noteFromRequest(pool, {
    app: GYM, n: 12, user: { id: 1 }, note: 'Also send the digest through the inbox.', commentId: 501, deps: STEER_DEPS,
  });
  assert.equal(out.ok, true);
  assert.equal(out.card.state, 'waiting');
  assert.equal(out.card.noteId, 55);
  assert.equal(out.card.project, 'gym');
  const insert = pool.writes.find((w) => /INSERT INTO homeroom_bot_build_notes/.test(w.sql));
  assert.equal(insert.params[2], 70, 'the note waits on the build under way');
  assert.equal(insert.params[9], 'request');
  assert.equal(insert.params[10], 501);
});

test('#6684: stop_and_redo on a request is an offer only, with origin request', async () => {
  const pool = requestPool();
  const out = await steer.redoFromRequest(pool, {
    app: GYM, n: 12, user: { id: 1 }, note: 'Do not touch the email settings page.', commentId: 502, deps: STEER_DEPS,
  });
  assert.equal(out.ok, true);
  assert.equal(out.card.state, 'offer_redo');
  const insert = pool.writes.find((w) => /INSERT INTO homeroom_bot_build_notes/.test(w.sql));
  assert.deepEqual(insert.params.slice(7), ['redo', 'offered', 'request', 502], 'nothing stops until the tap');
});

test('#6684: a comment from somebody who is neither the requester nor the owner changes nothing', async () => {
  const pool = requestPool();
  const deps = { dm: { requesterOf: async () => ({ userId: 1 }) }, batches: { managesApp: async () => false } };
  for (const fn of ['noteFromRequest', 'redoFromRequest']) {
    const out = await steer[fn](pool, { app: GYM, n: 12, user: { id: 9 }, note: 'Also the digest.', deps });
    assert.equal(out.ok, false);
    assert.match(out.error, /Only whoever asked for Gym Tracker request #12, or the project's owner/);
  }
  assert.ok(!pool.writes.some((w) => /INSERT INTO homeroom_bot_build_notes/.test(w.sql)), 'no note is made');
});

test('#6684: a comment on a build in its last steps is queued for the next update, not sent into it', async () => {
  const pool = requestPool({ lastSteps: true });
  const out = await steer.noteFromRequest(pool, {
    app: GYM, n: 12, user: { id: 1 }, note: 'Also the digest.', commentId: 503, deps: STEER_DEPS,
  });
  assert.equal(out.ok, true);
  assert.match(out.sent, /already stopped coding, so their note goes into the change's next update by itself/);
  // There is nothing to stop: a redo is refused with the note's own route.
  const redo = await steer.redoFromRequest(pool, { app: GYM, n: 12, user: { id: 1 }, note: 'Start again.', deps: STEER_DEPS });
  assert.equal(redo.ok, false);
  assert.match(redo.error, /already stopped coding, so there is nothing to stop/);
});

test('#6684: the voice sends a comment to the build and puts its card on the reply', async () => {
  const asked = [];
  const ctx = {
    app: GYM, place: { type: 'issue', ref: 12 }, user: { id: 1 }, triggerMessage: { id: 501 },
    deps: {
      steer: {
        async noteFromRequest(_pool, args) {
          asked.push(args);
          return { ok: true, sent: 'Sent.', shown: 'Never say it has.', card: { type: 'build_note', state: 'waiting', noteId: 9, number: 12 } };
        },
      },
    },
  };
  const out = await voice.runTool({}, ctx, 'add_to_build', { note: 'Add the digest too.' });
  assert.equal(out.ok, true);
  assert.equal(asked[0].n, 12);
  assert.equal(asked[0].commentId, 501);
  assert.equal(asked[0].note, 'Add the digest too.');
  assert.deepEqual(ctx.buildNote, out.card);
  assert.equal(ctx.steered, true, 'one note per turn');
});

test('#6684: a steerer whose build started after the tools were chosen sends the comment into it; a stranger is told who can', async () => {
  const added = [];
  const ctxOf = (ok) => ({
    app: { id: 3, slug: 'todo', name: 'Todo' }, place: { type: 'issue', ref: 12 }, user: { id: 9, username: 'ada' },
    bot: { id: 77 }, settings: { mode: 'live' }, triggerMessage: { id: 501, content: 'the footer should be blue' },
    deps: {
      liveSvc: { isLiveFor: () => true, async openBotProposal() { return null; } },
      mayor: { async pendingBuild() { return true; } },
      steer: {
        async maySteer() { return { ok }; },
        async buildForRequest() { return { runId: 70, sessionId: 900, running: true }; },
        async noteFromRequest(_pool, args) { added.push(args); return { ok, card: { noteId: 9 } }; },
      },
    },
  });
  const out = await voice.runTool({}, ctxOf(true), 'ask_changed', { what: 'blue footer' });
  assert.equal(out.ok, true);
  assert.match(added[0].note, /^blue footer\n\nthe footer should be blue$/);
  assert.equal(added[0].commentId, 501);
  const refused = await voice.runTool({}, ctxOf(false), 'ask_changed', { what: 'blue footer' });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /Only whoever asked for this request or the project's owner can send what changed into it/);
  assert.match(refused.error, /Nothing was queued\.$/);
});

test('#6684: a missed note from a request goes into the change next update by itself, no tap', async () => {
  const revised = [];
  const said = [];
  const updates = [];
  const pool = {
    async query(sql, params) {
      if (/SELECT slug FROM apps WHERE id/.test(sql)) return { rows: [{ slug: 'gym' }] };
      if (/FROM users WHERE id = \$1/.test(sql)) return { rows: [{ id: 1, username: 'ada' }] };
      if (/FROM users WHERE username = \$1 AND is_synthetic/.test(sql)) return { rows: [{ id: 77, username: 'homeroom_bot' }] };
      if (/FROM chat_sessions cs JOIN users b/.test(sql)) return { rows: [{ id: 31 }] };
      if (/SELECT id, app_id, metadata/.test(sql)) {
        return { rows: [{ id: params[0], app_id: 2, metadata: { homeroomBot: { kind: 'voice', buildNote: { noteId: 9 } } }, thread_type: 'issue', thread_ref: 12 }] };
      }
      if (/UPDATE chat_messages SET metadata/.test(sql)) { updates.push(JSON.parse(params[1])); return { rows: [] }; }
      return { rows: [] };
    },
  };
  const row = {
    id: 9, app_id: 2, issue_number: 12, user_id: 1, note: 'Also the digest.', state: 'missed',
    origin: 'request', run_id: 70, chat_message_id: 55,
  };
  const deps = {
    mayor: { findApp: async () => ({ id: 2, slug: 'gym', name: 'Gym Tracker' }) },
    dm: { requesterOf: async () => ({ userId: 1 }), botAccount: async () => ({ id: 77, username: 'homeroom_bot' }) },
    batches: { managesApp: async () => false },
    settings: {},
    reviseProposal: async (_pool, ctx, args) => { revised.push({ user: ctx.user.id, inPublic: ctx.inPublic, ...args }); return { ok: true }; },
    say: async (_pool, args) => { said.push(args); return { id: 600 }; },
  };
  assert.equal(await steer.forwardFromRequest(pool, {}, row, deps), true);
  assert.equal(revised[0].user, 1);
  assert.equal(revised[0].inPublic, true);
  assert.equal(revised[0].proposal, 31);
  assert.equal(revised[0].change, 'Also the digest.');
  assert.equal(updates[0].homeroomBot.buildNote.state, 'forwarded');
  assert.equal(updates[0].homeroomBot.buildNote.auto, true);
  assert.equal(said[0].place.ref, 12);
  assert.match(said[0].mark.key, /^build-note-forwarded:9$/);
});

test('#6684: a missed note whose build ended with no change reads the request again with it', async () => {
  const owed = [];
  const said = [];
  const updates = [];
  const pool = {
    async query(sql, params) {
      if (/SELECT slug FROM apps WHERE id/.test(sql)) return { rows: [{ slug: 'gym' }] };
      if (/FROM users WHERE id = \$1/.test(sql)) return { rows: [{ id: 1, username: 'ada' }] };
      if (/FROM users WHERE username = \$1 AND is_synthetic/.test(sql)) return { rows: [{ id: 77 }] };
      if (/FROM chat_sessions cs JOIN users b/.test(sql)) return { rows: [] };
      if (/SELECT id, build_ok, build_error/.test(sql)) return { rows: [{ id: 70, build_ok: false, build_error: 'failed' }] };
      if (/SELECT id, app_id, metadata/.test(sql)) {
        return { rows: [{ id: params[0], app_id: 2, metadata: { homeroomBot: { kind: 'voice', buildNote: { noteId: 10 } } }, thread_type: 'issue', thread_ref: 12 }] };
      }
      if (/UPDATE chat_messages SET metadata/.test(sql)) { updates.push(JSON.parse(params[1])); return { rows: [] }; }
      return { rows: [] };
    },
  };
  const row = {
    id: 10, app_id: 2, issue_number: 12, user_id: 1, note: 'Also the digest.', state: 'missed',
    origin: 'request', run_id: 70, chat_message_id: 56,
  };
  const deps = {
    mayor: { findApp: async () => ({ id: 2, slug: 'gym', name: 'Gym Tracker' }) },
    dm: { requesterOf: async () => ({ userId: 1 }), botAccount: async () => ({ id: 77 }) },
    batches: { managesApp: async () => false },
    settings: {},
    replies: { botOwedAndWait: async (p) => { owed.push(p); return { queued: true }; } },
    say: async (_pool, args) => { said.push(args); return { id: 601 }; },
  };
  assert.equal(await steer.forwardFromRequest(pool, {}, row, deps), true);
  assert.equal(owed[0].reason, 'changed');
  assert.equal(owed[0].changedBy, 'voice');
  assert.equal(owed[0].key, 'build-note-reread:10');
  assert.equal(updates[0].homeroomBot.buildNote.state, 'forwarded');
  assert.equal(updates[0].homeroomBot.buildNote.reread, true);
  assert.match(said[0].mark.key, /^build-note-reread:10$/);
});

test('#6684: a note from a request carries its origin and comment', async () => {
  const sqls = [];
  const pool = {
    async query(sql, params) {
      sqls.push({ sql, params });
      if (/FROM homeroom_bot_build_notes WHERE app_id/.test(sql)) return { rows: [] };
      return { rows: [{ id: 41 }] };
    },
  };
  const id = await steer.addNote(pool, {
    app: { id: 2 }, issueNumber: 12, build: { runId: 70, sessionId: 900 }, user: { id: 1 },
    note: 'Also the digest.', origin: 'request', commentId: 501,
  });
  assert.equal(id, 41);
  const insert = sqls.find((s) => /INSERT INTO homeroom_bot_build_notes/.test(s.sql));
  assert.match(insert.sql, /origin, comment_id/);
  assert.deepEqual(insert.params.slice(9), ['request', 501]);
});
