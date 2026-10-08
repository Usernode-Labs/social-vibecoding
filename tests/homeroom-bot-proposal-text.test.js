// #3518: what the Homeroom bot's proposals are called, and what they say.
//
// Every proposal the bot made was titled "Build issue 3233: Quota
// notifications are cryptic codes Edit the app…" and had no summary. The
// promote route names a pull request from the session's first request (the
// bot's "Build issue #N: <title>\n\n<plan>" seed, flattened and cut at 72)
// and leads it with the coding agent's latest description, which the bot's
// build, running outside the dev chat, never recorded.
//
// Now, just before it proposes, the bot writes both onto its session through
// the seams a person's change uses:
//   - the spec's title, which the spec prompt asks to name the change, as
//     proposed_pr_title (the author's own title, used verbatim);
//   - the build's own DESCRIPTION block (or, when it left that out, the
//     spec's "User-facing changes" half) as the completion row pr-metadata
//     reads the summary from.
// With no usable spec title the route's deterministic name is used, and
// session-title.js now peels the bot's seed, so that is the issue's title
// (tests/session-title.test.js). The same text through the real schema and
// the real pr-metadata is in tests/homeroom-bot-proposal-postgres.test.js.
//
// Run with: node --test tests/homeroom-bot-proposal-text.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const live = require('../src/services/homeroom-bot-live');
const proposalDescription = require('../src/services/proposal-description');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const BOT = { id: 77, username: 'homeroom_bot' };
const APP = { id: 9, slug: 'rss-reader-4113da', name: 'RSS', repo_url: 'https://github.com/usernode-bot/rss', self_hosted: false };
const SPEC = [
  '# Refresh feeds on their own every hour',
  '',
  '## User-facing changes',
  '',
  'Feeds update without pressing Refresh. A feed that has not changed stays where it is in the list.',
  '',
  '### Assumptions',
  '- An hour is often enough.',
  '',
  '## Technical implementation',
  '',
  'Schedule the poller in `server/poller.js`.',
].join('\n');
const DESCRIPTION = 'Your feeds now refresh by themselves every hour, so new posts appear without pressing Refresh.';
const BUILD_TEXT = [
  'Done. Committed as e1d33fa.',
  '',
  '**What changed**',
  '- server/poller.js: schedules the refresh hourly.',
  '',
  '==== DESCRIPTION ====',
  DESCRIPTION,
  '==== END DESCRIPTION ====',
].join('\n');

// ── The name ─────────────────────────────────────────────────────────────

test('the proposal is named after the spec\'s title, with the scaffolding taken off', () => {
  assert.equal(live.proposalTitle(SPEC), 'Refresh feeds on their own every hour');
  const named = (title) => live.proposalTitle(`# ${title}\n\n## User-facing changes\n\nx`);
  // The issue is in Addresses already: never in the name, at either end.
  assert.equal(named('Issue #3233: Show quota changes as a sentence'), 'Show quota changes as a sentence');
  assert.equal(named('#3233 · Show quota changes as a sentence'), 'Show quota changes as a sentence');
  assert.equal(named('Show quota changes as a sentence (#3233)'), 'Show quota changes as a sentence');
  assert.equal(named('Show quota changes as a sentence (issue #3233)'), 'Show quota changes as a sentence');
  assert.equal(named('Show quota changes as a sentence — #3233'), 'Show quota changes as a sentence');
  assert.equal(named('Build issue #3233: Show quota changes as a sentence'), 'Show quota changes as a sentence');
  // A "Spec:" label names the document, not the change.
  assert.equal(named('Spec: Show quota changes as a sentence'), 'Show quota changes as a sentence');
  assert.equal(named('Specification – Show quota changes as a sentence'), 'Show quota changes as a sentence');
  assert.equal(named('Spec for #3233: Show quota changes as a sentence'), 'Show quota changes as a sentence');
  // Markdown in a title is punctuation, and a title has no full stop.
  assert.equal(named('Show `grade_reason` beside **each** credit.'), 'Show grade_reason beside each credit');
  // Words that only start like a label are words.
  assert.equal(named('Special offers banner on the home page'), 'Special offers banner on the home page');
  assert.equal(named('Planning board columns wrap on phones'), 'Planning board columns wrap on phones');
  assert.equal(named('404 page: show a friendly message'), '404 page: show a friendly message');
});

test('a spec with no usable title leaves the name to the route', () => {
  const named = (title) => live.proposalTitle(`# ${title}\n\nbody`);
  for (const topic of ['Spec', 'Leaderboard', 'Spec for issue #12', 'Issue #12', '#12']) {
    assert.equal(named(topic), null, `${topic}: a topic or a number is not a name`);
  }
  assert.equal(live.proposalTitle('No heading here.\n\n## User-facing changes\n\nx'), null);
  assert.equal(live.proposalTitle(''), null);
  assert.equal(live.proposalTitle(null), null);
});

