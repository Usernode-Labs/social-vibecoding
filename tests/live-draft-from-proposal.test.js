'use strict';

// 24 Nov 2026: a live draft can start from a proposal up for a vote instead
// of from main (src/services/live-drafts.js open, proposalStart). On the
// person's own proposal the draft is on it from the start, and Update
// proposal moves it; on someone else's it builds on it, and its Propose is
// the person's own proposal stacked on that one. What the chat's turn is told
// (src/services/homeroom-bot-mayor.js open_app_preview, draftThreadLines;
// src/services/private-threads.js aboutContext; src/services/live-draft-bot.js
// draftPrompt) says which. The database half runs in
// tests/live-drafts-postgres.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');

const liveDrafts = require('../src/services/live-drafts');
const mayor = require('../src/services/homeroom-bot-mayor');
const draftBot = require('../src/services/live-draft-bot');
const privateThreads = require('../src/services/private-threads');

const APP = { id: 21, slug: 'gym', name: 'Gym Tracker', repo_url: 'https://github.com/acme/gym' };
const ME = { id: 7 };
const proposal = (extra = {}) => ({
  id: 50, app_id: 21, user_id: 7, status: 'promoted', pr_number: 142, branch_name: 'dev/evan-142', source: null,
  imported_pr_head_repo: null, is_headless: false, ...extra,
});

test('proposalStart: this project\'s proposal up for a vote, the person\'s own or someone else\'s', () => {
  assert.deepEqual(liveDrafts.proposalStart(proposal(), { app: APP, user: ME }), { ok: true, own: true });
  assert.deepEqual(liveDrafts.proposalStart(proposal({ user_id: 8 }), { app: APP, user: ME }), { ok: true, own: false });
  // A connector's proposal mirrored into the project's own repository is a branch here too.
  assert.deepEqual(liveDrafts.proposalStart(proposal({ source: 'imported', imported_pr_head_repo: 'acme/gym', branch_name: 'usernode/from-x' }),
    { app: APP, user: ME }), { ok: true, own: true });
});

test('proposalStart: refused, in plain words, for anything a draft cannot start from', () => {
  const why = (row) => {
    const out = liveDrafts.proposalStart(row, { app: APP, user: ME });
    assert.equal(out.ok, false);
    return [out.status, out.code, out.message];
  };
  assert.deepEqual(why(null).slice(0, 2), [404, 'no_proposal']);
  assert.deepEqual(why(proposal({ is_headless: true })).slice(0, 2), [404, 'no_proposal']);
  assert.deepEqual(why(proposal({ app_id: 22 })), [409, 'other_project',
    'That proposal is on another project. A draft here starts only from this project\'s proposals.']);
  assert.deepEqual(why(proposal({ status: 'merging' })), [409, 'not_up_for_vote',
    'That proposal passed its vote and is going live, so a draft cannot start from it now.']);
  assert.match(why(proposal({ status: 'merged' }))[2], /already went live/);
  for (const status of ['closed', 'archived', 'abandoned', 'rejected']) {
    assert.deepEqual(why(proposal({ status })), [409, 'not_up_for_vote', 'That proposal was withdrawn, so a draft cannot start from it.'], status);
  }
  for (const row of [proposal({ status: 'paused' }), proposal({ status: 'active' }), proposal({ pr_number: null })]) {
    assert.deepEqual(why(row), [409, 'not_up_for_vote', 'That change is not up for a vote yet, so a draft cannot start from it.']);
  }
  // Its code in its author's own fork: there is no branch here to start from.
  assert.deepEqual(why(proposal({ source: 'imported', imported_pr_head_repo: 'someone/gym' })), [409, 'not_in_app_repo',
    'That proposal\'s code is in its author\'s own fork, so a draft cannot start from it.']);
  assert.equal(why(proposal({ branch_name: '' }))[1], 'not_in_app_repo');
  for (const [, , message] of [why(proposal({ app_id: 22 })), why(proposal({ status: 'merged' }))]) assert.doesNotMatch(message, /—/);
});

