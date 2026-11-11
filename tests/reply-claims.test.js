'use strict';
// Homeroom bot one model, step 2: one reply checker (src/services/reply-claims.js)
// for Main, the voice, its reports and the design bot. A claim is checked
// against what the turn did and what Homeroom has stored; only what is shown
// false is cut, the cut never adds a line, and the repair note names only the
// tools its place has and never asks for a denial.
const test = require('node:test');
const assert = require('node:assert/strict');

const claims = require('../src/services/reply-claims');

/** A pool answering each SQL by the first matching route; every query is kept. */
function pool(routes = []) {
  const seen = [];
  return {
    seen,
    query: async (sql, params = []) => {
      seen.push({ sql: String(sql), params });
      for (const [re, rows] of routes) {
        if (re.test(String(sql))) return { rows: typeof rows === 'function' ? rows(params) : rows };
      }
      return { rows: [] };
    },
  };
}

const kinds = async (p, ctx, text) => (await claims.checkReply(p, ctx, text)).map((x) => x.kind);

test('the bot\'s server notes back a claim; its own earlier chat words do not', async () => {
  const ctx = { user: { id: 1 }, bot: { id: 2 }, appIds: new Set(), conversationId: 5 };
  // A tap's ack (metadata.homeroomBot.kind 'filed') is a record of the filing.
  const noted = pool([
    [/FROM conversation_messages\s+WHERE conversation_id = \$1 AND sender_id = \$2/, (params) => {
      assert.deepEqual(params[2], ['filed', 'closing', 'withdrawn', 'design_filed'], 'only server notes are read');
      return [{ content: '**Rilo** · request #12: Tags\n\nFiled.', kind: 'filed', issue_number: '12' }];
    }],
    [/SELECT DISTINCT x\.n FROM/, [{ n: 12 }]],
  ]);
  assert.deepEqual(await kinds(noted, ctx, 'I filed it as request #12.'), []);
  // With no such note, "I filed it" is shown false: the conversation's filings are all on record.
  assert.deepEqual(await kinds(pool([[/SELECT DISTINCT x\.n FROM/, [{ n: 12 }]]]), ctx, 'I filed it as request #12.'), ['filed']);
  // The query asks for server kinds only, so a model reply ('chat') never reaches it.
  const sql = noted.seen.find((q) => /FROM conversation_messages/.test(q.sql) && /homeroomBot/.test(q.sql));
  assert.ok(sql, 'the notes are read by their kind');
});

test('moved is read from the request: its original number or its new one', async () => {
  const ctx = { user: { id: 1 }, appIds: new Set([3]) };
  const moves = pool([
    [/FROM bot_cards a WHERE a\.kind = 'move_request' AND a\.status = 'done'/, [{ kind: 'move_request', status: 'done', issue_number: 6600, source_issue_number: 20 }]],
    [/SELECT DISTINCT x\.n FROM/, [{ n: 20 }, { n: 6600 }]],
  ]);
  assert.deepEqual(await kinds(moves, ctx, 'Request #20 was moved.'), [], 'the original number');
  assert.deepEqual(await kinds(moves, ctx, '#6600 was moved.'), [], 'the number on Homeroom\'s board');
  assert.deepEqual(await kinds(pool([[/SELECT DISTINCT x\.n FROM/, [{ n: 21 }]]]), ctx, 'Request #21 was moved.'), ['moved_status'],
    'a request no move card names was not moved');
  // "I moved it" stays false whatever the records say: only a tap moves one.
  assert.deepEqual(await kinds(moves, ctx, 'I moved #20.'), ['moved']);
});

test('started is read from the stored work state; a stage it cannot find keeps the sentence', async () => {
  const ctx = { user: { id: 1 }, app: { id: 9 }, appIds: new Set([9]), place: { type: 'issue', ref: 14 } };
  const stage = (s) => pool([[/FROM work_states/, [{ issue_number: 14, stage: s }]]]);
  assert.deepEqual(await kinds(stage('building'), ctx, 'I\'m building it now.'), []);
  assert.deepEqual(await kinds(stage('stopped'), ctx, 'I\'m building it now.'), ['started'], 'a stopped build is not being built');
  assert.deepEqual(await kinds(pool(), ctx, 'I\'m building it now.'), [], 'no stored row: it cannot be shown false');
  // A sentence naming none is about the reply's own request ("it").
  const main = { user: { id: 1 }, appIds: new Set([9]) };
  const reading = pool([[/FROM work_states/, (params) => params[1].map((n) => ({ issue_number: n, stage: 'reading' }))],
    [/SELECT DISTINCT x\.n FROM/, [{ n: 30 }]]]);
  assert.deepEqual(await kinds(reading, main, 'Request #30 is queued. I\'ll look at it now.'), []);
});

