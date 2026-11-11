'use strict';

// One request, one story: what Homeroom bot says on a request's page and its
// change's page (src/services/homeroom-bot-live.js, homeroom-bot-followup.js,
// homeroom-bot-words.js). Others see the same story as the requester: the
// plan in a line, the change when it is up for a vote, and a closing line
// when it is live, in the first person and in whole sentences. A tag means
// the bot is asking you something; progress is said untagged.
//
// Run with: node --test tests/homeroom-bot-request-story.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const live = require('../src/services/homeroom-bot-live');
const followup = require('../src/services/homeroom-bot-followup');
const { firstPerson } = require('../src/services/homeroom-bot-words');

const SPEC = '# Dark mode\n\nA dark theme.';
const BOT = { id: 1, username: 'homeroom_bot' };

test('a plan row is the bot\'s sentence: building it now, or waiting for its requester', () => {
  const building = live.specCard({ sessionId: 7, version: 1, spec: SPEC, bot: BOT });
  assert.equal(building.content, '📋 Plan v1: Dark mode. I\'m building it now.');
  assert.equal(building.metadata.specShare.botNote, 'building');
  assert.equal(building.metadata.specShare.waitingFor, undefined);
  const asking = live.specCard({ sessionId: 7, version: 1, spec: SPEC, bot: BOT, asking: true, requester: 'sam' });
  assert.equal(asking.content, '📋 Plan v1: Dark mode. Nothing is built yet. Waiting for @sam to say Build it.');
  assert.equal(asking.metadata.specShare.botNote, 'waiting');
  assert.equal(asking.metadata.specShare.waitingFor, 'sam');
  assert.equal(live.specCard({ sessionId: 7, version: 2, spec: SPEC, bot: BOT, asking: true }).content,
    '📋 Plan v2: Dark mode. Nothing is built yet. Waiting for the person who asked for it to say Build it.');
  // #6280: a plan that waits for Build it is posted in the waiting form, by
  // its own state (`waiting`), never in the building form.
  const waits = live.specCard({ sessionId: 7, version: 1, spec: SPEC, bot: BOT, waiting: true, requester: 'sam' });
  assert.equal(waits.content, '📋 Plan v1: Dark mode. Nothing is built yet. Waiting for @sam to say Build it.');
  assert.equal(waits.metadata.specShare.botNote, 'waiting');
  assert.equal(waits.metadata.specShare.waitingFor, 'sam');
  // On its change: the plan itself.
  const proposed = live.specCard({ sessionId: 7, version: 1, spec: SPEC, bot: BOT, proposed: true });
  assert.equal(proposed.content, '📋 Plan v1: Dark mode.');
  assert.equal(proposed.metadata.specShare.botNote, undefined);
});

test('a plan its requester said Build it to gets a short note, not a second card', () => {
  assert.equal(live.approvedBuildHomeroomText({ requester: 'sam' }), '@sam said Build it. I\'m building it now.');
  assert.equal(live.approvedBuildHomeroomText({}), 'The person who asked for it said Build it. I\'m building it now.');
  // GitHub's copy names nobody (#723) and promises no later link.
  const github = live.specCommentText(SPEC, { approved: true });
  assert.doesNotMatch(github, /@|linked here/);
  assert.doesNotMatch(live.specCommentText(SPEC), /linked here/);
  assert.doesNotMatch(live.retryCommentText(), /linked here/);
});