const draftRow = (extra = {}) => ({
  id: 4, user_id: 7, root_message_id: 9, session_id: 5, state: 'open', app_slug: 'gym', app_name: 'Gym Tracker',
  edits: 0, live_state: 'live', head_sha: 'c'.repeat(40), ...extra,
});
const onTheirs = (extra = {}) => draftRow({
  built_on_session_id: 60, built_on_status: 'promoted', built_on_pr_number: 320, built_on_branch: 'dev/sam-320', built_on_user_id: 8, ...extra,
});
const onMine = (extra = {}) => draftRow({
  state: 'proposed', built_on_session_id: 50, proposal_session_id: 50, built_on_status: 'promoted', built_on_pr_number: 142,
  proposal_status: 'promoted', proposal_pr_number: 142, built_on_branch: 'dev/evan-142', built_on_user_id: 7, pending_edits: 0, ...extra,
});

test('describe names what a draft builds on, and whether it is on that proposal', () => {
  assert.equal(liveDrafts.describe(draftRow()).builtOn, null, 'a draft from main');
  assert.deepEqual(liveDrafts.describe(onTheirs()).builtOn, { sessionId: 60, prNumber: 320, open: true, merged: false, linked: false });
  assert.deepEqual(liveDrafts.describe(onTheirs({ built_on_status: 'merged' })).builtOn, { sessionId: 60, prNumber: 320, open: false, merged: true, linked: false });
  const mine = liveDrafts.describe(onMine());
  assert.deepEqual(mine.builtOn, { sessionId: 50, prNumber: 142, open: true, merged: false, linked: true });
  assert.deepEqual([mine.state, mine.editable, mine.prNumber, mine.proposal.sessionId, mine.proposal.open], ['proposed', true, 142, 50, true]);
});

