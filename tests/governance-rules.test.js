// #4666, WHO SAYS YES: the approval presets, a project's own groups and
// rules, and the rule every change to who decides goes by
// (src/services/governance-rules.js, wired into src/services/governance.js
// computeGate / governedGate).
//
// Run with: node --test tests/governance-rules.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');

const rules = require('../src/services/governance-rules');
const governance = require('../src/services/governance');
const createOptions = require('../src/services/create-options');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 11, 12);
const OPENED = new Date(NOW - 60 * 1000).toISOString();

// evan (1) made it; maya (2), snait (3) and ana (4) are members.
const EVAN = 1;
const MAYA = 2;
const SNAIT = 3;
const ANA = 4;

function facts(over = {}) {
  return {
    creatorId: EVAN,
    memberCount: 4,
    membersActive: 4,
    adminIds: [],
    groups: new Map(),
    activeIds: null,
    ...over,
  };
}

function govFor(value) {
  return { approverPolicy: 'anyone', approvalsRequired: null, rules: value };
}

function preset(key) {
  return govFor(rules.parseRulesBlock({ preset: key }));
}

function gate(gov, { yes = [], no = [], author = MAYA, f = facts(), explicitApproval = false, reason, openedAt = OPENED, now = NOW } = {}) {
  return governance.computeGate(gov, f.membersActive, yes.length, no.length, openedAt, now, {
    voters: { yes: new Set(yes), no: new Set(no) },
    rulesFacts: f,
    authorId: author,
    memberCount: f.memberCount,
    explicitApproval,
    ...(reason !== undefined ? { explicitReason: reason } : {}),
  });
}

// ── Reading the block ─────────────────────────────────────────────────

test('a preset reads as the rules it stands for', () => {
  const v = rules.parseRulesBlock({ preset: 'you_or_the_group' });
  assert.equal(v.preset, 'you_or_the_group');
  assert.deepEqual(v.rules, [
    { group: 'creator', kind: 'atLeast', n: 1 },
    { group: 'members', kind: 'majority', n: null },
  ]);
  assert.equal(rules.parseRulesBlock({ preset: 'two_yeses' }).rules[0].n, 2);
});

test('a block with neither preset nor rules is an old-style block', () => {
  assert.equal(rules.parseRulesBlock(null), null);
  assert.equal(rules.parseRulesBlock({ approvers: 'invited', approvals: { atLeast: 1 } }), null);
});

test('groups and rules of a project’s own, with every measure', () => {
  const v = rules.parseRulesBlock({
    groups: [{ name: 'Lifeguards', people: ['evan', '@maya', 'Maya', ' '] }],
    rules: [
      { group: 'creator', atLeast: 1 },
      { group: 'lifeguards', atLeast: 2 },
      { group: 'members', percentOfActive: 50 },
      { group: 'members', percentOfEveryone: 60 },
      { group: 'Members', majority: true },
    ],
  });
  assert.equal(v.preset, null);
  assert.deepEqual(v.groups, [{ name: 'Lifeguards', people: ['evan', 'maya'] }]);
  assert.deepEqual(v.rules.map((r) => [r.group, r.kind, r.n]), [
    ['creator', 'atLeast', 1],
    ['lifeguards', 'atLeast', 2],
    ['members', 'percentOfActive', 50],
    ['members', 'percentOfEveryone', 60],
    ['members', 'majority', null],
  ]);
});

