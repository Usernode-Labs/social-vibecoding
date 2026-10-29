'use strict';

// 29 Oct 2026: a change a coding agent submitted for its author (through the
// connector, or a local agent's hand-off: chat_sessions.external_agent) is
// not their yes for being proposed. Their yes counts like anyone's, once
// they tap it on Homeroom: "it should count as a yes, but they should just
// have to manually do it, not have it auto-done by the connector".
//
// This holds the rule (governance-rules.ts, `madeByAgent`) and the places
// that read it: the batch read behind the lists, the ballot's own copy of
// the rule, and the AI tab, which leaves a vote you owe to Needs you.
// tests/agent-submission-yes-postgres.test.js runs it against the schema.
//
// Run with: node --test tests/agent-submission-yes.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');

const rules = require('../src/services/governance-rules');
const governance = require('../src/services/governance');
const aiWork = require('../src/services/ai-work');
const { loadTsx } = require('./lib/render-tsx');

const NOW = Date.UTC(2026, 9, 29, 15);
const OPENED = new Date(NOW - 60 * 1000).toISOString();

// ada (1) made the project; sam (2) and kim (3) are members.
const ADA = 1;
const SAM = 2;
const KIM = 3;

const facts = () => ({
  creatorId: ADA, memberCount: 3, membersActive: 3, adminIds: [], groups: new Map(), activeIds: null,
});
const preset = (key) => ({ approverPolicy: 'anyone', approvalsRequired: null, rules: rules.parseRulesBlock({ preset: key }) });

function gate(gov, { yes = [], no = [], author = SAM, agent = true } = {}) {
  const f = facts();
  return governance.computeGate(gov, f.membersActive, yes.length, no.length, OPENED, NOW, {
    voters: { yes: new Set(yes), no: new Set(no) },
    rulesFacts: f,
    authorId: author,
    authorIsBot: false,
    madeByAgent: agent,
    memberCount: f.memberCount,
  });
}

test('Open floor: an agent\'s submission waits for its author\'s tap, which is enough', () => {
  assert.equal(gate(preset('open_floor'), { agent: false }).mergeable, true, 'proposing on Homeroom is still a yes');
  const waiting = gate(preset('open_floor'));
  assert.equal(waiting.mergeable, false, 'the connector proposing it is not');
  assert.equal(waiting.qualifiedYes, 0, 'and no yes is shown for it');
  assert.equal(gate(preset('open_floor'), { yes: [SAM] }).mergeable, true, 'the author\'s own tap counts');
  assert.equal(gate(preset('open_floor'), { yes: [KIM] }).mergeable, true, 'as does anyone else\'s');
});

test('Two yeses: whoever makes it, plus one more, both tapped', () => {
  assert.equal(gate(preset('two_yeses'), { agent: false, yes: [KIM] }).mergeable, true);
  assert.equal(gate(preset('two_yeses'), { yes: [KIM] }).mergeable, false, 'one more is not two');
  assert.equal(gate(preset('two_yeses'), { yes: [KIM, SAM] }).mergeable, true);
});

test('You or the group: the creator\'s agent-made change is theirs to approve with a tap', () => {
  const hand = gate(preset('you_or_the_group'), { author: ADA, agent: false });
  assert.equal(hand.creatorYes, true);
  assert.equal(hand.mergeable, true);
  const agent = gate(preset('you_or_the_group'), { author: ADA });
  assert.equal(agent.creatorYes, false, 'nobody has said yes yet');
  assert.equal(agent.mergeable, false);
  const tapped = gate(preset('you_or_the_group'), { author: ADA, yes: [ADA] });
  assert.equal(tapped.creatorYes, true);
  assert.equal(tapped.mergeable, true);
});

test('Group vote counts votes as cast either way', () => {
  assert.equal(gate(preset('group_vote'), { agent: false }).mergeable, false);
  assert.equal(gate(preset('group_vote')).mergeable, false);
});

test('rulesGateOpts says which of a batch an agent submitted', () => {
  const ctx = { facts: facts(), voters: new Map(), botAuthored: new Set(), agentMade: new Set([7]) };
  assert.equal(governance.rulesGateOpts(ctx, 7, SAM, null).madeByAgent, true);
  assert.equal(governance.rulesGateOpts(ctx, '7', SAM, null).madeByAgent, true);
  assert.equal(governance.rulesGateOpts(ctx, 8, SAM, null).madeByAgent, false);
  assert.equal(governance.rulesGateOpts({ facts: facts(), voters: new Map() }, 7, SAM, null).madeByAgent, false,
    'a context from before it was read counts proposing as before');
});

test('agentMadeBatch reads the batch once; a request has none; a failed read counts every one', async () => {
  const seen = [];
  const pool = { async query(sql, params) { seen.push({ sql, params }); return { rows: [{ id: 7 }] }; } };
  assert.deepEqual([...await governance.agentMadeBatch(pool, 'pr', [7, '8', 'x'])], [7]);
  assert.equal(seen.length, 1);
  assert.match(seen[0].sql, /FROM chat_sessions WHERE id = ANY\(\$1::int\[\]\) AND external_agent IS NOT NULL/);
  assert.deepEqual(seen[0].params, [[7, 8]]);
  assert.deepEqual([...await governance.agentMadeBatch(pool, 'issue', [7])], []);
  assert.equal(seen.length, 1, 'a request is never asked about');
  const broken = { async query() { throw new Error('down'); } };
  assert.deepEqual([...await governance.agentMadeBatch(broken, 'pr', [7, 8])], [7, 8]);
});

test('madeByAgent reads one change; a failed read is the stricter answer', async () => {
  const pool = (agent) => ({ async query(sql, params) {
    assert.match(sql, /SELECT external_agent FROM chat_sessions WHERE id = \$1/);
    assert.deepEqual(params, [5]);
    return { rows: [{ external_agent: agent }] };
  } });
  assert.equal(await governance.madeByAgent(pool('claude-code'), 'pr', 5), true);
  assert.equal(await governance.madeByAgent(pool(null), 'pr', 5), false);
  assert.equal(await governance.madeByAgent({ query() { throw new Error('not asked'); } }, 'issue', 5), false);
  assert.equal(await governance.madeByAgent({ async query() { throw new Error('down'); } }, 'pr', 5), true);
});

test('on a ballot an agent\'s submission is not its author\'s pick until they make it', () => {
  const { authorCounts } = loadTsx('frontend/src/features/dev-board/topic/thread-changes.tsx');
  const mine = { type: 'change', id: 51, mine: true, myVote: null };
  const row = { approval_mode: 'rules', approval_preset: 'open_floor' };
  assert.equal(authorCounts(mine, row), true);
  assert.equal(authorCounts(mine, { ...row, external_agent: 'claude-code' }), false);
  assert.equal(authorCounts(mine, { ...row, external_agent: null }), true);
});

test('the AI tab leaves your own agent-made change to Needs you until you vote on it', () => {
  const row = { change_status: 'promoted', change_user: SAM, state: 'open', promoted_at: OPENED, voted: false };
  assert.deepEqual(aiWork.standing(row, SAM), { group: 'next', what: 'vote', at: OPENED }, 'made on Homeroom: yours, up for a vote');
  assert.equal(aiWork.standing({ ...row, by_agent: true }, SAM), null, 'made by an agent: a vote you owe');
  assert.deepEqual(aiWork.standing({ ...row, by_agent: true, voted: true }, SAM), { group: 'next', what: 'vote', at: OPENED });
  assert.equal(aiWork.standing(row, KIM), null, 'someone else\'s, unvoted, is owed as before');
});