test('built: "I built this. It\'s up for a vote: {title}", no pull request number', () => {
  assert.equal(live.proposalHomeroomText({ title: 'Dark mode' }), 'I built this. It\'s up for a vote: Dark mode');
  assert.equal(live.proposalText({ link: 'https://homeroom.example/plant-pal/dev/changes/12', prNumber: 12 }),
    'Homeroom bot built this. It\'s up for a vote: https://homeroom.example/plant-pal/dev/changes/12');
  assert.doesNotMatch(live.proposalHomeroomText({ title: 'Dark mode' }), /PR #|proposal/);
});

test('live, the request\'s ending: "It\'s live. {title} is in {project} now."', () => {
  assert.equal(live.liveHomeroomText({ title: 'Dark mode', project: 'Plant Pal' }), 'It\'s live. Dark mode is in Plant Pal now.');
  assert.equal(live.liveText({ title: 'Dark mode' }), 'Homeroom bot\'s change for this is live: Dark mode.');
  assert.equal(live.tagsPoster('live'), false, 'not tagged');
});

// Step 4 (11 Nov 2026): a post's said-once key in bot_posts
// (services/bot-post.js), as the database answers it: claimed before
// anything is sent (a second ask finds the first), what went out recorded on
// it, then settled; and the request's row in homeroom_bot_posts once said.
function botPostsFake({ failClaim = () => false } = {}) {
  const keys = new Map();   // said_key -> row
  const byId = new Map();
  const projected = [];
  let nextId = 99;
  const handle = (sql, params) => {
    if (/INSERT INTO bot_posts/.test(sql)) {
      if (failClaim()) throw new Error('connection reset');
      const had = keys.get(params[0]);
      if (had) return { rows: [{ ...had, fresh: false }] };
      const row = {
        id: nextId++, said_key: params[0], outcome: 'pending', github_comment_id: null, chat_message_id: null, request_post_id: null,
        created_at: new Date(), claimed_at: new Date(), claimed_by: params[11],
      };
      keys.set(params[0], row);
      byId.set(row.id, row);
      return { rows: [{ ...row, fresh: true }] };
    }
    // A pending post's claim: taken over once it lapsed (or never had one),
    // let go when its send failed.
    if (/SET claimed_at = NOW\(\), claimed_by = \$2/.test(sql)) {
      const row = byId.get(params[0]) || [...keys.values()].find((r) => r.id === params[0]);
      const lapsed = row && row.outcome === 'pending' && (!row.claimed_at || Date.now() - row.claimed_at.getTime() > params[2] * 1000);
      if (!lapsed) return { rows: [] };
      Object.assign(row, { claimed_at: new Date(), claimed_by: params[1] });
      byId.set(row.id, row);
      return { rows: [row] };
    }
    if (/UPDATE bot_posts SET claimed_at = NULL/.test(sql)) {
      const row = byId.get(params[0]);
      if (row && row.outcome === 'pending' && row.claimed_by === params[1]) row.claimed_at = null;
      return { rows: [] };
    }
    if (/FROM bot_posts WHERE said_key = \$1/.test(sql)) return { rows: keys.has(params[0]) ? [keys.get(params[0])] : [] };
    // The message named on its record, in its transaction, by the claim's holder.
    if (/UPDATE bot_posts SET chat_message_id = \$2\s+WHERE id = \$1 AND chat_message_id IS NULL/.test(sql)) {
      const row = byId.get(params[0]);
      if (row.chat_message_id != null || (params[2] != null && row.claimed_by !== params[2])) return { rows: [], rowCount: 0 };
      row.chat_message_id = params[1];
      return { rows: [], rowCount: 1 };
    }
    if (/UPDATE bot_posts\s+SET chat_message_id = COALESCE/.test(sql)) {
      const row = byId.get(params[0]);
      if (params[1] != null) row.chat_message_id = params[1];
      if (params[3] != null) row.github_comment_id = params[3];
      return { rows: [] };
    }
    if (/UPDATE bot_posts\s+SET outcome = \$2/.test(sql)) {
      const row = byId.get(params[0]);
      row.outcome = params[1];
      if (params[3] != null) row.request_post_id = params[3];
      return { rows: [] };
    }
    if (/INSERT INTO homeroom_bot_posts/.test(sql)) {
      projected.push(params);
      return { rows: [{ id: 500 + projected.length }] };
    }
    return null;
  };
  return { keys, byId, projected, handle, only: () => [...keys.values()][0] };
}

function fakeLive({ posted = false, run = true } = {}) {
  const queries = [];
  const comments = [];
  const messages = [];
  const store = botPostsFake();
  if (posted) {
    store.keys.set('live:request:3-12:run-40', { id: 1, outcome: 'said', chat_message_id: 7 });
  }
  const pool = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (/FROM homeroom_bot_runs r\s+JOIN apps a/.test(sql)) {
        return { rows: run ? [{ run_id: 40, app_id: 3, issue_number: 12, slug: 'plant-pal', name: 'Plant Pal', repo_url: 'https://github.com/o/plant-pal', title: 'Dark mode' }] : [] };
      }
      if (/FROM users WHERE username/.test(sql)) return { rows: [BOT] };
      return store.handle(sql, params) || { rows: [] };
    },
  };
  const deps = {
    github: { async createIssueComment(owner, repo, n, text) { comments.push({ owner, repo, n, text }); return { id: 5, created_at: 'now' }; } },
    ws: {
      async sendBotMessage(_pool, appId, { onInsert, ...msg }) { messages.push({ appId, ...msg }); return { id: 77 }; },
      async sendSystemMessage() { throw new Error('the bot speaks as itself'); },
    },
  };
  return { pool, deps, queries, comments, messages, store };
}