test('the strict reader refuses what it cannot read, with the limits', () => {
  const bad = [
    { preset: 'captain' },
    { preset: 'open_floor', rules: [{ group: 'members', atLeast: 1 }] },
    { rules: [] },
    { rules: [{ group: 'friends', atLeast: 1 }] },
    { rules: [{ group: 'members', atLeast: 0 }] },
    { rules: [{ group: 'members', percentOfActive: 101 }] },
    { rules: [{ group: 'members', majority: false }] },
    { rules: [{ group: 'members', atLeast: 1, majority: true }] },
    { rules: [{ group: 'members', atLeast: 1 }, { group: 'members', atLeast: 1 }] },
    { groups: [{ name: 'Members', people: [] }], rules: [{ group: 'members', atLeast: 1 }] },
    { groups: [{ name: 'A' }, { name: 'a' }], rules: [{ group: 'a', atLeast: 1 }] },
    { rules: Array.from({ length: rules.MAX_RULES + 1 }, (_, i) => ({ group: 'members', atLeast: i + 1 })) },
    {
      groups: Array.from({ length: rules.MAX_GROUPS + 1 }, (_, i) => ({ name: `G${i}` })),
      rules: [{ group: 'g0', atLeast: 1 }],
    },
  ];
  for (const b of bad) assert.throws(() => rules.parseRulesBlock(b), rules.RulesError, JSON.stringify(b));
  // The deploy reader never throws: it reports and keeps what the project had.
  const lenient = rules.readRulesBlock({ preset: 'captain' });
  assert.equal(lenient.value, null);
  assert.match(lenient.error, /preset/);
});

test('a rule list that is a preset says so, in any order, and is written as it', () => {
  assert.equal(rules.matchPreset([
    { group: 'members', kind: 'majority', n: null },
    { group: 'creator', kind: 'atLeast', n: 1 },
  ]), 'you_or_the_group');
  assert.equal(rules.matchPreset([{ group: 'members', kind: 'atLeast', n: 3 }]), null);
  assert.deepEqual(rules.blockFor({ rules: [{ group: 'members', kind: 'atLeast', n: 1 }] }), { preset: 'open_floor' });
  assert.deepEqual(rules.blockFor({
    groups: [{ name: 'Lifeguards', people: ['evan'] }],
    rules: [{ group: 'lifeguards', kind: 'atLeast', n: 2 }, { group: 'members', kind: 'majority', n: null }],
  }), {
    groups: [{ name: 'Lifeguards', people: ['evan'] }],
    rules: [{ group: 'Lifeguards', atLeast: 2 }, { group: 'members', majority: true }],
  });
  // What it writes, it reads back as the same rules.
  const back = rules.parseRulesBlock(rules.blockFor({
    groups: [{ name: 'Lifeguards', people: ['evan'] }],
    rules: [{ group: 'lifeguards', kind: 'percentOfEveryone', n: 60 }],
  }));
  assert.deepEqual(back.rules, [{ group: 'lifeguards', kind: 'percentOfEveryone', n: 60 }]);
});

test('new projects start on You or the group', () => {
  assert.equal(rules.DEFAULT_PRESET, 'you_or_the_group');
});

// ── You or the group ──────────────────────────────────────────────────

test('You or the group: the creator’s own change goes live on proposing it', () => {
  const g = gate(preset('you_or_the_group'), { author: EVAN });
  assert.equal(g.mode, 'rules');
  assert.equal(g.preset, 'you_or_the_group');
  assert.equal(g.mergeable, true);
  assert.equal(g.creatorYes, true);
  assert.deepEqual(g.passedBy, { group: 'creator', kind: 'atLeast', n: 1 });
  assert.equal(g.rejectable, false);
});

test('You or the group: a member’s change goes live on the creator’s yes', () => {
  assert.equal(gate(preset('you_or_the_group'), { author: MAYA }).mergeable, false);
  const g = gate(preset('you_or_the_group'), { author: MAYA, yes: [EVAN] });
  assert.equal(g.mergeable, true);
  assert.equal(g.creatorYes, true);
});

test('You or the group: or when most of the group says yes, as Group vote would', () => {
  // Four active members: the eased bar is 2 (active-users.js requiredVotes).
  const g = gate(preset('you_or_the_group'), { author: MAYA, yes: [MAYA, SNAIT, ANA] });
  assert.equal(g.mergeable, true);
  assert.deepEqual(g.passedBy, { group: 'members', kind: 'majority', n: null });
  assert.equal(g.creatorYes, false);
});