test('a long title is used whole or not at all: a name is never cut mid-thought', () => {
  // The prompt asks for 72; a model that runs over still wrote a whole name.
  const over = 'Show the reason a scorer gave beside each credit on the challenge page, and nowhere else';
  assert.ok(over.length > 72 && over.length <= 120);
  assert.equal(live.proposalTitle(`# ${over}\n\nx`), over);
  // Past the spec card's own bound it is prose, and the fallback names it.
  const prose = `${over}, because people asked why they scored what they did and could not find out`;
  assert.ok(prose.length > 120);
  assert.equal(live.proposalTitle(`# ${prose}\n\nx`), null);
  // The card still shows its first 120 characters, as it always did.
  assert.equal(live.specTitle(`# ${prose}\n\nx`), prose.slice(0, 120));
});

test('the spec prompt asks for a title that names the change, not the problem or the issue', () => {
  const p = live.specPrompt({ seed: 'ISSUE', buildNote: 'Edit a.js.' });
  assert.match(p, /- Titled with what the change DOES, because the proposal is named after it: the way a pull request title\n\s+reads/);
  assert.match(p, /at most 72 characters, and no issue number: the proposal links the issue on its own\./);
  // The two halves' headings are still asked for exactly as before.
  assert.match(p, /"## User-facing changes" then\n\s*"## Technical implementation"/);
});

// ── The summary ──────────────────────────────────────────────────────────

test('the spec\'s user-facing half stops at its assumptions and at the technical half', () => {
  assert.equal(live.specUserFacing(SPEC),
    'Feeds update without pressing Refresh. A feed that has not changed stays where it is in the list.');
  // No assumptions subsection: the half runs to the next H2.
  assert.equal(live.specUserFacing('# T\n\n## User-facing changes\n\n- One\n- Two\n\n### Screens\nThe list.\n\n## Technical implementation\n\nx'),
    '- One\n- Two\n\n### Screens\nThe list.');
  assert.equal(live.specUserFacing('# T\n\n## User-facing changes\n\n### Assumptions\n- x\n\n## Technical implementation\n\ny'), null,
    'only assumptions: nothing a person will see');
  assert.equal(live.specUserFacing('# T\n\n## Technical implementation\n\ny'), null);
  assert.equal(live.specUserFacing(null), null);
  const long = live.specUserFacing(`# T\n\n## User-facing changes\n\n${'word '.repeat(2000)}`);
  assert.equal(long.length, proposalDescription.DESCRIPTION_MAX, 'bounded as a description block is');
});

// First-session run-through, 4 Oct 2026: a first version's summary carried
// its spec's Design brief (accent colours as RGB triples, the kit's class
// names, "Exact words: ..."), and that was the first thing an invited
// flatmate read on the change. The brief is the build's; the summary stops
// at it, as it stops at the assumptions.
test('the spec\'s user-facing half stops at its Design brief, unless the brief is all it has', () => {
  const firstVersion = [
    '# Share the flat\'s chores and who is on each',
    '',
    '## User-facing changes',
    '',
    'Everyone in the flat sees this week\'s chores and who is on each one, and ticks a chore off when it is done.',
    '',
    '### Design',
    '- Accent: sage green (light 95 118 83, dark 168 201 138).',
    '- Kit: btn-primary, btn-secondary, card, skeleton, state-empty, state-error.',
    '- Exact words: "This week", "Done".',
    '',
    '#### Kit',
    'Use the starter\'s components.',
    '',
    '### Assumptions',
    '- Chores rotate on Mondays.',
    '',
    '## Technical implementation',
    '',
    'Edit `public/index.html`.',
  ].join('\n');
  assert.equal(live.specUserFacing(firstVersion),
    'Everyone in the flat sees this week\'s chores and who is on each one, and ticks a chore off when it is done.');
  // Other subsections a person will see are still theirs, up to the brief.
  assert.equal(live.specUserFacing('# T\n\n## User-facing changes\n\nThe list.\n\n### Screens\nA row each.\n\n### Design\nSage.\n\n## Technical implementation\n\nx'),
    'The list.\n\n### Screens\nA row each.');
  // A word that only starts like the heading is not it.
  assert.equal(live.specUserFacing('# T\n\n## User-facing changes\n\nThe list.\n\n### Designer notes\nKept.\n\n## Technical implementation\n\nx'),
    'The list.\n\n### Designer notes\nKept.');
  // Nothing before the brief: the brief stands in, rather than no summary.
  assert.equal(live.specUserFacing('# T\n\n## User-facing changes\n\n### Design\nSage green.\n\n### Assumptions\n- x\n\n## Technical implementation\n\ny'),
    '### Design\nSage green.');
  // And the build that wrote no description of its own is described by it.
  assert.equal(live.buildDescription({ text: 'Done.', spec: firstVersion }).description,
    live.specUserFacing(firstVersion));
});

