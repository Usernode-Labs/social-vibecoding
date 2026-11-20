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
  // #6583 (as merged): a note for an unfound number alone asks for a lookup and never says it was not found.
  assert.match(claims.repairNote(unsure), /Look the number up with request_detail/);
  assert.doesNotMatch(claims.repairNote(unsure), /could not find/);
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
  for (const name of ['start_design', 'close_thread', 'offer_request', 'comment_on_request', 'report_problem', 'request_detail']) {
    assert.ok(!thread.includes(name), `${name} is not offered there`);
  }
  assert.match(thread, /start_request starts one/);
  // Step 6: a private thread starts a design itself, and draws it in the same turn.
  const main = claims.repairNote(problems, { tools: new Set(['reply', 'start_design', 'close_thread', 'offer_request']) });
  assert.match(main, /call start_design now with what to draw and its title, draw it, then reply/);
  assert.doesNotMatch(main, /draw_screen|do not reply/);
  assert.match(main, /to finish this private thread, call close_thread\./);
  const design = claims.repairNote([{ kind: 'design_done', said: 'x' }], { tools: new Set(['reply', 'write_artifact', 'edit_artifact', 'capture_page', 'start_design']) });
  assert.match(design, /Call write_artifact \(or edit_artifact\) now, then reply\./, 'with the design loaded it draws now');
  // A live draft's change said with none saved (step 6, draft_done).
  const draft = claims.repairNote([{ kind: 'draft_done', said: 'says you changed or saved the draft' }], { tools: new Set(['reply', 'apply_changes']) });
  assert.match(draft, /Nothing was saved to the draft this turn\. Make the change with edit_file and save it with apply_changes/);
  for (const note of [thread, main, design, draft]) {
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

// ── #6682: a plan card never files another request ─────────────────────────

const PLAN = { appName: 'RecipeBot', appSlug: 'recipe-bot', title: 'Recipes with emoji photos' };

test('#6682: planCardOther spots a sentence saying the plan card files another request', () => {
  // The drawing-rule request is not the design, though it is on the same project.
  assert.equal(claims.planCardOther('The card under this reply files the drawing-rule request on RecipeBot.', PLAN), true);
  assert.equal(claims.planCardOther('The card files a request about drawing on RecipeBot.', PLAN), true);
  // Another project, when the card is RecipeBot's.
  assert.equal(claims.planCardOther('The card under this reply files the drawing-rule request on Homeroom.', PLAN), true);
  assert.equal(claims.planCardOther('The card files it on Homeroom.', PLAN), true);
  // The plan's own card: New request with this design's version as its plan.
  assert.equal(claims.planCardOther('Tap New request to file a request on RecipeBot with version 7 as its plan.', PLAN), false);
  assert.equal(claims.planCardOther('Tap the card to post version 7 of Recipes with emoji photos as a plan on RecipeBot.', PLAN), false);
  assert.equal(claims.planCardOther('Tap the card to post version 7 on request #196 as its plan.', PLAN), false);
  // Nothing about a card or a filing: not this rule's business.
  assert.equal(claims.planCardOther('I read the drawing-rule request on RecipeBot.', PLAN), false);
});

test('#6682: cardSentence drops a sentence claiming the plan card files another request', () => {
  const mayor = require('../src/services/homeroom-bot-mayor');
  const F = 'Tap New request to file a request on RecipeBot with version 7 as its plan, publicly, under your name.';
  const wrong = 'The card under this reply files the drawing-rule request on RecipeBot.';
  assert.equal(mayor.cardSentence(wrong, { issueNumber: null, fallback: F, plan: PLAN }), F, 'dropped, and the fallback says it');
  const good = 'Tap New request to file a request on RecipeBot with version 7 as its plan.';
  assert.equal(mayor.cardSentence(good, { issueNumber: null, fallback: F, plan: PLAN }), good, 'the plan card\'s own sentence stays');
  assert.equal(mayor.cardSentence(`${wrong} ${good}`, { issueNumber: null, fallback: F, plan: PLAN }), good, 'only the wrong sentence goes');
  assert.equal(mayor.cardSentence(wrong, { issueNumber: null, fallback: F }), wrong, 'without a plan, this rule does not apply');
});

test('#6682: "tap File it" is a false claim beside a plan card, and true beside a request draft', async () => {
  const planTurn = { offer: { kind: 'plan', app: { id: 4, slug: 'recipe-bot', name: 'RecipeBot' } }, designTitle: PLAN.title };
  assert.deepEqual(await kinds(pool(), planTurn, 'Tap File it below.'), ['drafted'], 'a plan card has no File it');
  assert.deepEqual(await kinds(pool(), { offer: { app: { id: 4, slug: 'recipe-bot', name: 'RecipeBot' } } }, 'Tap File it below.'), [],
    'a request draft has one');
});

test('#6682: the plan_card_other rule cuts the wrong sentence, not the whole reply', async () => {
  const turn = { offer: { kind: 'plan', app: { id: 4, slug: 'recipe-bot', name: 'RecipeBot' } }, designTitle: PLAN.title };
  const text = 'The card under this reply files the drawing-rule request on RecipeBot. Version 7 is ready to post.';
  const found = await claims.checkReply(pool(), turn, text);
  assert.deepEqual(found.map((p) => p.kind), ['plan_card_other']);
  assert.equal(claims.cut(text, found, turn), 'Version 7 is ready to post.');
  // Beside a request draft there is no plan card, so the sentence is left alone.
  assert.deepEqual(await claims.checkReply(pool(), { offer: { app: { id: 4, slug: 'ear', name: 'Ear Trainer' } } }, text), []);
});

// ── #6763: New project is pointed at only when it is showing ───────────────

const SCREENSHOT_REPLY = 'I can help. Tap New project under this reply to start it, then tell me what the app is for '
  + 'and who it is for. I will ask a couple of questions if I need to, and put a plan here for you before anything gets built.';

/** A chat turn in a private thread: the surface that offers New project. */
const threadTurn = (extra = {}) => ({ user: { id: 1 }, appIds: new Set(), newProjectOffer: false, deps: {}, ...extra });

test('#6763: "Tap New project under this reply" with no button showing is flagged, and cut', async () => {
  const turn = threadTurn();
  const found = await claims.checkReply(pool(), turn, SCREENSHOT_REPLY);
  assert.deepEqual(found.map((p) => p.kind), ['new_project']);
  const out = claims.cut(SCREENSHOT_REPLY, found, turn);
  assert.equal(out, 'I can help. I will ask a couple of questions if I need to, and put a plan here for you before anything gets built.');
  assert.doesNotMatch(out, /New project/);
  // Words that only mention an idea are not a pointer at the button.
  assert.deepEqual(await kinds(pool(), turn, 'That could be a new project of its own.'), []);
  assert.deepEqual(await kinds(pool(), turn, 'Your new project on Home is where it goes.'), []);
  // A leftover "New project" sentence goes with the false one.
  const more = 'Tap New project below. The New project button asks what it should do. The rest is up to you.';
  assert.equal(claims.cut(more, await claims.checkReply(pool(), turn, more), turn), 'The rest is up to you.');
});

test('#6763: a turn that offers New project, or a thread whose foot shows it, backs the pointer', async () => {
  assert.deepEqual(await kinds(pool(), threadTurn({ newProjectOffer: true }), SCREENSHOT_REPLY), []);
  // The thread the bot opened for a new project: its root carries the door.
  assert.deepEqual(await kinds(pool(), threadTurn({ deps: { threadDraft: { kind: 'ask', changeKind: 'project' } } }), SCREENSHOT_REPLY), []);
  // A thread with a drawn screen for no project yet: the B04 door.
  assert.deepEqual(await kinds(pool(), threadTurn({ deps: { threadDesign: { title: 'x', app: null } } }), SCREENSHOT_REPLY), []);
  // A drawn screen of a project that exists has no New project, so it does not.
  assert.deepEqual(await kinds(pool(), threadTurn({ deps: { threadDesign: { title: 'x', app: { slug: 'notes' } } } }), SCREENSHOT_REPLY), ['new_project']);
  // Another thread the bot opened (a draft's, a first version's) shows no door either.
  assert.deepEqual(await kinds(pool(), threadTurn({ deps: { threadDraft: { kind: 'draft_request', state: 'open', appSlug: 'notes' } } }), SCREENSHOT_REPLY), ['new_project']);
  // The design bot's turn carries no newProjectOffer: its replies are left as they are.
  assert.deepEqual(await kinds(pool(), { user: { id: 1 }, appIds: new Set(), deps: {} }, SCREENSHOT_REPLY), []);
});

test('#6783: words that point at the New project card below are kept with the offer, and cut without it', async () => {
  const cardWords = 'Check the name and what it will do below, then Make it.';
  assert.deepEqual(await kinds(pool(), threadTurn({ newProjectOffer: true }), cardWords), []);
  assert.deepEqual(await kinds(pool(), threadTurn(), cardWords), ['new_project']);
  assert.equal(claims.cut(cardWords, await claims.checkReply(pool(), threadTurn(), cardWords), threadTurn()), '');
  // The card named plainly: "the card below", "under this reply".
  for (const words of [
    'The card below has the name and what it does.',
    'The card under this reply makes it.',
  ]) {
    assert.deepEqual(await kinds(pool(), threadTurn(), words), ['new_project'], words);
    assert.deepEqual(await kinds(pool(), threadTurn({ newProjectOffer: true }), words), [], words);
  }
  // Without a pointer at the card, an ordinary sentence is left alone.
  assert.deepEqual(await kinds(pool(), threadTurn(), 'Here is what the project would do, in your words.'), []);
});

test('#6763: the repair note asks for the offer, or says not to mention it', () => {
  const problems = [{ kind: 'new_project', said: 'points at a New project button under it' }];
  const withTool = claims.repairNote(problems, { tools: new Set(['reply', 'offer_new_project']) });
  assert.match(withTool, /call offer_new_project now, then reply/);
  assert.match(withTool, /otherwise ask what the app is for and do not mention New project\./);
  const without = claims.repairNote(problems, { tools: new Set(['reply', 'offer_request']) });
  assert.doesNotMatch(without, /offer_new_project/);
  assert.match(without, /Do not mention New project\./);
  for (const note of [withTool, without]) {
    assert.doesNotMatch(note, /—/);
    assert.doesNotMatch(note, /retract/i);
  }
});

// ── #6784: the plan in the reply, not a line of it, is what is offered ─────

const PLAN_REPLY = [
  'Here is the plan as it now stands, with your answers kept.',
  '- Home page: popular public lists, ranked by how many people saved them',
  '- Lists: public or private, who can see each',
  '- Adding places: search, results on a real map, tap one to add it',
  '- Sharing: invite link with a role, or by username; viewer and editor',
].join('\n');

test('#6784: a one-line idea beside a longer plan is asked for again with the whole plan', async () => {
  const turn = threadTurn({ newProjectOffer: true, newProjectBrief: { idea: 'An app for collecting saved places into lists on a real map.' } });
  const found = await claims.checkReply(pool(), turn, PLAN_REPLY);
  assert.deepEqual(found.map((p) => p.kind), ['short_brief']);
  const note = claims.repairNote(found, { tools: new Set(['reply', 'offer_new_project']) });
  assert.match(note, /Your offer_new_project idea is shorter than the plan in your reply\. Call offer_new_project again with idea holding every point of the plan and every answer they gave, as bullets, then reply\./);
  assert.doesNotMatch(note, /—/);
  // The bullets are harmless in the reply: nothing is cut for this.
  assert.equal(claims.cut(PLAN_REPLY, found, turn), PLAN_REPLY);
});

test('#6784: a bullet idea, or a short idea with a short reply, is no problem', async () => {
  const full = ['- Home page: popular lists', '- Lists: public or private', '- Sharing: by invite link', '- First version: the whole loop'].join('\n');
  assert.deepEqual(await kinds(pool(), threadTurn({ newProjectBrief: { idea: full } }), PLAN_REPLY), []);
  assert.deepEqual(await kinds(pool(), threadTurn({ newProjectBrief: { idea: 'A small app for lists.' } }), 'Here is the plan:\n- Lists'), []);
  assert.deepEqual(await kinds(pool(), threadTurn({}), PLAN_REPLY), [], 'no idea, nothing to compare');
  assert.equal(claims.briefShortOfPlan('', PLAN_REPLY), false);
  assert.equal(claims.briefShortOfPlan('A line', PLAN_REPLY), true);
});

// ── 20 Nov 2026 (live-draft review, A): how a draft's preview looks ────────

test('A: in a draft turn, "it is fixed" or how the preview looks now needs a look after the last save', () => {
  const found = (text, turn) => claims.check(claims.mentions(text), { turn }).map((p) => p.kind);
  const saved = { liveDraft: true, draftSaved: true };
  for (const said of [
    'It\'s fixed.', 'The delete button is fixed now.', 'Fixed: the delete button now sits on the right.', 'That is sorted.',
    'The delete button now sits on the right of each row.', 'It looks right now.', 'The header now shows the date.', 'All fixed!',
  ]) {
    assert.deepEqual(found(said, saved), ['draft_looks'], said);
    assert.deepEqual(found(said, { ...saved, draftLooked: true }), [], `${said} (looked)`);
  }
  // What it expects, the app running again (what the apply said), and an
  // earlier change are no such claim.
  for (const said of [
    'The change is applied: I expect the delete button to sit at the right of each row.', 'It should now sit on the right.',
    'It\'ll now show the date.', 'Fixed: the app is running again.', 'The bug was fixed in an earlier save.',
  ]) {
    assert.deepEqual(found(said, saved), [], said);
  }
  assert.deepEqual(found('It\'s fixed.', {}), [], 'only a draft turn');
});

test('A: the repair note asks for a look where the turn has one, and the cut keeps what it expects', () => {
  const problem = [{ kind: 'draft_looks', said: 'says it is fixed or how the preview looks now, without looking at it since your last save' }];
  const withLook = claims.repairNote(problem, { tools: new Set(['reply', 'apply_changes', 'look_at_preview']) });
  assert.match(withLook, /Look with look_at_preview, then say what it shows; if you cannot look, say the change is applied and what you expect it to show, in those words\./);
  const without = claims.repairNote(problem, { tools: new Set(['reply']) });
  assert.doesNotMatch(without, /look_at_preview/);
  assert.match(without, /say the change is applied and what you expect it to show, never that it is fixed/);
  for (const note of [withLook, without]) assert.doesNotMatch(note, /—/);
  const text = 'It\'s fixed: the delete button now sits on the right. I expect it to stay there on a phone too.';
  const ctx = { liveDraft: true, draftSaved: true };
  assert.equal(claims.cut(text, claims.check(claims.mentions(text), { turn: ctx }), ctx), 'I expect it to stay there on a phone too.');
});