test('You or the group: the creator saying No is not a veto', () => {
  const g = gate(preset('you_or_the_group'), { author: MAYA, yes: [MAYA, SNAIT, ANA], no: [EVAN] });
  assert.equal(g.mergeable, true);
});

test('You or the group: a creator who voted No on their own change does not ship it', () => {
  const g = gate(preset('you_or_the_group'), { author: EVAN, no: [EVAN] });
  assert.equal(g.mergeable, false);
  assert.equal(g.creatorYes, false);
});

test('a project with no creator (the platform’s own) never passes a creator rule', () => {
  const g = gate(preset('you_or_the_group'), { author: EVAN, f: facts({ creatorId: null }) });
  assert.equal(g.mergeable, false);
  assert.equal(g.rules[0].empty, true);
});

// ── Two yeses ─────────────────────────────────────────────────────────

test('Two yeses: whoever makes it, plus one more', () => {
  assert.equal(gate(preset('two_yeses'), { author: MAYA }).mergeable, false);
  const g = gate(preset('two_yeses'), { author: MAYA, yes: [SNAIT] });
  assert.equal(g.mergeable, true);
  assert.equal(g.qualifiedYes, 2);
  assert.equal(g.required, 2);
});

test('Two yeses: the author’s own vote does not count twice', () => {
  assert.equal(gate(preset('two_yeses'), { author: MAYA, yes: [MAYA] }).mergeable, false);
});

test('Two yeses: alone in the project, your yes is enough', () => {
  const g = gate(preset('two_yeses'), { author: EVAN, f: facts({ memberCount: 1, membersActive: 1 }) });
  assert.equal(g.mergeable, true);
  assert.equal(g.required, 1);
});

// ── Open floor and Group vote ─────────────────────────────────────────

test('Open floor: any member’s change goes live on proposing it', () => {
  assert.equal(gate(preset('open_floor'), { author: SNAIT }).mergeable, true);
});

test('Group vote counts votes as cast: proposing alone is not a yes', () => {
  const g = gate(preset('group_vote'), { author: MAYA });
  assert.equal(g.mergeable, false);
  assert.equal(g.qualifiedYes, 0);
  assert.equal(g.lazyArmed, false);
});

test('Group vote is the default mode’s gate, clocks and all', () => {
  const { mergeGate } = require('../src/services/active-users');
  const g = gate(preset('group_vote'), { author: MAYA, yes: [MAYA] });
  const want = mergeGate(4, 1, 0, OPENED, NOW);
  for (const k of ['required', 'windowEndsAt', 'lazyArmed', 'lazyWindowMs', 'mergeable', 'rejectionArmed']) {
    assert.deepEqual(g[k], want[k], k);
  }
});

// ── A project’s own groups and rules ──────────────────────────────────

test('a named group counts only its people, and never more than it has', () => {
  const value = rules.parseRulesBlock({
    groups: [{ name: 'Lifeguards', people: ['evan', 'maya'] }],
    rules: [{ group: 'Lifeguards', atLeast: 5 }],
  });
  value.groups = [{ name: 'Lifeguards', key: 'lifeguards', ids: [EVAN, MAYA] }];
  const f = facts({ groups: new Map([['lifeguards', [EVAN, MAYA]]]) });
  // Capped at the group's two people; snait's yes is not theirs.
  assert.equal(gate(govFor(value), { author: SNAIT, yes: [SNAIT, EVAN], f }).mergeable, false);
  const g = gate(govFor(value), { author: SNAIT, yes: [EVAN, MAYA], f });
  assert.equal(g.mergeable, true);
  assert.equal(g.rules[0].need, 2);
});

test('a group with nobody in it never passes', () => {
  const value = { preset: null, groups: [], rules: [{ group: 'admins', kind: 'atLeast', n: 1 }] };
  const g = gate(govFor(value), { author: EVAN, yes: [EVAN] });
  assert.equal(g.mergeable, false);
  assert.equal(g.rules[0].empty, true);
});