test('the build\'s own description wins; the spec\'s half stands in when the build left it out', () => {
  const said = live.buildDescription({ text: BUILD_TEXT, spec: SPEC });
  assert.equal(said.description, DESCRIPTION);
  assert.doesNotMatch(said.ccOutput, /==== DESCRIPTION ====/, 'the markers never reach the transcript');
  assert.match(said.ccOutput, /^Done\. Committed as e1d33fa\./);

  const skipped = live.buildDescription({ text: 'Done. Changed server/poller.js.', spec: SPEC });
  assert.equal(skipped.description, live.specUserFacing(SPEC));
  assert.equal(skipped.ccOutput, 'Done. Changed server/poller.js.');

  // A final message that is a wire failure says nothing about the change.
  const died = live.buildDescription({ text: 'API Error: Connection lost mid-response', spec: SPEC });
  assert.equal(died.description, live.specUserFacing(SPEC));
  assert.equal(died.ccOutput, live.specUserFacing(SPEC));

  // Neither: nothing to say, and nothing is recorded.
  assert.deepEqual(live.buildDescription({ text: '', spec: null }), { ccOutput: '', description: null });
});

test('the build is asked for the same DESCRIPTION block a dev chat turn ends with, after its summary', () => {
  for (const spec of [null, SPEC]) {
    const p = live.buildPrompt({ seed: 'ISSUE', buildNote: 'Edit a.js.', spec });
    assert.ok(p.indexOf('End with a short, plain-language summary') < p.indexOf('==== DESCRIPTION ===='),
      'after the contract\'s summary line');
    assert.match(p, /^==== DESCRIPTION ====$/m);
    assert.match(p, /^==== END DESCRIPTION ====$/m);
    assert.match(p, /No file names, code, commit hashes or\ntest results/);
    // The markers it is shown are the ones proposal-description.js reads.
    const tail = p.slice(p.indexOf('==== DESCRIPTION ===='), p.indexOf('==== END DESCRIPTION ====') + 25);
    assert.ok(proposalDescription.extract(tail).description);
  }
});

// ── Before the route runs ────────────────────────────────────────────────

function harness({ spec = SPEC, buildText = BUILD_TEXT } = {}) {
  const seq = [];
  const pool = {
    async query(sql, params) {
      const s = String(sql);
      seq.push({ sql: s, params });
      if (/INSERT INTO chat_sessions/.test(s)) return { rows: [{ id: 5001, app_id: APP.id, user_id: BOT.id }] };
      return { rows: [] };
    },
  };
  const router = express.Router();
  router.post('/api/sessions/:id/promote', (req, res) => { seq.push({ promote: req.params.id }); res.json({ ok: true, prNumber: 42 }); });
  const deps = {
    worker: {
      async ensureWorkerImage() {},
      async ensureWorker() { return 'usernode-worker-5001'; },
      async execInWorker(_id, opts) {
        return opts.mode === 'scout'
          ? { lastResultText: spec }
          : { pushOk: true, ahead: 1, sha: 'a'.repeat(40), lastResultText: buildText };
      },
      stopTurn() { return Promise.resolve(); },
      clearPendingStop() {},
    },
    sessions: {
      async runCodexAttemptLoop(args) { return { result: await args.dispatchOnce({}), error: null, estimatedCostUsd: 0.01 }; },
      async persistScoutPublication() { return { specVersion: 3 }; },
    },
    agentTurn: { async resolveCodexRuntimeContext() { return {}; } },
    sessionLifecycle: { async ensureSessionBranch({ sessionId }) { return { branchName: `homeroom_bot/s${sessionId}` }; } },
    activeWorkers: new Set(),
    votesRouter: router,
  };
  return { pool, deps, seq };
}

const ARGS = {
  config: {}, bot: BOT, app: APP, repo: { owner: 'usernode-bot', repo: 'rss' }, issueNumber: 12,
  issue: { title: 'Feeds never refresh' }, seed: 'Please work on GitHub issue #12.',
  buildNote: 'Add an hourly refresh to the feed poller.', turnBudgetMs: 20 * 60 * 1000, model: 'z-ai/glm-5.3-flash',
};