test('stackOf: a draft on someone else\'s open proposal is proposed stacked on it, else against main', () => {
  assert.equal(liveDrafts.stackOf(draftRow()), null, 'from main');
  assert.equal(liveDrafts.stackOf(onMine()), null, 'on their own proposal, which Update proposal moves instead');
  assert.deepEqual(liveDrafts.stackOf(onTheirs()), { prNumber: 320, stack: { sessionId: 60, branch: 'dev/sam-320' }, ended: null });
  // An open change that went back to being built is still one a change can stack on (rules/pr-base.ts).
  assert.equal(liveDrafts.stackOf(onTheirs({ built_on_status: 'paused' })).stack.sessionId, 60);
  assert.deepEqual(liveDrafts.stackOf(onTheirs({ built_on_status: 'merged' })), { prNumber: 320, stack: null, ended: 'merged' });
  assert.deepEqual(liveDrafts.stackOf(onTheirs({ built_on_status: 'closed' })), { prNumber: 320, stack: null, ended: 'withdrawn' });
  // Its proposal's words say what it went in on.
  const edits = [{ summary: 'Sort by date' }];
  assert.match(liveDrafts.proposalText(onTheirs(), edits), /\n\nBuilt on PR #320: this proposal holds only the changes below, and goes in after PR #320 does\.\n\nWhat changed:\n- Sort by date$/);
  assert.match(liveDrafts.proposalText(onTheirs({ built_on_status: 'merged' }), edits), /Started from PR #320, which has gone live since\./);
  assert.match(liveDrafts.proposalText(onTheirs({ built_on_status: 'closed' }), edits), /Started from PR #320, which was withdrawn: this proposal also carries PR #320's changes\./);
  assert.equal(liveDrafts.proposalText(draftRow(), edits), 'Made with Homeroom bot in a live app preview of Gym Tracker.\n\nWhat changed:\n- Sort by date');
});

test('a draft on their own proposal with no edits idles out; one with edits, and one whose proposal ended, as before', () => {
  const then = new Date(Date.now() - liveDrafts.IDLE_CLOSE_MS - 60_000);
  const old = { updated_at: then, created_at: then };
  assert.equal(liveDrafts.closeReason(onMine(old)), 'idle');
  assert.equal(liveDrafts.closeReason(onMine({ ...old, edits: 1 })), null);
  assert.equal(liveDrafts.closeReason(onMine({ ...old, proposal_status: 'merged' })), 'proposal_merged');
  assert.equal(liveDrafts.closeReason(onMine({ proposal_status: 'closed' })), 'proposal_ended');
  assert.equal(liveDrafts.closeReason(onMine()), null, 'touched lately');
  // A draft built on someone else's proposal does not close when that one ends: its edits are the person's.
  assert.equal(liveDrafts.closeReason(onTheirs({ built_on_status: 'closed', edits: 2 })), null);
});

// ── Homeroom bot ────────────────────────────────────────────────────────

test('open_app_preview takes a PR number on the thread\'s project, never a session id', () => {
  const tool = mayor.TOOLS.find((t) => t.function.name === 'open_app_preview').function;
  assert.deepEqual(Object.keys(tool.parameters.properties), ['project', 'proposal']);
  assert.equal(tool.parameters.properties.proposal.type, 'integer');
  assert.match(tool.parameters.properties.proposal.description, /PR number of a proposal up for a vote on this project/);
  assert.match(tool.description, /on their own proposal, the draft is on it, and Update proposal moves it to the draft and clears its votes/);
  assert.match(tool.description, /on someone else's, the draft builds on it, that proposal is never changed, and their Propose is a new proposal of their own built on it/);
  assert.doesNotMatch(tool.description, /—/);
  assert.equal(mayor.previewProposalArg(undefined), null);
  assert.equal(mayor.previewProposalArg(''), null);
  for (const v of [142, '142', '#142', 'PR #142', 'pr 142']) assert.equal(mayor.previewProposalArg(v), 142, String(v));
  for (const v of ['x', 0, -3, 1.5, 'PR #']) assert.match(mayor.previewProposalArg(v).error, /PR number on this project/, String(v));
});

function previewCtx({ answer, appId = 21 } = {}) {
  const asked = [];
  const pool = {
    async query(sql) {
      if (/FROM private_threads WHERE root_message_id/.test(sql)) return { rows: [{ id: 4, app_id: appId }] };
      return { rows: [] };
    },
  };
  const ctx = {
    user: { id: 7, username: 'evan' }, config: {},
    loadDraft: async () => ({ ok: true }),
    deps: { threadRootId: 9, liveDrafts: { open: async (_p, _c, args) => { asked.push(args); return answer; } } },
  };
  return { pool, ctx, asked };
}
const opened = (draft, extra = {}) => ({ status: 200, body: { ok: true, draft: { id: 3, ...draft }, reused: false, ...extra } });

test('open_app_preview hands the PR number to live drafts, which reads it in the thread\'s project', async () => {
  const mine = previewCtx({ answer: opened({ state: 'proposed', builtOn: { prNumber: 142, linked: true }, proposal: { prNumber: 142 } }) });
  const out = await mayor.openAppPreview(mine.pool, mine.ctx, { proposal: '#142' });
  assert.equal(out.ok, true);
  assert.deepEqual(mine.asked.map((a) => [a.rootId, a.proposalNumber, a.proposalSessionId]), [[9, 142, undefined]]);
  assert.match(out.note, /^This draft is on PR #142, their own proposal up for a vote: it starts from its code\./);
  assert.match(out.note, /it reaches PR #142 only when they tap Update proposal, which clears its votes and runs its checks again\. Say that once\./);
  assert.match(out.note, /the draft's tools are yours\s+for the rest of this turn/);

  const theirs = previewCtx({ answer: opened({ state: 'open', builtOn: { prNumber: 320, linked: false } }, { replaced: { id: 2, builtOn: null } }) });
  const built = await mayor.openAppPreview(theirs.pool, theirs.ctx, { proposal: 320 });
  assert.match(built.note, /^This thread's draft from main had no changes, so it was closed for this one: say so in a few words\./);
  assert.match(built.note, /This draft builds on PR #320, someone else's proposal: it starts from that code as it is now, and nothing done here changes PR #320\./);
  assert.match(built.note, /their own, built on PR #320, so its vote sees only the changes made here/);
  for (const note of [out.note, built.note]) assert.doesNotMatch(note, /—/);

  // From main, as before: no proposal named, none asked for.
  const plain = previewCtx({ answer: opened({ state: 'open', builtOn: null }) });
  const fromMain = await mayor.openAppPreview(plain.pool, plain.ctx, {});
  assert.equal(plain.asked[0].proposalNumber, undefined);
  assert.match(fromMain.note, /^The live preview opens beside the chat now/);

  // A bad number is asked about, and nothing is opened.
  const bad = previewCtx({ answer: opened({}) });
  assert.match((await mayor.openAppPreview(bad.pool, bad.ctx, { proposal: 'the blue one' })).error, /Ask which proposal they mean/);
  assert.equal(bad.asked.length, 0);

  // A refusal is said in its own words.
  const refused = previewCtx({ answer: { status: 409, body: { ok: false, error: 'draft_open', message: 'This thread\'s draft has changes of its own. Propose or discard it first.' } } });
  assert.deepEqual(await mayor.openAppPreview(refused.pool, refused.ctx, { proposal: 142 }),
    { ok: false, error: 'This thread\'s draft has changes of its own. Propose or discard it first.' });
});

test('the turn is told what a thread\'s draft builds on, and what its Propose will be', () => {
  const open = mayor.draftThreadLines(onTheirs()).join('\n');
  assert.match(open, /This draft builds on PR #320, someone else's proposal: it started from PR #320's code as it was then, not from main,/);
  assert.match(open, /nothing done in it changes PR #320\. Later changes to PR #320 are not in it\./);
  assert.match(open, /Their Propose makes a proposal of their own built on PR #320: its vote sees only the changes made here/);
  assert.match(mayor.draftThreadLines(onTheirs({ built_on_status: 'merged' })).join('\n'), /PR #320 has gone live since, so their Propose goes against main\./);
  assert.match(mayor.draftThreadLines(onTheirs({ built_on_status: 'closed' })).join('\n'),
    /PR #320 was withdrawn, so a proposal from this draft would carry PR #320's changes too\. Say so before they propose it\./);
  // Proposed since: the proposal lines say the rest, and nothing about its Propose.
  const up = mayor.draftThreadLines(onTheirs({ state: 'proposed', proposal_session_id: 70, proposal_pr_number: 400, pending_edits: 0 })).join('\n');
  assert.match(up, /up for a vote as PR #400/);
  assert.match(up, /builds on PR #320/);
  assert.doesNotMatch(up, /Their Propose/);
  // On their own proposal: it started there, and Update proposal is the way in.
  const mine = mayor.draftThreadLines(onMine()).join('\n');
  assert.match(mine, /This draft is up for a vote as PR #142/);
  assert.match(mine, /This draft started from PR #142 itself, their own proposal, not from main\./);
  assert.deepEqual(mayor.builtOnLines(draftRow()), [], 'a draft from main says nothing new');
  for (const lines of [open, up, mine]) assert.doesNotMatch(lines, /—/);
});

test('Propose\'s card and its answer say what a draft built on someone else\'s proposal goes in on', async () => {
  assert.equal(mayor.builtOnWords(null), '');
  assert.equal(mayor.builtOnWords({ prNumber: 320, stacked: true, ended: null }),
    ' It is built on PR #320, so its vote sees only these changes, and it goes in after PR #320 does.');
  assert.equal(mayor.builtOnWords(liveDrafts.stackOf(onTheirs())), mayor.builtOnWords({ prNumber: 320, stacked: true }));
  assert.equal(mayor.builtOnWords({ prNumber: 320, stacked: false, ended: 'merged' }), ' PR #320 has gone live since, so it goes against main.');
  assert.equal(mayor.builtOnWords({ prNumber: 320, stacked: false, ended: 'withdrawn' }), ' PR #320 was withdrawn, so it carries PR #320\'s changes too.');

  // The card.
  const row = onTheirs({ app_id: 21, edits: 2 });
  const ctx = {
    user: { id: 7, username: 'evan' }, appIds: new Set(), caps: { draft: { draft: { id: 4 } } },
    deps: {
      liveDrafts: {
        byId: async () => row, editable: liveDrafts.editable, proposalOpen: liveDrafts.proposalOpen, editsOf: async () => [{ summary: 'Sort by date' }],
      },
      communities: { appNeedsJoin: async () => null },
    },
  };
  assert.equal((await mayor.offerProposeDraft({}, ctx, {})).offered, 'Propose');
  assert.equal(ctx.offer.details,
    '2 changes. The project\'s group votes on it, and this draft stays open here for more. It is built on PR #320, so its vote sees only these changes, and it goes in after PR #320 does.');

  // The tap's answer.
  const pool = { query: async (sql) => (/FROM users/.test(sql) ? { rows: [{ is_admin: false, admin_readonly: false }] } : { rows: [] }) };
  const answer = { status: 200, body: { ok: true, draft: { app: { name: 'Gym Tracker' }, proposal: { sessionId: 70, prNumber: null } }, builtOn: { prNumber: 320, stacked: true, ended: null } } };
  const out = await mayor.decideDraftProposal(pool, {}, {
    user: { id: 7, username: 'evan' }, action: { id: 77, kind: 'propose_draft', app_id: 21, args: { draftId: 4 } }, yes: true,
    deps: { liveDrafts: { propose: async () => answer } }, ack: (content) => ({ content }),
  });
  assert.equal(out.content, 'Done. It is going up for a vote on Gym Tracker. It is built on PR #320, so its vote sees only these changes, and it goes in after PR #320 does. The draft stays open here: a change you make now reaches the proposal when you tap Update proposal.');
});

test('the draft\'s prompt says where it started, and read_file `at` reads that start by its name', () => {
  assert.equal(draftBot.startLine(draftRow()), 'This draft started from main.');
  assert.equal(draftBot.startLine(onMine()), 'This draft started from PR #142, their own proposal up for a vote, and is on it: Update proposal moves PR #142 to what you save.');
  assert.equal(draftBot.startLine(onTheirs()), 'This draft started from PR #320, someone else\'s proposal, and builds on it: nothing you save changes PR #320.');
  const prompt = draftBot.draftPrompt({ username: 'evan', draft: onTheirs(), edits: [], files: [], notes: null });
  assert.match(prompt, /in a live draft, with the draft tools\.\nThis draft started from PR #320, someone else's proposal/);
  assert.match(prompt, /A draft starts from main, or from a proposal up for a vote \(the line above these rules says which\)\./);
  assert.match(prompt, /On their own proposal, what you save reaches it only when they tap Update proposal, which clears its votes/);
  const C = 'c'.repeat(40);
  assert.deepEqual(draftBot.resolveAt('main', { draft: onTheirs({ base_sha: C }) }),
    { sha: C, label: 'PR #320 as this draft started from it, before this draft changed anything' });
  assert.deepEqual(draftBot.resolveAt('start', { draft: { base_sha: C } }), { sha: C, label: 'main, before this draft changed anything' });
});

test('a thread about a change up for a vote is told a draft can start from it, and which kind', () => {
  const own = privateThreads.draftOnChangeLines({ own: true, number: 142 }).join('\n');
  assert.match(own, /It is their own proposal\. When they want to try it or change it before the vote, open_app_preview with proposal\s+142 opens a live draft on it/);
  assert.match(own, /reaches PR #142 when they tap Update proposal,\s+which clears its votes and runs its checks again/);
  const theirs = privateThreads.draftOnChangeLines({ own: false, number: 320 }).join('\n');
  assert.match(theirs, /It is someone else's proposal\. When they want to try it or build on it, open_app_preview with proposal\s+320 opens a live draft built on it: PR #320 itself is never changed/);
  for (const lines of [own, theirs]) assert.doesNotMatch(lines, /—/);
  // Only while it is up for a vote.
  const src = require('node:fs').readFileSync(require.resolve('../src/services/private-threads'), 'utf8');
  assert.match(src, /\.\.\.\(c\.status === 'promoted' \? draftOnChangeLines\(\{ own: Number\(c\.user_id\) === Number\(user\?\.id\), number: n \}\) : \[\]\),/);
});

test('the new column is a migration of its own that only adds it, nullable', () => {
  const fs = require('node:fs');
  const sql = fs.readFileSync(require.resolve('../src/db/migrations/live-drafts-built-on.sql'), 'utf8');
  const statements = sql.split('\n').filter((l) => l.trim() && !l.trim().startsWith('--')).join(' ');
  assert.equal(statements.replace(/\s+/g, ' ').trim(),
    'ALTER TABLE live_drafts ADD COLUMN IF NOT EXISTS built_on_session_id INTEGER REFERENCES chat_sessions(id) ON DELETE SET NULL;');
  const manifest = JSON.parse(fs.readFileSync(require.resolve('../src/db/migrations/manifest.json'), 'utf8'));
  assert.ok(manifest.migrations.some((m) => m.id === 'live-drafts-built-on'));
});