test('shares of everyone and of the active, rounded up and at least one', () => {
  const everyone = { preset: null, groups: [], rules: [{ group: 'members', kind: 'percentOfEveryone', n: 60 }] };
  // 60% of 4 members is 2.4: three yeses, the author's among them.
  assert.equal(gate(govFor(everyone), { author: MAYA, yes: [SNAIT] }).mergeable, false);
  assert.equal(gate(govFor(everyone), { author: MAYA, yes: [SNAIT, ANA] }).mergeable, true);
  const active = { preset: null, groups: [], rules: [{ group: 'members', kind: 'percentOfActive', n: 50 }] };
  const f = facts({ membersActive: 2 });
  assert.equal(gate(govFor(active), { author: MAYA, f }).mergeable, true);
});

test('any one rule passing is enough', () => {
  const value = {
    preset: null,
    groups: [],
    rules: [{ group: 'admins', kind: 'atLeast', n: 1 }, { group: 'members', kind: 'atLeast', n: 3 }],
  };
  const f = facts({ adminIds: [ANA] });
  assert.equal(gate(govFor(value), { author: MAYA, yes: [SNAIT], f }).mergeable, false);
  assert.equal(gate(govFor(value), { author: MAYA, yes: [ANA], f }).passedBy.group, 'admins');
  assert.equal(gate(govFor(value), { author: MAYA, yes: [SNAIT, EVAN], f }).passedBy.group, 'members');
});

// ── Changes to who decides ────────────────────────────────────────────

test('who decides goes by You or the group whatever the project picked', () => {
  // Open floor would ship maya's change on her own say-so; making the
  // project public is not hers alone to decide.
  const g = gate(preset('open_floor'), { author: MAYA, explicitApproval: true, reason: 'visibility' });
  assert.equal(g.whoDecides, true);
  assert.equal(g.mergeable, false);
  assert.equal(gate(preset('open_floor'), { author: MAYA, yes: [EVAN], explicitApproval: true, reason: 'visibility' }).mergeable, true);
});

test('who decides: the creator changes the rule alone', () => {
  const g = gate(preset('group_vote'), { author: EVAN, explicitApproval: true, reason: 'governance' });
  assert.equal(g.mergeable, true);
  assert.equal(g.passedBy.group, 'creator');
});

test('who decides: the group’s real yes votes outvote the creator, with no quiet wait', () => {
  // One yes from someone besides the author arms the quiet wait in a normal
  // vote; here it does nothing until the threshold is met by votes cast.
  const waiting = gate(preset('you_or_the_group'), {
    author: MAYA, yes: [SNAIT], explicitApproval: true, reason: 'admins',
    openedAt: new Date(NOW - 30 * DAY).toISOString(),
  });
  assert.equal(waiting.mergeable, false);
  assert.equal(waiting.lazyArmed, false);
  const outvoted = gate(preset('you_or_the_group'), {
    author: MAYA, yes: [MAYA, SNAIT, ANA], no: [EVAN], explicitApproval: true, reason: 'admins',
  });
  assert.equal(outvoted.mergeable, true);
  assert.equal(outvoted.passedBy.group, 'members');
});

test('who decides: the group’s side needs a yes from someone besides the author', () => {
  // One active member makes the eased bar a single yes: the author's own.
  const f = facts({ membersActive: 1 });
  const g = gate(preset('you_or_the_group'), { author: MAYA, yes: [MAYA], f, explicitApproval: true, reason: 'governance' });
  assert.equal(g.mergeable, false);
  assert.equal(g.memberFloor.applies, true);
  assert.equal(g.memberFloor.met, false);
});