test('a failed read proves nothing, and a turn flag needs no read', async () => {
  const broken = { query: async () => { throw new Error('db down'); } };
  const ctx = { user: { id: 1 }, appIds: new Set(), conversationId: 5, bot: { id: 2 } };
  for (const text of ['I\'ve filed it for you.', 'Tap File it below.', 'I\'ve updated the proposal.', 'I\'ve let the team know.']) {
    assert.deepEqual(await kinds(broken, ctx, text), [], text);
  }
  const quiet = pool();
  assert.deepEqual(await kinds(quiet, { ...ctx, offer: { title: 'x' } }, 'Tap File it below.'), []);
  assert.equal(quiet.seen.filter((q) => /bot_cards/.test(q.sql)).length, 0, 'an offer this turn backs it with no read');
});

test('a request number is unknown only when every lookup found nothing; only then is its sentence cut', async () => {
  const ctx = { user: { id: 1 }, appIds: new Set() };
  const none = await claims.checkReply(pool(), ctx, 'There is already a request for this: #777.');
  assert.deepEqual(none.map((p) => [p.kind, p.numbers, p.shown]), [['unknown', [777], [777]]]);
  assert.equal(claims.cut('There is already a request for this: #777. Want me to draft one?', none, ctx), 'Want me to draft one?');
  // The platform's reports could not be read: the number is looked up again, never cut.
  const halfBroken = pool([[/FROM feedback_reports WHERE user_id = \$1 AND issue_number = ANY/, () => { throw new Error('down'); }]]);
  halfBroken.query = (orig => async (sql, params) => {
    if (/SELECT DISTINCT issue_number AS n FROM feedback_reports WHERE user_id = \$1 AND issue_number = ANY/.test(sql)) throw new Error('down');
    return orig(sql, params);
  })(halfBroken.query);
  const unsure = await claims.checkReply(halfBroken, ctx, 'There is already a request for this: #777.');
  assert.deepEqual(unsure.map((p) => [p.kind, p.shown]), [['unknown', []]]);
  assert.equal(claims.cut('There is already a request for this: #777.', unsure, ctx), 'There is already a request for this: #777.');
  assert.match(claims.repairNote(unsure), /look it up with request_detail/);
});

test('the voice in a change\'s thread reads its own cards, not the project\'s main chat', async () => {
  const p = pool();
  const ctx = { user: { id: 1 }, app: { id: 9 }, appIds: new Set([9]), place: { type: 'session', ref: 44 } };
  await claims.checkReply(p, ctx, 'Tap File it below.');
  const cards = p.seen.find((q) => /FROM bot_cards a WHERE a\.kind IN/.test(q.sql));
  assert.ok(cards, 'its cards are read');
  assert.deepEqual(cards.params.slice(1), [null, 9, 'session', 44], 'the change\'s thread, by its type and ref');
  const chat = pool();
  await claims.checkReply(chat, { ...ctx, place: { type: 'chat', ref: null } }, 'Tap File it below.');
  assert.deepEqual(chat.seen.find((q) => /FROM bot_cards a WHERE a\.kind IN/.test(q.sql)).params.slice(1), [null, 9, null, null],
    'a project\'s main chat is the thread with no type');
});

test('posts on a request back "I posted it" only in that request\'s own thread', async () => {
  const posts = [/FROM homeroom_bot_posts/, [{ issue_number: 6 }]];
  const known = [/SELECT DISTINCT x\.n FROM/, [{ n: 6 }]];
  const said = 'I posted that on request #6.';
  assert.deepEqual(await kinds(pool([posts, known]), { user: { id: 1 }, app: { id: 9 }, appIds: new Set([9]), place: { type: 'issue', ref: 6 } }, said), []);
  assert.deepEqual(await kinds(pool([posts, known]), { user: { id: 1 }, appIds: new Set([9]), conversationId: 5 }, said), ['posted'],
    'in a chat the bot posts only by a tap, which leaves its note');
});

test('a report is backed by its number or by one filed from this conversation, not by any report last week', async () => {
  const ctx = { user: { id: 1 }, appIds: new Set(), conversationId: 5 };
  const here = pool([[/SELECT issue_number, created_at FROM feedback_reports/, [{ issue_number: 6564, created_at: new Date() }]]]);
  assert.deepEqual(await kinds(here, ctx, 'I\'ve let the team know.'), []);
  assert.deepEqual(await kinds(pool(), ctx, 'I\'ve let the team know.'), ['reported']);
  const elsewhere = pool([[/SELECT issue_number, created_at FROM feedback_reports/, (params) => {
    assert.equal(params[2], null, 'no conversation, no "filed here"');
    return [];
  }]]);
  assert.deepEqual(await kinds(elsewhere, { user: { id: 1 }, appIds: new Set() }, 'I\'ve let the team know.'), ['reported']);
});