const titleWrite = (seq) => seq.findIndex((q) => /SET proposed_pr_title = \$1/.test(q.sql || ''));
const completionRow = (seq) => seq.findIndex((q) => /INSERT INTO chat_session_messages \(session_id, role, content, metadata\)/.test(q.sql || ''));
const promoted = (seq) => seq.findIndex((q) => q.promote);

test('the name and the description are written onto the session before the route proposes it', async () => {
  const h = harness();
  const out = await live.buildAndPropose({ pool: h.pool, deps: h.deps, ...ARGS });
  assert.equal(out.ok, true);
  const t = titleWrite(h.seq);
  const c = completionRow(h.seq);
  const p = promoted(h.seq);
  assert.ok(t >= 0 && c >= 0 && p >= 0, 'all three happened');
  assert.ok(t < p && c < p, 'both before the route reads the session');

  const name = h.seq[t];
  assert.deepEqual(name.params, ['Refresh feeds on their own every hour', 5001, BOT.id]);
  assert.match(name.sql, /WHERE id = \$2 AND user_id = \$3 AND pr_number IS NULL AND proposed_pr_title IS NULL/,
    'the bot\'s own session only, before it has a pull request, and never over a title somebody chose');

  const row = h.seq[c];
  assert.equal(row.params[0], 5001);
  assert.equal(row.params[1], 'Homeroom bot finished building');
  const meta = JSON.parse(row.params[2]);
  assert.equal(meta.proposalDescription, DESCRIPTION, 'what pr-metadata leads the proposal with');
  assert.match(meta.ccOutput, /^Done\. Committed as e1d33fa\./);
  assert.equal(meta.ccOutcome, 'success');
  assert.equal(meta.agentBackend, 'codex_openrouter');
  assert.equal(meta.agentModel, 'z-ai/glm-5.3-flash');

  // The seed itself is unchanged: it is the request, and its scaffolding is
  // peeled where a name is derived from it.
  const seed = h.seq.find((q) => /VALUES \(\$1, 'user', \$2\)/.test(q.sql || ''));
  assert.match(seed.params[1], /^Build issue #12: Feeds never refresh\n\nAdd an hourly refresh/);
});

test('with no spec the route names it from the issue, and the build\'s message is what it said', async () => {
  const h = harness({ spec: '', buildText: 'Added an hourly refresh.' });
  const out = await live.buildAndPropose({ pool: h.pool, deps: h.deps, ...ARGS });
  assert.equal(out.ok, true);
  assert.equal(titleWrite(h.seq), -1, 'no name written: the route\'s deterministic name is the issue title');
  const meta = JSON.parse(h.seq[completionRow(h.seq)].params[2]);
  assert.equal(meta.ccOutput, 'Added an hourly refresh.');
  assert.equal(meta.proposalDescription, undefined, 'the #2820 fallback: the cleaned message stands alone');
});

test('a shadow build is never named, described or proposed', async () => {
  const h = harness();
  const out = await live.buildAndPropose({ pool: h.pool, deps: h.deps, ...ARGS, propose: false });
  assert.equal(out.ok, true);
  assert.equal(titleWrite(h.seq), -1);
  assert.equal(completionRow(h.seq), -1);
  assert.equal(promoted(h.seq), -1);
});

test('a failing write never stops the proposal', async () => {
  const h = harness();
  const real = h.pool.query;
  h.pool.query = async function query(sql, params) {
    if (/proposed_pr_title|role, content, metadata/.test(String(sql))) throw new Error('db down');
    return real.call(this, sql, params);
  };
  const out = await live.buildAndPropose({ pool: h.pool, deps: h.deps, ...ARGS });
  assert.equal(out.ok, true);
  assert.ok(promoted(h.seq) >= 0);
});

test('a live build a restart interrupted is named and described before recovery proposes it', () => {
  const src = read('src/services/homeroom-bot.js');
  const recovered = src.slice(src.indexOf('async function completeRecoveredLive'), src.indexOf('async function holdSlotDuringRecovery'));
  const prepare = recovered.indexOf('await live.prepareProposal({');
  assert.ok(prepare > 0, 'the recovery path prepares the proposal too');
  assert.ok(prepare < recovered.indexOf('await live.promoteAsBot('), 'before it promotes');
  // A first version a restart caught in its review is described from the
  // build's own message, which its review kept (bot-review.js), not from the
  // fix turn recovery followed.
  assert.match(recovered, /spec: session\.spec_md \|\| null,\n\s+buildText: reviewing \? \(reviewing\.buildText \|\| ''\) : plan\.result\.lastResultText, model: session\.agent_model \|\| null,/);
  assert.match(recovered, /SELECT cs\.id, cs\.user_id, cs\.status, cs\.branch_name, cs\.spec_md, cs\.agent_model,/);
});