test('a change to the keys follows the project’s own rule, clocks off', () => {
  const g = gate(preset('two_yeses'), { author: MAYA, yes: [SNAIT], explicitApproval: true, reason: 'secrets' });
  assert.equal(g.whoDecides, false);
  assert.equal(g.mergeable, true);
  const vote = gate(preset('group_vote'), {
    author: MAYA, yes: [SNAIT], explicitApproval: true, reason: 'secrets',
    openedAt: new Date(NOW - 30 * DAY).toISOString(),
  });
  assert.equal(vote.lazyArmed, false);
  assert.equal(vote.mergeable, false);
});

test('a flag with no reason is read as who decides', () => {
  assert.equal(gate(preset('open_floor'), { author: MAYA, explicitApproval: true, reason: null }).mergeable, false);
});

// ── Callers with counts only ──────────────────────────────────────────

test('a caller with counts only answers the members rules and says it is partial', () => {
  const gov = preset('you_or_the_group');
  const g = governance.computeGate(gov, 4, 3, 0, OPENED, NOW, {});
  assert.equal(g.mergeable, true);
  const creatorOnly = governance.computeGate(gov, 4, 0, 0, OPENED, NOW, {});
  assert.equal(creatorOnly.mergeable, false);
  assert.equal(creatorOnly.partial, true);
});

test('projects without rules are untouched', () => {
  const g = governance.computeGate({ approverPolicy: 'anyone', approvalsRequired: null }, 4, 1, 0, OPENED, NOW, {});
  assert.equal(g.mode, 'default');
  assert.equal(governance.computeGate({ approverPolicy: 'anyone', approvalsRequired: 2, rules: null }, 4, 2, 0, OPENED, NOW).mode, 'at_least');
});

// ── governedGate reads what a rule needs ──────────────────────────────

function fakePool({ rulesRow, votes = [], author = MAYA, reason = null } = {}) {
  const seen = [];
  return {
    seen,
    async query(sql, params) {
      seen.push(sql);
      if (/SELECT approver_policy, approvals_required FROM apps/.test(sql)) {
        return { rows: [{ approver_policy: 'anyone', approvals_required: null }] };
      }
      if (/SELECT governance_rules FROM apps/.test(sql)) return { rows: [{ governance_rules: rulesRow }] };
      if (/FROM apps a WHERE a.id = \$1/.test(sql) && /member_count/.test(sql)) {
        return { rows: [{ created_by: EVAN, self_hosted: false, collab_visibility: 'private', member_count: 4, admin_ids: [] }] };
      }
      if (/FROM pr_votes/.test(sql) && /SELECT user_id, vote/.test(sql)) return { rows: votes };
      if (/SELECT user_id AS author_id FROM chat_sessions/.test(sql)) return { rows: [{ author_id: author }] };
      // D2: whether the author is a person (tests/first-version-gate.test.js).
      if (/SELECT is_synthetic FROM users/.test(sql)) return { rows: [{ is_synthetic: false }] };
      // D1: whether it is the project's first version.
      if (/AS first_version FROM chat_sessions cs/.test(sql)) return { rows: [{ first_version: false }] };
      if (/explicit_approval_reason FROM chat_sessions/.test(sql)) return { rows: [{ explicit_approval_reason: reason }] };
      if (/COUNT\(DISTINCT a.user_id\)/.test(sql)) return { rows: [{ cnt: 4, invited_floor: 2 }] };
      if (/SELECT self_hosted, collab_visibility FROM apps/.test(sql)) return { rows: [{ self_hosted: false, collab_visibility: 'private' }] };
      throw new Error(`unexpected query: ${sql.slice(0, 80)}`);
    },
  };
}

test('governedGate reads the voters, the author and the app for a rules project', async () => {
  governance.invalidateGovernance(901);
  const pool = fakePool({ rulesRow: { preset: 'you_or_the_group', groups: [], rules: rules.PRESETS.you_or_the_group }, votes: [{ user_id: EVAN, vote: 'yes' }] });
  const g = await governance.governedGate(pool, 901, { kind: 'pr', id: 77, openedAt: OPENED, now: NOW });
  assert.equal(g.mode, 'rules');
  assert.equal(g.mergeable, true);
  assert.equal(g.creatorYes, true);
});