const RUN_ROW = { run_id: 40, app_id: 3, issue_number: 12, slug: 'plant-pal', name: 'Plant Pal', repo_url: 'https://github.com/o/plant-pal', title: 'Dark mode' };

// What the bot's change machine's retry needs (its bot.commentLive work,
// strict): a part that failed is thrown with the post left pending, and the
// retry says only what is missing; a post never reads as said half sent.
test('strict: a failed GitHub comment or thread message is thrown and retried, never marked said', async () => {
  const store = botPostsFake();
  const pool = {
    async query(sql, params) {
      if (/FROM homeroom_bot_runs r\s+JOIN apps a/.test(sql)) return { rows: [RUN_ROW] };
      if (/FROM users WHERE username/.test(sql)) return { rows: [BOT] };
      return store.handle(sql, params) || { rows: [] };
    },
  };
  const down = { github: true, thread: true };
  const comments = [];
  const messages = [];
  const deps = {
    github: {
      async createIssueComment(owner, repo, n, text) {
        if (down.github) throw Object.assign(new Error('GitHub is down'), { status: 502 });
        comments.push(text); return { id: 5, created_at: 'now' };
      },
      async listIssueComments() { return []; },
    },
    ws: {
      async sendBotMessage(_pool, appId, msg) { if (down.thread) throw new Error('db hiccup'); messages.push(msg.content); return { id: 77 }; },
      async sendSystemMessage() { throw new Error('the bot speaks as itself'); },
    },
  };
  await assert.rejects(live.announceLive(pool, { session: { id: 51 }, deps, strict: true }),
    /GitHub comment \(GitHub is down\), the thread message \(db hiccup\)/);
  assert.equal(store.only().said_key, 'live:request:3-12:run-40', 'its key: live, for its run');
  assert.equal(store.only().outcome, 'pending', 'not said yet');
  // The retry: GitHub answers now, the thread still fails.
  down.github = false;
  await assert.rejects(live.announceLive(pool, { session: { id: 51 }, deps, strict: true }), /the thread message/);
  assert.equal(store.keys.size, 1, 'the same post taken up');
  assert.equal(comments.length, 1);
  // Then the thread too: said once, in both places, and marked said.
  down.thread = false;
  const out = await live.announceLive(pool, { session: { id: 51 }, deps, strict: true });
  assert.ok(out && out.github && out.thread);
  assert.deepEqual([comments.length, messages.length], [1, 1], 'the comment is not posted twice');
  assert.equal(store.only().outcome, 'said');
  assert.equal(store.projected.length, 1, 'the request\'s row is written once, when said');
  assert.equal(await live.announceLive(pool, { session: { id: 51 }, deps, strict: true }), null, 'said: nothing more');
});

