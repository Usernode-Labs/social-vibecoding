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

function fakes({ build = { runId: 70, sessionId: 900, running: true } } = {}) {
  const added = [];
  const fake = {
    noteText: steer.noteText,
    async maySteer() { return { ok: true, theirs: true, manages: false }; },
    async buildUnderWay() { return build; },
    async buildForRequest() { return build; },
    async addNote(_pool, args) { added.push(args); return 55; },
  };
  const mayor = { findApp: async () => ({ id: 2, slug: 'gym', name: 'Gym Tracker' }), canView: async () => true };
  const pool = { query: async () => ({ rows: [{ title: 'Dark mode' }] }) };
  return { added, pool, deps: { steer: fake, mayor } };
}

test('#6684: a comment is a note with origin request, and its card is returned for the reply', async () => {
  const f = fakes();
  const ctx = { user: { id: 1 }, deps: f.deps, appIds: new Set() };
  const out = await tool.addToBuild(f.pool, ctx, { note: 'Also send the digest through the inbox.' }, {
    onRequest: { app: { id: 2, slug: 'gym', name: 'Gym Tracker' }, n: 12, commentId: 501 },
  });
  assert.equal(out.ok, true);
  assert.equal(out.card.state, 'waiting');
  assert.equal(out.card.noteId, 55);
  assert.equal(ctx.card, undefined, 'the voice writes the card into the reply, not the chat\'s ctx.card');
  assert.equal(f.added[0].origin, 'request');
  assert.equal(f.added[0].commentId, 501);
  assert.equal(f.added[0].build.runId, 70);
});

test('#6684: stop_and_redo on a request is an offer only, with origin request', async () => {
  const f = fakes();
  const ctx = { user: { id: 1 }, deps: f.deps };
  const out = await tool.stopAndRedo(f.pool, ctx, { note: 'Do not touch the email settings page.' }, {
    onRequest: { app: { id: 2, slug: 'gym', name: 'Gym Tracker' }, n: 12, commentId: 502 },
  });
  assert.equal(out.ok, true);
  assert.equal(out.card.state, 'offer_redo');
  assert.equal(ctx.card, undefined);
  assert.equal(f.added[0].kind, 'redo');
  assert.equal(f.added[0].state, 'offered');
  assert.equal(f.added[0].origin, 'request');
});

test('#6684: the voice sends a comment to the build and puts its card on the reply', async () => {
  const added = [];
  const ctx = {
    app: { id: 2, slug: 'gym', name: 'Gym Tracker' }, place: { type: 'issue', ref: 12 }, user: { id: 1 },
    triggerMessage: { id: 501 }, deps: {
      steerTool: {
        async addToBuild(_pool, _ctx, args, opts) {
          added.push({ args, opts });
          return { ok: true, sent: 'Sent.', shown: 'Never say it has.', card: { type: 'build_note', state: 'waiting', noteId: 9, number: 12 } };
        },
      },
    },
  };
  const out = await voice.runTool({}, ctx, 'add_to_build', { note: 'Add the digest too.' });
  assert.equal(out.ok, true);
  assert.deepEqual(added[0].opts.onRequest, { app: ctx.app, n: 12, commentId: 501 });
  assert.deepEqual(ctx.buildNote, out.card);
});

test('#6684: a steerer whose build started after the tools were chosen sends the comment into it; a stranger is told who can', async () => {
  const added = [];
  const steerer = {
    async maySteer() { return { ok: true }; },
    async buildForRequest() { return { runId: 70, sessionId: 900, running: true }; },
  };
  const ctxOf = (ok) => ({
    app: { id: 3, slug: 'todo', name: 'Todo' }, place: { type: 'issue', ref: 12 }, user: { id: 9, username: 'ada' },
    bot: { id: 77 }, settings: { mode: 'live' }, triggerMessage: { id: 501, content: 'the footer should be blue' },
    deps: {
      liveSvc: { isLiveFor: () => true, async openBotProposal() { return null; } },
      mayor: { async pendingBuild() { return true; } },
      steer: { ...steerer, async maySteer() { return { ok }; } },
      steerTool: { async addToBuild(_pool, _ctx, args, opts) { added.push({ args, opts }); return { ok: true, card: { noteId: 9 } }; } },
    },
  });
  const out = await voice.runTool({}, ctxOf(true), 'ask_changed', { what: 'blue footer' });
  assert.equal(out.ok, true);
  assert.match(added[0].args.note, /^blue footer\n\nthe footer should be blue$/);
  assert.equal(added[0].opts.onRequest.commentId, 501);
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