test('governedGate reads the stored reason of a flagged PR when not told', async () => {
  governance.invalidateGovernance(902);
  const pool = fakePool({
    rulesRow: { preset: 'open_floor', groups: [], rules: rules.PRESETS.open_floor },
    reason: 'visibility',
  });
  const g = await governance.governedGate(pool, 902, { kind: 'pr', id: 78, openedAt: OPENED, now: NOW, explicitApproval: true });
  assert.equal(g.whoDecides, true);
  assert.equal(g.mergeable, false);
});

test('a project without rules issues the same queries it always did, plus the one rules read', async () => {
  governance.invalidateGovernance(903);
  const pool = fakePool({ rulesRow: null });
  pool.query = ((orig) => async (sql, params) => {
    if (/SELECT COUNT\(\*\) as cnt FROM pr_votes/.test(sql)) return { rows: [{ cnt: 0 }] };
    return orig(sql, params);
  })(pool.query.bind(pool));
  const g = await governance.governedGate(pool, 903, { kind: 'pr', id: 79, openedAt: OPENED, now: NOW });
  assert.equal(g.mode, 'default');
});

test('a failed rules read falls back to the columns', async () => {
  governance.invalidateGovernance(904);
  const pool = {
    async query(sql) {
      if (/SELECT approver_policy, approvals_required FROM apps/.test(sql)) return { rows: [{ approver_policy: 'anyone', approvals_required: 2 }] };
      throw new Error('column "governance_rules" does not exist');
    },
  };
  const gov = await governance.getGovernance(pool, 904);
  assert.equal(gov.rules, null);
  assert.equal(gov.approvalsRequired, 2);
});

// ── New projects ──────────────────────────────────────────────────────

test('a new project is created on You or the group unless it asks otherwise', () => {
  const opts = createOptions.parseCreateOptions({ audience: 'solo' });
  assert.equal(opts.governance.preset, 'you_or_the_group');
  assert.deepEqual(createOptions.governanceBlock(opts.governance), { preset: 'you_or_the_group' });
  const chosen = createOptions.parseCreateOptions({ audience: 'solo', governance: { preset: 'two_yeses' } });
  assert.deepEqual(createOptions.governanceBlock(chosen.governance), { preset: 'two_yeses' });
  const old = createOptions.parseCreateOptions({ audience: 'solo', governance: { approvers: 'invited' } });
  assert.deepEqual(createOptions.governanceBlock(old.governance), { approvers: 'invited', approvals: 'default' });
});

// ── §5816: a builder's Yes approves an ordinary change on its own ─────
//
// The people who can already force a change through, plus the person who
// made the project. Read off the same facts the rules read; a protected
// change keeps its own rule.

const BUILDER_FACTS = facts({ adminIds: [ANA], platformAdminIds: [7] });
const PLATFORM_ADMIN = 7;

function builderGate(gov, {
  yes = [], no = [], author = MAYA, f = BUILDER_FACTS, explicitApproval = false, reason,
  builderYes = true, approverIds = null, openedAt = OPENED, now = NOW,
} = {}) {
  return governance.computeGate(gov, f.membersActive, yes.length, no.length, openedAt, now, {
    voters: { yes: new Set(yes), no: new Set(no) },
    rulesFacts: f,
    authorId: author,
    memberCount: f.memberCount,
    explicitApproval,
    ...(reason !== undefined ? { explicitReason: reason } : {}),
    ...(builderYes ? { builderYes: true } : {}),
    ...(approverIds ? { approverIds } : {}),
  });
}