test('strict: a failed claim of the post is thrown, never taken for none (no second post, nothing said twice)', async () => {
  // The thread message went out; GitHub failed, so the post is pending.
  let claimDown = true;
  const store = botPostsFake({ failClaim: () => claimDown });
  store.keys.set('live:request:3-12:run-40', { id: 99, outcome: 'pending', github_comment_id: null, chat_message_id: 77, created_at: new Date() });
  store.byId.set(99, store.keys.get('live:request:3-12:run-40'));
  const pool = {
    async query(sql, params) {
      if (/FROM homeroom_bot_runs r\s+JOIN apps a/.test(sql)) return { rows: [RUN_ROW] };
      if (/FROM users WHERE username/.test(sql)) return { rows: [BOT] };
      return store.handle(sql, params) || { rows: [] };
    },
  };
  const messages = [];
  const deps = {
    github: { async createIssueComment() { return { id: 5, created_at: 'now' }; }, async fetchIssueComments() { return { comments: [] }; } },
    ws: { async sendBotMessage(_p, _a, msg) { messages.push(msg.content); return { id: 78 }; }, async sendSystemMessage() {} },
  };
  await assert.rejects(live.announceLive(pool, { session: { id: 51 }, deps, strict: true }), /connection reset/);
  assert.deepEqual([store.projected.length, messages.length], [0, 0], 'no second post, nothing sent');
  // The retry takes up the pending post and sends only the missing comment.
  claimDown = false;
  const out = await live.announceLive(pool, { session: { id: 51 }, deps, strict: true });
  assert.ok(out && out.github && out.thread);
  assert.deepEqual(messages.length, 0, 'the thread message is not said again');
  assert.equal(store.byId.get(99).outcome, 'said');
});

// trace-bot-notes bugs 9 and 10: the bubble's row went in and its id was
// never kept (its broadcast threw after the INSERT, or the process ended),
// or GitHub could not be read for the comment a cut-short post made. Step 4:
// the message's record names it in the message's own transaction
// (ws.sendBotMessage `onInsert`), so the retry finds it there; a failed
// read is retried, never taken for "not posted".
test('strict: a retry finds the thread message it made before by its record, and a failed comment lookup is thrown', async () => {
  const store = botPostsFake();
  store.keys.set('live:request:3-12:run-40', { id: 99, outcome: 'pending', github_comment_id: null, chat_message_id: null, created_at: new Date() });
  store.byId.set(99, store.keys.get('live:request:3-12:run-40'));
  const chat = [];   // chat_messages rows the bot inserted, with their metadata
  let lookupDown = true;
  const pool = {
    async query(sql, params) {
      if (/FROM homeroom_bot_runs r\s+JOIN apps a/.test(sql)) return { rows: [RUN_ROW] };
      if (/FROM users WHERE username/.test(sql)) return { rows: [BOT] };
      return store.handle(sql, params) || { rows: [] };
    },
  };
  let broadcastFails = true;
  const comments = [];
  const deps = {
    github: {
      // As github.js answers a read it could not make: a note, never a throw.
      async fetchIssueComments() { return lookupDown ? { comments: [], truncated: false, note: 'fetch failed' } : { comments: [] }; },
      async createIssueComment(o, r, n, text) { comments.push(text); return { id: 5, created_at: 'now' }; },
    },
    ws: {
      // The row goes in with its record, then its broadcast throws: what
      // sendBotMessage does when its user_blocks read fails after the commit.
      async sendBotMessage(p, _a, msg) {
        const id = 700 + chat.length;
        chat.push({ id, metadata: msg.metadata });
        if (msg.onInsert) await msg.onInsert(p, { messageId: id });
        if (broadcastFails) throw new Error('user_blocks read failed');
        return { id };
      },
      async sendSystemMessage() {},
    },
  };
  await assert.rejects(live.announceLive(pool, { session: { id: 51 }, deps, strict: true }), /fetch failed/,
    'a failed lookup of its comment is retried, not taken for none');
  assert.equal(comments.length, 0);
  lookupDown = false;
  await assert.rejects(live.announceLive(pool, { session: { id: 51 }, deps, strict: true }), /the thread message \(user_blocks read failed\)/);
  assert.equal(chat.length, 1);
  assert.equal(chat[0].metadata.hrbotPost, 'post-99', 'its message carries the post\'s mark');
  assert.equal(store.byId.get(99).chat_message_id, 700, 'and its record names it');
  broadcastFails = false;
  const out = await live.announceLive(pool, { session: { id: 51 }, deps, strict: true });
  assert.ok(out && out.thread);
  assert.equal(chat.length, 1, 'the bubble is not posted a second time');
  assert.equal(out.messageId, 700, 'and the one it made is the one kept');
  assert.equal(comments.length, 1);
});