test('the cut never adds a line, and keeps every sentence not shown false', () => {
  const problems = [
    { kind: 'closed_request', proof: 'never' }, { kind: 'promised', proof: 'turn' }, { kind: 'drafted', proof: 'records' },
    { kind: 'unknown', numbers: [9], shown: [9] }, { kind: 'unknown_project', names: ['Block World'] },
  ];
  const text = 'I closed it. I\'ll look into the rest. Tap File it below. #9 is the one. The draft for Block World waits. The header is blue.';
  const out = claims.cut(text, problems);
  assert.equal(out, 'The header is blue.');
  for (const line of [/I haven't/, /I can't find/, /I can't look into/]) assert.doesNotMatch(out, line);
  // Two status sentences: only the one the records show false goes.
  const both = claims.cut('#14 is closed. #15 is closed.', [{ kind: 'closed_status', proof: 'records', numbers: [15], all: false }]);
  assert.equal(both, '#14 is closed.');
  // Nothing left is nothing sent, never a stock line.
  assert.equal(claims.cut('I moved it.', [{ kind: 'moved', proof: 'never' }]), '');
});

test('lastWords keeps what a record alone called false, never an action the bot cannot take', () => {
  const problems = [{ kind: 'revised', proof: 'records' }, { kind: 'drawing', proof: 'turn' }];
  assert.equal(claims.lastWords('I\'ve updated it. I\'m drawing the screen now.', problems), 'I\'ve updated it.');
  assert.equal(claims.lastWords('I\'ve updated it.', [{ kind: 'revised', proof: 'records' }]), 'I\'ve updated it.');
  assert.equal(claims.lastWords('I closed it.', [{ kind: 'closed_request', proof: 'never' }]), '');
});

test('the repair note names only the tools its place offers, and asks for no denial', () => {
  const problems = [
    { kind: 'drawing', said: 'says you are drawing a screen' }, { kind: 'no_control', said: 'tells them to do something there is no control for' },
    { kind: 'filed', said: 'says a request was filed' }, { kind: 'promised', said: 'promises to come back to something later' },
  ];
  const thread = claims.repairNote(problems, { tools: new Set(['reply', 'start_request', 'offer_close_request']) });
  for (const name of ['draw_screen', 'close_thread', 'offer_request', 'comment_on_request', 'report_problem', 'request_detail']) {
    assert.ok(!thread.includes(name), `${name} is not offered there`);
  }
  assert.match(thread, /start_request starts one/);
  const main = claims.repairNote(problems, { tools: new Set(['reply', 'draw_screen', 'close_thread', 'offer_request']) });
  assert.match(main, /call draw_screen now/);
  assert.match(main, /to finish this private thread, call close_thread\./);
  const design = claims.repairNote([{ kind: 'design_done', said: 'x' }], { tools: new Set(['reply', 'write_screen', 'edit_design']) });
  assert.match(design, /Call write_screen \(or edit_design\) now, then reply\./);
  for (const note of [thread, main, design]) {
    assert.doesNotMatch(note, /say plainly (?:that )?it (?:has not|hasn't) been done|has not been done|retract|If you cannot confirm it/i);
    assert.doesNotMatch(note, /—/);
  }
});

test('a design thread\'s own claims: a drawing or a change it did not make, a filed design said not to be built', () => {
  const found = (text, turn) => claims.check(claims.mentions(text), { turn }).map((p) => p.kind);
  assert.deepEqual(found('I\'ve made the header blue.', { design: true }), ['design_done']);
  assert.deepEqual(found('I\'ve made the header blue.', { design: true, drew: true }), []);
  assert.deepEqual(found('I\'ve made the header blue.', {}), [], 'only a design thread');
  const filed = { design: true, filedDesign: { number: 14 }, designBuilds: true };
  assert.deepEqual(found('Someone on the project has to start it.', filed), ['not_built']);
  assert.deepEqual(found('Someone on the project has to start it.', { ...filed, designBuilds: false }), [], 'true where a person must decide');
});

test('checkedNote runs a server template through the check and never throws', async () => {
  const ctx = { user: { id: 1 }, appIds: new Set(), withdrew: { proposal: 1 } };
  assert.equal(await claims.checkedNote(pool(), ctx, 'I\'ve withdrawn the duplicate proposal.'), 'I\'ve withdrawn the duplicate proposal.');
  assert.equal(await claims.checkedNote(pool(), { user: { id: 1 }, appIds: new Set() }, 'I\'ve withdrawn the duplicate proposal. It is gone.'), 'It is gone.');
  assert.equal(await claims.checkedNote(null, null, 'Plain words.'), 'Plain words.');
});