for (const key of ['you_or_the_group', 'two_yeses', 'open_floor', 'group_vote']) {
  test(`§5816 ${key}: the maker’s yes approves an ordinary change alone`, () => {
    const g = builderGate(preset(key), { yes: [EVAN] });
    assert.equal(g.mergeable, true);
    assert.deepEqual(g.builderYes, { userId: EVAN, role: 'creator' });
    assert.equal(g.thresholdMet, true);
    assert.ok(g.required >= 1);
  });

  test(`§5816 ${key}: an app admin’s yes approves an ordinary change alone`, () => {
    const g = builderGate(preset(key), { yes: [ANA] });
    assert.equal(g.mergeable, true);
    assert.deepEqual(g.builderYes, { userId: ANA, role: 'admin' });
  });

  test(`§5816 ${key}: a Homeroom admin’s yes approves an ordinary change alone`, () => {
    const g = builderGate(preset(key), { yes: [PLATFORM_ADMIN] });
    assert.equal(g.mergeable, true);
    assert.deepEqual(g.builderYes, { userId: PLATFORM_ADMIN, role: 'platform_admin' });
  });

  test(`§5816 ${key}: without builderYes the gate is what it was`, () => {
    // Evan made it and proposes it: on Two yeses and Group vote that is one
    // member's yes and nothing more.
    const g = builderGate(preset(key), { yes: [EVAN], author: EVAN, builderYes: false });
    assert.equal(g.builderYes, undefined);
    // The presets that already let the creator's yes through keep doing so;
    // the ones that count them as one member do not.
    assert.equal(g.mergeable, ['you_or_the_group', 'open_floor'].includes(key));
  });
}

test('§5816: someone who is not a builder changes nothing', () => {
  const f = facts({ creatorId: null, adminIds: [] });
  const g = builderGate(preset('two_yeses'), { yes: [SNAIT], f });
  assert.equal(g.builderYes, null);
  assert.equal(g.mergeable, true, 'Two yeses: the author’s and one more');
});

test('§5816: a builder’s yes is recorded even when the rule already passed', () => {
  const g = builderGate(preset('two_yeses'), { yes: [SNAIT, EVAN] });
  assert.equal(g.mergeable, true);
  assert.deepEqual(g.builderYes, { userId: EVAN, role: 'creator' });
  assert.equal(g.required, 2);
});

test('§5816: a change to who decides keeps WHO_DECIDES and the member floor', () => {
  // Evan made it and votes too: WHO_DECIDES is satisfied, but the floor
  // still wants a yes from someone other than the author.
  const g = builderGate(preset('two_yeses'), {
    author: EVAN, yes: [EVAN], explicitApproval: true, reason: 'admins',
  });
  assert.equal(g.builderYes, undefined, 'a flagged change is not shortcut');
  // WHO_DECIDES is the creator rule plus the members' majority: the
  // creator's yes passes it, exactly as before.
  assert.equal(g.mergeable, true);
  assert.equal(g.whoDecides, true);
  // What the shortcut must not do: a member who is not the creator gets
  // nowhere on their own yes.
  const other = builderGate(preset('two_yeses'), {
    author: SNAIT, yes: [SNAIT], explicitApproval: true, reason: 'admins',
  });
  assert.equal(other.builderYes, undefined);
  assert.equal(other.mergeable, false);
});

test('§5816: a change to the project’s keys still follows the project’s rule', () => {
  const opts = { yes: [EVAN], explicitApproval: true, reason: 'secrets' };
  const g = builderGate(preset('two_yeses'), opts);
  const without = builderGate(preset('two_yeses'), { ...opts, builderYes: false });
  assert.equal(g.builderYes, undefined, 'no shortcut');
  assert.deepEqual([g.mergeable, g.required, g.qualifiedYes],
    [without.mergeable, without.required, without.qualifiedYes]);
});

test('§5816: the platform’s own project has no maker, only admins', () => {
  const f = facts({ creatorId: null, adminIds: [ANA] });
  assert.equal(builderGate(preset('two_yeses'), { yes: [EVAN], author: EVAN, f }).builderYes, null);
  const g = builderGate(preset('group_vote'), { yes: [ANA], author: EVAN, f });
  assert.equal(g.mergeable, true);
  assert.deepEqual(g.builderYes, { userId: ANA, role: 'admin' });
});