test('announceLive says it on the request once, in both places, untagged', async () => {
  const f = fakeLive();
  const out = await live.announceLive(f.pool, { session: { id: 51 }, deps: f.deps });
  assert.ok(out && out.github && out.thread);
  assert.deepEqual(f.comments, [{ owner: 'o', repo: 'plant-pal', n: 12, text: 'Homeroom bot\'s change for this is live: Dark mode.' }]);
  assert.equal(f.messages.length, 1);
  assert.equal(f.messages[0].content, 'It\'s live. Dark mode is in Plant Pal now.');
  assert.deepEqual(f.messages[0].thread, { type: 'issue', ref: 12 });
  assert.deepEqual(f.store.projected[0].slice(0, 4), [3, 12, 40, 'live']);
  // Said already, or not the bot's change: nothing more.
  const again = fakeLive({ posted: true });
  assert.equal(await live.announceLive(again.pool, { session: { id: 51 }, deps: again.deps }), null);
  assert.equal(again.messages.length + again.comments.length, 0);
  const other = fakeLive({ run: false });
  assert.equal(await live.announceLive(other.pool, { session: { id: 51 }, deps: other.deps }), null);
  assert.equal(await live.announceLive(other.pool, { session: null }), null);
});

test('the bot\'s change machine asks for it once the change is live, strictly, so a failure is retried', async (t) => {
  // The merge-followups machine's live tells the bot's change machine
  // (its write); that machine's bot.commentLive runs it with the change's row.
  const { WORK } = require('../src/workflow/bot-change/machine.ts');
  const { botChangeServices } = require('../src/workflow/bot-change/services.ts');
  assert.equal(WORK.livePost, 'bot.commentLive');
  const machine = require('node:fs').readFileSync(require.resolve('../src/workflow/merge-followups/machine.ts'), 'utf8');
  const toLive = machine.slice(machine.indexOf('function toLive('), machine.indexOf('function lineInput('));
  assert.match(toLive, /writes\.push\(toBotChange\(d\.sessionId, 'Live'\)\);/);
  const row = { id: 51, app_id: 3, app_slug: 'plant-pal', pr_title: 'Dark mode' };
  const pool = { async query(sql) { return { rows: /FROM chat_sessions WHERE id = \$1/.test(sql) ? [row] : [] }; } };
  const asked = [];
  t.mock.method(live, 'announceLive', async (p, args) => { asked.push([p, args]); return { github: {}, thread: {} }; });
  const run = (input) => botChangeServices({ config: {}, pool })[WORK.livePost]
    .run({ input, key: 'live-post', attempt: 1, resumeFrom: null, checkpoint: async () => {} });
  assert.deepEqual(await run({ sessionId: 51 }), { posted: true });
  assert.equal(asked.length, 1);
  assert.equal(asked[0][0], pool);
  assert.equal(asked[0][1].session, row, 'the change as it reads now');
  assert.equal(asked[0][1].strict, true);
  t.mock.restoreAll();

  // Strict: a failure throws, for the work item to be retried; otherwise it
  // is logged and reads as nothing said.
  const broken = { async query() { throw new Error('db down'); } };
  await assert.rejects(live.announceLive(broken, { session: { id: 51 }, strict: true }), /db down/);
  assert.equal(await live.announceLive(broken, { session: { id: 51 } }), null);
});

test('only what asks people something tags them', () => {
  for (const kind of ['question', 'person', 'followup_ask']) assert.equal(live.tagsPoster(kind), true, kind);
  for (const kind of ['spec', 'plan', 'proposal', 'build_failed', 'blocked', 'empty', 'followup_answer',
    'followup_revise', 'followup_person', 'followup_failed', 'looking', 'held_proposals_per_app']) {
    assert.equal(live.tagsPoster(kind), false, kind);
  }
});

test('held: one of my changes on the project, or my turn there, in whole sentences', () => {
  assert.equal(firstPerson(live.heldText({ cap: 'proposals_per_app', limit: 3, project: 'Plant Pal' })),
    'I\'ll build this when one of my 3 changes on Plant Pal is voted in or closed.');
  assert.equal(firstPerson(live.heldText({ cap: 'proposals_total', limit: 40 })),
    'I\'ll build this when one of my 40 changes across Homeroom is voted in or closed.');
  // #6156: held for its turn among the project's builds.
  assert.equal(firstPerson(live.heldText({ cap: 'builds_per_app', limit: 5, project: 'Plant Pal' })),
    'I\'ll build this when one of the 5 changes I\'m building on Plant Pal at once is done.');
});

