'use strict';

// 20 Nov 2026 (live-draft review, C): what the chat's turn is told about a
// live draft that is up for a vote (homeroom-bot-mayor.js draftThreadLines),
// and about a thread that holds both an artifact and a draft: which is
// which, which one is open on their screen, and that a change after Propose
// reaches the proposal only through Update proposal.

const test = require('node:test');
const assert = require('node:assert/strict');

const mayor = require('../src/services/homeroom-bot-mayor');
const liveDrafts = require('../src/services/live-drafts');

const open = { id: 4, state: 'open', app_name: 'Gym Tracker', app_slug: 'gym' };
const proposed = { ...open, state: 'proposed', proposal_session_id: 50, proposal_pr_number: 142, pending_edits: 2 };

test('an open draft is told as before', () => {
  const lines = mayor.draftThreadLines(open).join('\n');
  assert.match(lines, /A live draft of Gym Tracker is open beside this thread/);
  assert.doesNotMatch(lines, /up for a vote|Update proposal/);
});

test('a proposed draft is still this thread\'s draft: changes go into it, and reach the proposal only by Update proposal', () => {
  const lines = mayor.draftThreadLines(proposed).join('\n');
  assert.match(lines, /up for a vote as PR #142/);
  assert.match(lines, /never into an artifact and never as a\s+new draft/);
  assert.match(lines, /tap Update proposal in the preview's header, which clears the proposal's votes/);
  assert.match(lines, /Say that once/);
  assert.match(lines, /You never update or propose it\s+yourself/);
  assert.match(lines, /2 changes are not in the proposal yet/);
  assert.match(mayor.draftThreadLines({ ...proposed, pending_edits: 0 }).join('\n'), /every change in the draft so far/);
  // A draft proposed before this (its own session was the proposal) is not one.
  assert.equal(liveDrafts.editable({ state: 'proposed', proposal_session_id: null }), false);
  assert.equal(liveDrafts.editable(proposed), true);
});

test('a thread with an artifact and a draft says which is which, and which is open', () => {
  const design = { title: 'Gym Tracker style directions' };
  const both = mayor.draftThreadLines(proposed, { design }).join('\n');
  assert.match(both, /also holds an artifact, "Gym Tracker style directions": a page you wrote, not the app/);
  assert.match(both, /names which one it changed/);
  assert.doesNotMatch(both, /open beside the chat now:/, 'nothing said about what is open when the screen did not say');
  assert.match(mayor.draftThreadLines(proposed, { design, showing: { liveDraftId: 4 } }).join('\n'),
    /They have the app's live preview open beside the chat now/);
  assert.match(mayor.draftThreadLines(proposed, { design, showing: { artifactId: 9 } }).join('\n'),
    /They have the artifact "Gym Tracker style directions" open/);
});

test('describe says the proposal and how many changes are not in it yet', () => {
  const d = liveDrafts.describe({
    ...proposed, root_message_id: 9, session_id: 5, edits: 5, head_sha: 'c'.repeat(40), proposed_head_sha: 'a'.repeat(40),
    proposal_status: 'promoted', live_state: 'live',
  });
  assert.deepEqual(d.proposal, { sessionId: 50, prNumber: 142, open: true, pending: 2, headSha: 'a'.repeat(40) });
  assert.deepEqual([d.state, d.editable, d.prNumber], ['proposed', true, 142]);
  assert.equal(liveDrafts.describe({ ...proposed, root_message_id: 9, proposal_status: 'merged' }).proposal.open, false);
});

// ── 20 Nov 2026 (live-draft review, C): Propose and Update proposal as a card ──
//
// The bot offers the tap under its reply (offer_propose_draft); only the tap
// proposes or updates (decideDraftProposal), every gate read again then.

test('the turn is told it can offer the tap, and that it never does it itself', () => {
  const opened = mayor.draftThreadLines(open).join('\n');
  assert.match(opened, /offer_propose_draft puts Propose under your reply\. Only\s+their tap proposes it: you never propose it yourself/);
  assert.match(opened, /never offer to change a proposal any other way/);
  const up = mayor.draftThreadLines(proposed).join('\n');
  assert.match(up, /When they want PR #142 to have the changes, offer_propose_draft puts Update proposal under your reply/);
  assert.match(up, /Only their tap updates it\. Never offer to change a proposal any other way\./);
  // Clearing the votes is said once, as before.
  assert.equal((up.match(/clears the proposal's votes/g) || []).length, 1);
  for (const lines of [opened, up]) assert.doesNotMatch(lines, /—/);
});

/** The draft capability as a turn holds it, and a draft store answering `row`. */
function offerCtx(row, { join = null, edits = [{ summary: 'Bigger delete button' }] } = {}) {
  return {
    user: { id: 7, username: 'evan' }, appIds: new Set(), caps: { draft: { draft: { id: row.id } } },
    deps: {
      liveDrafts: {
        byId: async (_pool, id, { userId }) => (Number(id) === row.id && userId === 7 ? row : null),
        editable: liveDrafts.editable, proposalOpen: liveDrafts.proposalOpen, editsOf: async () => edits,
      },
      communities: { appNeedsJoin: async () => join },
    },
  };
}
const draftRow = { id: 4, app_id: 31, app_slug: 'gym', app_name: 'Gym Tracker', user_id: 7, state: 'open', edits: 3 };

test('offer_propose_draft: Propose for an open draft with changes, its card naming the draft', async () => {
  const ctx = offerCtx(draftRow);
  const out = await mayor.offerProposeDraft({}, ctx, { title: 'Bigger, clearer delete button' });
  assert.equal(out.ok, true);
  assert.equal(out.offered, 'Propose');
  assert.match(out.shown, /Nothing is proposed until they tap Propose: never say it was proposed\./);
  assert.deepEqual(
    { kind: ctx.offer.kind, draftId: ctx.offer.draftId, title: ctx.offer.title, app: ctx.offer.app },
    { kind: 'propose_draft', draftId: 4, title: 'Bigger, clearer delete button', app: { id: 31, slug: 'gym', name: 'Gym Tracker' } },
  );
  assert.equal(ctx.offer.proposeTitle, 'Bigger, clearer delete button', 'the title they gave is the vote\'s');
  assert.ok(ctx.appIds.has(31));
  // Without a title, the card shows the latest change's summary, and Propose names it at the tap.
  const plain = offerCtx(draftRow);
  await mayor.offerProposeDraft({}, plain, {});
  assert.equal(plain.offer.title, 'Bigger delete button');
  assert.equal(plain.offer.proposeTitle, null);
  // The same offer twice is one card.
  assert.equal((await mayor.offerProposeDraft({}, ctx, { title: 'Bigger, clearer delete button' })).ok, false);
  assert.equal(mayor.draftOfferText({ name: 'Gym Tracker', offer: ctx.offer }),
    'Want to put this draft of Gym Tracker to the vote?\n\n**Gym Tracker** · a proposal from this draft: Bigger, clearer delete button\n\n'
    + '3 changes. The project\'s group votes on it, and this draft stays open here for more.');
});

test('offer_propose_draft: Update proposal for a draft up for a vote with changes not in it', async () => {
  const row = { ...draftRow, ...proposed, id: 4, edits: 5, proposal_status: 'promoted' };
  const ctx = offerCtx(row);
  const out = await mayor.offerProposeDraft({}, ctx, {});
  assert.equal(out.offered, 'Update proposal');
  assert.match(out.shown, /which clears PR #142's votes and runs its checks again: say that once, and never say it was updated\./);
  assert.deepEqual([ctx.offer.kind, ctx.offer.prNumber, ctx.offer.proposalSessionId, ctx.offer.title],
    ['update_draft_proposal', 142, 50, '2 changes not in it yet']);
  assert.equal(mayor.draftOfferText({ name: 'Gym Tracker', text: 'Ready when you are.', offer: ctx.offer }),
    'Ready when you are.\n\n**Gym Tracker** · PR #142: 2 changes not in it yet\n\nUpdating it clears its votes and runs its checks again.');
});

test('offer_propose_draft: no card it could not keep', async () => {
  const refused = async (row, opts, ctxExtra = {}) => {
    const ctx = { ...offerCtx(row, opts), ...ctxExtra };
    const out = await mayor.offerProposeDraft({}, ctx, {});
    assert.equal(out.ok, false);
    assert.equal(ctx.offer, undefined, 'nothing under the reply');
    return out.error;
  };
  assert.match(await refused({ ...draftRow, edits: 0 }), /Nothing has changed in the draft yet/);
  assert.match(await refused({ ...draftRow, ...proposed, id: 4, proposal_status: 'promoted', pending_edits: 0 }),
    /PR #142 already has every change in the draft/);
  assert.match(await refused({ ...draftRow, ...proposed, id: 4, proposal_status: 'merging' }), /cannot be updated right now/);
  assert.match(await refused({ ...draftRow, ...proposed, id: 4, proposal_status: 'merged' }), /proposal is over/);
  assert.match(await refused({ ...draftRow, state: 'closed' }), /draft is closed/);
  assert.match(await refused(draftRow, { join: { code: 'join_required' } }), /They need to join Gym Tracker/);
  assert.match(await refused(draftRow, {}, { caps: { draft: null } }), /No live draft is open in this thread/);
  // Never someone else's draft: the store is read as this person.
  assert.match(await refused(draftRow, {}, { user: { id: 8 } }), /draft is closed/);
});

/** A tap's settle, with a draft store that answers `answer` and records what it was asked. */
function tapOn(kind, answer, { actKey = null } = {}) {
  const asked = [];
  const queries = [];
  const pool = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      return /FROM users/.test(sql) ? { rows: [{ is_admin: true, admin_readonly: false }] } : { rows: [] };
    },
  };
  const deps = {
    ...(actKey ? { actKey } : {}),
    liveDrafts: {
      propose: async (_pool, _config, args) => { asked.push(['propose', args]); return answer; },
      updateProposal: async (_pool, _config, args) => { asked.push(['update', args]); return answer; },
    },
  };
  const action = { id: 77, kind, app_id: 31, args: { draftId: 4, title: 'Bigger delete button' } };
  const run = (yes = true) => mayor.decideDraftProposal(pool, {}, {
    user: { id: 7, username: 'evan', isAdmin: true }, action, yes, deps, ack: (content, extra = {}) => ({ content, extra }),
  });
  return { run, asked, queries };
}
const done = (proposal) => ({ status: 200, body: { ok: true, draft: { app: { name: 'Gym Tracker' }, proposal } } });

test('the tap proposes this thread\'s draft, as the person, with the card\'s title', async () => {
  const { run, asked } = tapOn('propose_draft', done({ sessionId: 50, prNumber: null }));
  const out = await run();
  assert.equal(asked.length, 1);
  assert.equal(asked[0][0], 'propose');
  assert.equal(asked[0][1].draftId, 4);
  assert.equal(asked[0][1].title, 'Bigger delete button');
  assert.equal(asked[0][1].user.id, 7);
  assert.equal(asked[0][1].user.canAdminWrite, true, 'a full admin proposes with an admin\'s caps, as the route does');
  assert.equal(out.content, 'Done. It is going up for a vote on Gym Tracker. The draft stays open here: a change you make now reaches the proposal when you tap Update proposal.');
  assert.deepEqual(out.extra.objects, [{ type: 'proposal', appId: 31, sessionId: 50 }]);
  // Not yet does nothing at all.
  const declined = tapOn('propose_draft', done({}));
  assert.equal((await declined.run(false)).content, 'OK, not yet. Tell me when it is ready.');
  assert.equal(declined.asked.length, 0);
  assert.equal(mayor.DECLINED_LINES.propose_draft, 'Not proposed yet.');
  assert.equal(mayor.DECLINED_LINES.update_draft_proposal, 'Not updated. The proposal stays as it is.');
});

test('the tap updates the proposal, and says its votes were cleared', async () => {
  const { run, asked } = tapOn('update_draft_proposal', done({ sessionId: 50, prNumber: 142 }));
  const out = await run();
  assert.deepEqual(asked.map(([what, args]) => [what, args.draftId]), [['update', 4]]);
  assert.equal(out.content, 'Done. PR #142 has the draft\'s changes now. Its votes were cleared and its checks run again.');
});

test('what the draft\'s gates say at the tap is what the card says', async () => {
  const refuse = (status, error, message) => ({ status, body: { ok: false, error, message } });
  // Done already (the preview's own button, or this act's first try): said as done.
  assert.equal((await tapOn('propose_draft', refuse(409, 'already_proposed', 'x')).run()).content, 'It is already up for a vote.');
  assert.equal((await tapOn('update_draft_proposal', refuse(409, 'nothing_new', 'x')).run()).content,
    'The proposal already has every change in the draft.');
  // Refused for good: the card fails with the gate's own words.
  const gone = tapOn('update_draft_proposal', refuse(409, 'proposal_over', 'That proposal is over, so its draft is closed.'));
  const out = await gone.run();
  assert.equal(out.content, 'I couldn\'t update the proposal: that proposal is over, so its draft is closed.');
  assert.equal(out.extra.failed, true);
  assert.ok(gone.queries.some((q) => /UPDATE bot_cards SET status = 'failed'/.test(q.sql) && q.params[1] === 'proposal_over'));
  const join = await tapOn('propose_draft', { status: 403, body: { code: 'join_required', app: { name: 'Gym Tracker' } } }).run();
  assert.equal(join.content, 'I couldn\'t propose it: you need to be a member of Gym Tracker first. You can join it from its page.');
  // A preview still starting is the act's work's to try again, its claim kept.
  await assert.rejects(tapOn('propose_draft', refuse(409, 'preview_building', 'x'), { actKey: 'action:77' }).run(),
    (err) => err.message === 'preview_building' && mayor.retryAct(err, 'action:77'));
  // Typed, with no work to try again, it is said.
  assert.match((await tapOn('propose_draft', refuse(409, 'preview_building', 'The preview is still being built. Propose it once it is up.')).run()).content,
    /^I couldn't propose it: the preview is still being built\./);
  // 24 Nov 2026: the preview's own Propose tapped with this card is still
  // running. Tried again, the tap ends as done or as already up for a vote;
  // with no work to try again it is said as going up, never as a failure.
  await assert.rejects(tapOn('propose_draft', refuse(409, 'proposing', 'x'), { actKey: 'action:77' }).run(),
    (err) => err.message === 'proposing' && mayor.retryAct(err, 'action:77'));
  const racing = tapOn('propose_draft', refuse(409, 'proposing', 'It is being put up for a vote right now.'));
  const said = await racing.run();
  assert.equal(said.content, 'It is going up for a vote already.');
  assert.equal(said.extra.failed, undefined);
  assert.ok(!racing.queries.some((q) => /UPDATE bot_cards SET status = 'failed'/.test(q.sql)), 'the card is not marked failed');
});

test('a plain yes typed under the card never proposes: only the tap does', () => {
  assert.ok(mayor.DRAFT_OFFER_KINDS.has('propose_draft') && mayor.DRAFT_OFFER_KINDS.has('update_draft_proposal'));
  const src = require('node:fs').readFileSync(require.resolve('../src/services/homeroom-bot-mayor'), 'utf8');
  assert.match(src, /const typable = found\.filter\(\(a\) => !DRAFT_OFFER_KINDS\.has\(a\.kind\)\);/);
  // Its buttons' words are no typed decision of their own.
  assert.equal(mayor.typedDecision('update proposal'), null);
  assert.equal(mayor.typedDecision('propose'), null);
});

test('what the reply check is told about the draft\'s proposal: its PR, and whether Update proposal is a real tap', () => {
  const caps = (draft, saved = false) => ({ caps: { draft: { draft, saved: () => saved } } });
  const up = { ...proposed, proposal_status: 'promoted' };
  // Changes the proposal lacks: the preview header's Update proposal.
  assert.deepEqual(mayor.proposalTapsOf(caps(up)), { pr: 142, update: true, propose: false });
  // Every change in it: nothing to tap, unless this turn saved one or put the card under the reply.
  assert.deepEqual(mayor.proposalTapsOf(caps({ ...up, pending_edits: 0 })), { pr: 142, update: false, propose: false });
  assert.equal(mayor.proposalTapsOf(caps({ ...up, pending_edits: 0 }, true)).update, true);
  assert.equal(mayor.proposalTapsOf({ ...caps({ ...up, pending_edits: 0 }), offer: { kind: 'update_draft_proposal' } }).update, true);
  // A proposal that went live is no tap, and an open draft has no PR.
  assert.deepEqual(mayor.proposalTapsOf(caps({ ...up, proposal_status: 'merged' })), { pr: null, update: false, propose: false });
  assert.deepEqual(mayor.proposalTapsOf({ ...caps(open), moreOffers: [{ kind: 'propose_draft' }] }), { pr: null, update: false, propose: true });
  // No draft at all: the facts are still there, so the check runs.
  assert.deepEqual(mayor.proposalTapsOf({}), { pr: null, update: false, propose: false });
});

test('the bot_cards kinds widen by a migration of their own that only adds the two', () => {
  const fs = require('node:fs');
  const sql = fs.readFileSync(require.resolve('../src/db/migrations/bot-cards-draft-offers.sql'), 'utf8');
  assert.match(sql, /'run_shots', 'post_pictures_plan', 'invite_friends', 'propose_draft', 'update_draft_proposal'\)\);/);
  const before = fs.readFileSync(require.resolve('../src/db/migrations/invite-nudges.sql'), 'utf8');
  const kinds = (text) => [...text.slice(text.lastIndexOf('CHECK (kind IN')).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  assert.deepEqual(kinds(sql), [...kinds(before), 'propose_draft', 'update_draft_proposal']);
  const manifest = JSON.parse(fs.readFileSync(require.resolve('../src/db/migrations/manifest.json'), 'utf8'));
  assert.ok(manifest.migrations.some((m) => m.id === 'bot-cards-draft-offers'));
});