test('decide: who can say Go ahead is named in Homeroom, and nobody on GitHub', () => {
  assert.equal(live.personHomeroomText({ reason: 'It changes who can sign in', requester: 'sam' }),
    'I think a person needs to decide this one: It changes who can sign in. @sam can say Go ahead in a chat with me, or reply here.');
  assert.equal(live.personHomeroomText({ reason: 'x.', deciders: ['ada', 'bo'] }),
    'I think a person needs to decide this one: x. @ada or @bo can say Go ahead in a chat with me, or reply here.');
  assert.doesNotMatch(live.personText({ reason: 'x' }), /@/);
  // #6306: a request already found working says so, and offers the close
  // vote, never Go ahead and never "a person needs to decide".
  assert.equal(live.personHomeroomText({ reason: 'Visitors get the lobby and play as a guest', done: true }),
    'Already works: Visitors get the lobby and play as a guest. Anyone in the project can tap Propose to close below to start a vote, or reply here if something is missing.');
  assert.doesNotMatch(live.personHomeroomText({ reason: 'x', done: true }), /Go ahead|person needs to decide/);
  assert.equal(live.personText({ reason: 'x', done: true }),
    'Homeroom bot found this already works: x.\n\nAnyone in the project can propose to close it, or reply here if something is missing.');
  assert.equal(firstPerson(live.personText({ reason: 'It is a platform setting', platform: true, project: 'Plant Pal' })),
    'I think this is about Homeroom itself, not Plant Pal: It is a platform setting.\n\n'
    // #6311: the copy is an option too, and the original stays open.
    + 'Whoever asked for it, or Plant Pal\'s creator or admins, can have it filed on Homeroom\'s own board too, or moved there.');
});

test('the checks hand-off says why in whole sentences, in the first person', () => {
  const said = (why, failingCount = 2) => firstPerson(followup.checksPersonText({ why, failingCount }));
  assert.match(said('it has already updated this change 3 times, as many as it may on its own'),
    / I've already updated it 3 times, as many as I may on my own\. The person who asked for it, or any member of this project, can take it from here\.$/);
  assert.match(said('its attempt to fix them ran out of time'), / My attempt to fix them ran out of time\. The person who asked for it, or any member of this project, can take it from here\.$/);
  assert.match(said('its attempt to fix them failed (exit 2)'), / My attempt to fix them failed \(exit 2\)\. The person who asked for it, or any member of this project, can take it from here\.$/);
  assert.match(said('its attempt to fix them changed nothing'), / My attempt to fix them changed nothing\. The person who asked for it, or any member of this project, can take it from here\.$/);
  assert.match(said('the seed data is missing'), / The seed data is missing\. The person who asked for it, or any member of this project, can take it from here\.$/);
  assert.equal(firstPerson(followup.checksNotChangeText({ failingCount: 1 })),
    'The failing check on this change isn\'t caused by it: it fails without it too. I\'ve flagged it to Homeroom\'s admins, who look after the checks.');
  assert.match(followup.checksNotChangeText({ failingCount: 3 }), /^The failing checks on this change aren't caused by it: they fail without it too\./);
  assert.equal(firstPerson(followup.replyFailedText({ why: 'it ran out of time', retrying: true })),
    'I couldn\'t answer this time: I ran out of time. I\'ll try again soon.');
});

test('one note per update: the bot\'s own notes leave the cleared votes to the platform\'s line', () => {
  assert.doesNotMatch(followup.revisedText({ summary: 'Moved the bar.' }), /approvals|votes/i);
  for (const opts of [{ failing: true }, { broken: true }, { skipped: true }]) {
    assert.doesNotMatch(followup.checksRevisedText(opts), /approvals|votes/i);
  }
  const voice = require('../src/services/homeroom-bot-voice');
  assert.deepEqual(voice.mustSay({ action: 'revise', moved: true }), []);
});
