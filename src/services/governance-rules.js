'use strict';

/**
 * WHO SAYS YES (#4666): a project's approval rule as named presets, or as
 * groups and rules of its own. Pure: nothing here reads the database, so
 * every rule is tested without one (tests/governance-rules.test.js).
 * services/governance.js reads the facts and hands them in.
 *
 * ── The block ──────────────────────────────────────────────────────────
 *
 * dapp.json's `governance` block gains three keys beside the two it always
 * had (`approvers`, `approvals`, read by app-manifest.js readGovernance):
 *
 *   "governance": { "preset": "you_or_the_group" }
 *
 *   "governance": {
 *     "groups": [{ "name": "Lifeguards", "people": ["evan", "maya"] }],
 *     "rules": [
 *       { "group": "creator", "atLeast": 1 },
 *       { "group": "Lifeguards", "atLeast": 2 },
 *       { "group": "members", "percentOfActive": 50 },
 *       { "group": "members", "percentOfEveryone": 60 },
 *       { "group": "members", "majority": true }
 *     ]
 *   }
 *
 * A change goes live when ANY rule passes. A preset is a name for a rule
 * list (PRESETS); `preset` and `rules` are two spellings of the same thing,
 * and a block that has either is a "rules" block: the old two keys are then
 * ignored, and a project without one keeps exactly the rule it had.
 *
 * ── Groups ─────────────────────────────────────────────────────────────
 *
 * Three are built in: `creator` (the person who made the project; nobody on
 * the platform's own app, which has no creator), `members` (everyone in its
 * community) and `admins` (dapp.json's `admins`). A named group is a list of
 * people, by username, so changing who is in it is a change to dapp.json
 * like any other, and a protected one (below). A rule on a group with nobody
 * in it never passes.
 *
 * ── Rules ──────────────────────────────────────────────────────────────
 *
 * One measure each:
 *
 *   atLeast N            N yeses from the group, never more than it has, so
 *                        a group that shrinks never makes the rule
 *                        impossible;
 *   percentOfActive P    P% of the group's people who have been around
 *                        lately (the platform's own "active"), at least one;
 *   percentOfEveryone P  P% of everyone in the group, active or not;
 *   majority             the platform's time-and-majority vote
 *                        (active-users.js mergeGate) over the group: the
 *                        eased threshold, the minimum window and the quiet
 *                        wait, exactly as Group vote has always worked.
 *
 * Only yeses count toward a rule; a No still does what it always did on the
 * majority rule (raises the bar, arms the takedown clock).
 *
 * PROPOSING COUNTS AS A YES on the counted rules (atLeast and the two
 * percentages): a person who opens a change is saying yes to it, so the
 * author's yes is counted unless they voted No. That is what makes Two yeses
 * "whoever makes it, plus one more", Open floor "any member's yes, even their
 * own" and You or the group "you ship on your own". The majority rule counts
 * votes as they are cast, so Group vote is today's default to the vote.
 *
 * ── Changes to who decides ─────────────────────────────────────────────
 *
 * A change to who can see the project, its admins, its groups or this rule
 * (a proposal flagged for explicit approval with any reason but `secrets`;
 * services/explicit-approval.js) is decided by WHO_DECIDES whatever the
 * project picked: the creator's yes, or the group's majority by votes
 * actually cast. No quiet wait, no minimum window, and the member floor (a
 * yes from someone besides its author) on the group's side. The creator has
 * no veto: the group's majority can still outvote them, as it always could,
 * so no project can end up in a state its members cannot change.
 *
 * A change to the project's keys (`secrets`) follows the project's own rule,
 * with the clocks off and the member floor on any majority rule.
 */

const PRESET_KEYS = Object.freeze(['you_or_the_group', 'two_yeses', 'open_floor', 'group_vote']);
const DEFAULT_PRESET = 'you_or_the_group';

const BUILT_IN_GROUPS = Object.freeze(['creator', 'members', 'admins']);
const MEASURES = Object.freeze(['atLeast', 'percentOfActive', 'percentOfEveryone', 'majority']);

const MAX_RULES = 5;
const MAX_GROUPS = 10;
const MAX_GROUP_PEOPLE = 50;
const MAX_AT_LEAST = 50;
const GROUP_NAME_MAX = 32;
const USERNAME_MAX = 64;

/** Each preset, as the rules it stands for. */
const PRESETS = Object.freeze({
  you_or_the_group: Object.freeze([
    Object.freeze({ group: 'creator', kind: 'atLeast', n: 1 }),
    Object.freeze({ group: 'members', kind: 'majority', n: null }),
  ]),
  two_yeses: Object.freeze([Object.freeze({ group: 'members', kind: 'atLeast', n: 2 })]),
  open_floor: Object.freeze([Object.freeze({ group: 'members', kind: 'atLeast', n: 1 })]),
  group_vote: Object.freeze([Object.freeze({ group: 'members', kind: 'majority', n: null })]),
});

/** The rule every change to who decides goes by. */
const WHO_DECIDES = PRESETS.you_or_the_group;

/** Human names, for PR titles and the notices panel. */
const PRESET_NAMES = Object.freeze({
  you_or_the_group: 'You or the group',
  two_yeses: 'Two yeses',
  open_floor: 'Open floor',
  group_vote: 'Group vote',
});

class RulesError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RulesError';
  }
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** A named group's key: its name, case-folded and with spaces collapsed. */
function groupKey(name) {
  return String(name || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function cleanName(name) {
  return String(name || '').replace(/[\s\p{Cc}]+/gu, ' ').trim();
}

function cleanUsername(raw) {
  return String(raw || '').trim().replace(/^@/, '');
}

/**
 * One group from dapp.json, or throw. People are kept as written (order and
 * case), less blanks and repeats.
 */
function parseGroup(raw, i) {
  if (!isPlainObject(raw)) throw new RulesError(`governance.groups[${i}] must be an object`);
  const name = cleanName(raw.name);
  if (!name) throw new RulesError(`governance.groups[${i}] needs a name`);
  if (name.length > GROUP_NAME_MAX) throw new RulesError(`A group's name is at most ${GROUP_NAME_MAX} characters`);
  if (BUILT_IN_GROUPS.includes(groupKey(name))) {
    throw new RulesError(`"${name}" is a built-in group; name yours something else`);
  }
  const people = raw.people == null ? [] : raw.people;
  if (!Array.isArray(people)) throw new RulesError(`governance.groups[${i}].people must be a list of usernames`);
  const seen = new Set();
  const out = [];
  for (const p of people) {
    if (typeof p !== 'string') throw new RulesError(`governance.groups[${i}].people must be a list of usernames`);
    const u = cleanUsername(p);
    if (!u) continue;
    if (u.length > USERNAME_MAX) throw new RulesError(`@${u.slice(0, 24)}… is not a username`);
    const k = u.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(u);
  }
  if (out.length > MAX_GROUP_PEOPLE) throw new RulesError(`A group holds at most ${MAX_GROUP_PEOPLE} people`);
  return { name, people: out };
}

/**
 * One rule from dapp.json, normalised to `{ group, kind, n }` (`group` is a
 * built-in key or a named group's key; `n` is null for majority), or throw.
 */
function parseRule(raw, i, groupKeys) {
  if (!isPlainObject(raw)) throw new RulesError(`governance.rules[${i}] must be an object`);
  const g = typeof raw.group === 'string' ? groupKey(raw.group) : '';
  if (!g) throw new RulesError(`governance.rules[${i}] needs a group`);
  if (!BUILT_IN_GROUPS.includes(g) && !groupKeys.has(g)) {
    throw new RulesError(`governance.rules[${i}] names a group that is not in governance.groups: "${raw.group}"`);
  }
  const present = MEASURES.filter((m) => raw[m] != null);
  if (present.length !== 1) {
    throw new RulesError(`governance.rules[${i}] needs exactly one of atLeast, percentOfActive, percentOfEveryone or majority`);
  }
  const kind = present[0];
  const v = raw[kind];
  if (kind === 'majority') {
    if (v !== true) throw new RulesError(`governance.rules[${i}].majority must be true`);
    return { group: g, kind, n: null };
  }
  if (kind === 'atLeast') {
    if (!Number.isInteger(v) || v < 1 || v > MAX_AT_LEAST) {
      throw new RulesError(`governance.rules[${i}].atLeast must be a whole number from 1 to ${MAX_AT_LEAST}`);
    }
    return { group: g, kind, n: v };
  }
  if (!Number.isInteger(v) || v < 1 || v > 100) {
    throw new RulesError(`governance.rules[${i}].${kind} must be a whole number from 1 to 100`);
  }
  return { group: g, kind, n: v };
}

/**
 * The rules half of a dapp.json governance block, strictly: returns null when
 * the block has neither `preset` nor `rules` (it is an old-style block, or
 * none), else `{ preset, groups, rules }` with `preset` null for rules of a
 * project's own. Throws RulesError on anything it cannot read.
 */
function parseRulesBlock(raw) {
  if (raw == null) return null;
  if (!isPlainObject(raw)) throw new RulesError('governance must be an object');
  const hasPreset = raw.preset != null;
  const hasRules = raw.rules != null;
  if (!hasPreset && !hasRules) {
    if (raw.groups != null) throw new RulesError('governance.groups needs governance.rules beside it');
    return null;
  }
  if (hasPreset && hasRules) throw new RulesError('governance takes a preset or rules, not both');
  if (hasPreset) {
    if (typeof raw.preset !== 'string' || !PRESET_KEYS.includes(raw.preset)) {
      throw new RulesError(`governance.preset must be one of ${PRESET_KEYS.join(', ')}`);
    }
    if (raw.groups != null) throw new RulesError('governance.groups goes with governance.rules, not a preset');
    return { preset: raw.preset, groups: [], rules: PRESETS[raw.preset].map((r) => ({ ...r })) };
  }
  const groupsRaw = raw.groups == null ? [] : raw.groups;
  if (!Array.isArray(groupsRaw)) throw new RulesError('governance.groups must be a list');
  if (groupsRaw.length > MAX_GROUPS) throw new RulesError(`A project has at most ${MAX_GROUPS} groups of its own`);
  const groups = groupsRaw.map(parseGroup);
  const keys = new Set();
  for (const g of groups) {
    const k = groupKey(g.name);
    if (keys.has(k)) throw new RulesError(`Two groups are called "${g.name}"`);
    keys.add(k);
  }
  if (!Array.isArray(raw.rules)) throw new RulesError('governance.rules must be a list');
  if (!raw.rules.length) throw new RulesError('governance.rules needs at least one rule');
  if (raw.rules.length > MAX_RULES) throw new RulesError(`A project has at most ${MAX_RULES} rules`);
  const rules = raw.rules.map((r, i) => parseRule(r, i, keys));
  const seenRule = new Set();
  for (const r of rules) {
    const k = ruleSignature(r);
    if (seenRule.has(k)) throw new RulesError('The same rule is listed twice');
    seenRule.add(k);
  }
  return { preset: null, groups, rules };
}

/**
 * The same read, leniently, for the deploy-time reader: a block it cannot
 * read is reported and left out (`{ value: null, error }`), never thrown, so
 * a typo in dapp.json can never fail a deploy. The caller keeps the rule the
 * project already has.
 */
function readRulesBlock(raw) {
  try {
    return { value: parseRulesBlock(raw), error: null };
  } catch (err) {
    if (err instanceof RulesError) return { value: null, error: err.message };
    throw err;
  }
}

function ruleSignature(r) {
  return `${r.group}:${r.kind}:${r.kind === 'majority' ? '' : r.n}`;
}

/** The preset a rule list is the same as, or null. Order does not matter. */
function matchPreset(rules) {
  if (!Array.isArray(rules) || !rules.length) return null;
  const sig = rules.map(ruleSignature).sort().join('|');
  for (const key of PRESET_KEYS) {
    if (PRESETS[key].map(ruleSignature).sort().join('|') === sig) return key;
  }
  return null;
}

/**
 * The dapp.json block for a rules value (`{ preset }` or `{ groups, rules }`),
 * canonical: a rule list that is a preset, with no groups of its own, is
 * written as the preset. Every group is written, including one no rule
 * names yet: its people are still a choice somebody made.
 */
function blockFor({ preset = null, groups = [], rules = [] } = {}) {
  const same = preset || (groups.length ? null : matchPreset(rules));
  if (same) return { preset: same };
  const nameOf = new Map(groups.map((g) => [groupKey(g.name), g.name]));
  const out = {};
  if (groups.length) out.groups = groups.map((g) => ({ name: g.name, people: [...g.people] }));
  out.rules = rules.map((r) => {
    const group = BUILT_IN_GROUPS.includes(r.group) ? r.group : (nameOf.get(r.group) || r.group);
    return r.kind === 'majority' ? { group, majority: true } : { group, [r.kind]: r.n };
  });
  return out;
}

/**
 * A rules value as apps.governance_rules stores it, given each named group's
 * resolved user ids (`idsByGroup`: group key -> ids; app-manifest.js
 * storedRules resolves them). A preset has no groups, so it needs none.
 */
function storedForm(value, idsByGroup = new Map()) {
  return {
    preset: value.preset || null,
    groups: (value.groups || []).map((g) => ({
      name: g.name,
      people: [...(g.people || [])],
      ids: [...(idsByGroup.get(groupKey(g.name)) || [])],
    })),
    rules: (value.rules || []).map((r) => ({ group: r.group, kind: r.kind, n: r.kind === 'majority' ? null : r.n })),
  };
}

/** "You or the group"; a project's own rules are "its own rules". */
function describeRules(value) {
  if (!value) return 'the default time-&-majority vote';
  const preset = value.preset || matchPreset(value.rules);
  if (preset && !(value.groups || []).length) return PRESET_NAMES[preset];
  const n = (value.rules || []).length;
  return `its own rules (${n} rule${n === 1 ? '' : 's'})`;
}

// ── Evaluation ──────────────────────────────────────────────────────────

/**
 * A group's people and the votes from them, for one proposal. `facts` is
 * what governance.js read about the app (rulesFacts):
 *
 *   creatorId     the creator, or null (nobody: the platform's own app, or
 *                 a deleted account);
 *   memberCount   people in its community;
 *   membersActive the active-member electorate (getActiveUserStats), >= 1;
 *   adminIds      app admins;
 *   groups        Map of named-group key -> user ids;
 *   activeIds     Set of active people, or null when not read (then a named
 *                 group's active count is its size).
 *
 * `voters` is `{ yes: Set, no: Set }` of the counted votes' user ids, or
 * null when the caller has only counts (`counts`: { yes, no }), which can
 * answer the members group and nothing else.
 */
function groupTally(group, { facts, voters, counts }) {
  if (group === 'members') {
    const size = Math.max(parseInt(facts.memberCount, 10) || 0, 0);
    return {
      size,
      // Every counted vote, as Group vote always counted them: writing a
      // vote already requires membership (communities.requireSessionMembership).
      yes: voters ? voters.yes.size : (counts.yes || 0),
      no: voters ? voters.no.size : (counts.no || 0),
      active: Math.max(parseInt(facts.membersActive, 10) || 0, 1),
      ids: null,
      known: true,
    };
  }
  let ids;
  if (group === 'creator') ids = facts.creatorId ? [facts.creatorId] : [];
  else if (group === 'admins') ids = facts.adminIds || [];
  else ids = (facts.groups && facts.groups.get(group)) || [];
  const uniq = [...new Set(ids)];
  if (!voters) return { size: uniq.length, yes: 0, no: 0, active: uniq.length, ids: uniq, known: false };
  const active = facts.activeIds ? uniq.filter((id) => facts.activeIds.has(id)).length : uniq.length;
  return {
    size: uniq.length,
    yes: uniq.filter((id) => voters.yes.has(id)).length,
    no: uniq.filter((id) => voters.no.has(id)).length,
    active,
    ids: uniq,
    known: true,
  };
}

/** Whether the author belongs to the group, for the counted yes. */
function authorIn(group, tally, facts, authorId) {
  if (authorId == null) return false;
  if (group === 'members') return true;
  return !!tally.ids && tally.ids.includes(authorId);
}

/**
 * Evaluate one rule. `ctx`: { facts, voters, counts, authorId, openedAt,
 * now, noTimers, memberFloor (null | { applies, met }), mergeGate,
 * applyNoTimerMerge }. Returns the rule's own status:
 *   { group, kind, n, size, yes, no, need, passed, empty, gate }
 * where `gate` is the mergeGate object for a majority rule.
 */
function evaluateRule(rule, ctx) {
  const tally = groupTally(rule.group, ctx);
  let yes = tally.yes;
  // Proposing counts as a yes on the counted rules (see the header), unless
  // the author voted No, or already said yes.
  const counted = rule.kind !== 'majority';
  let authorYes = false;
  if (counted && ctx.voters && authorIn(rule.group, tally, ctx.facts, ctx.authorId)
    && !ctx.voters.yes.has(ctx.authorId) && !ctx.voters.no.has(ctx.authorId)) {
    yes += 1;
    authorYes = true;
  }
  const base = {
    group: rule.group, kind: rule.kind, n: rule.n, size: tally.size, yes, no: tally.no,
    authorYes, empty: tally.size === 0, known: tally.known,
  };
  if (tally.size === 0 && rule.group !== 'members') {
    return { ...base, need: null, passed: false, gate: null };
  }
  if (rule.kind === 'majority') {
    const electorate = rule.group === 'members' ? tally.active : Math.max(tally.size, 1);
    let gate = ctx.mergeGate(electorate, yes, tally.no, ctx.openedAt, ctx.now);
    if (ctx.noTimers) gate = ctx.applyNoTimerMerge(gate, ctx.memberFloor);
    return { ...base, need: gate.required, passed: tally.known && !!gate.mergeable, gate };
  }
  let need;
  if (rule.kind === 'atLeast') need = Math.min(rule.n, Math.max(tally.size, 1));
  else if (rule.kind === 'percentOfEveryone') need = Math.max(1, Math.ceil((rule.n / 100) * tally.size));
  else need = Math.max(1, Math.ceil((rule.n / 100) * Math.max(tally.active, 1)));
  return { ...base, need, passed: tally.known && yes >= need, gate: null };
}

/**
 * The gate for one proposal under a rules value, shaped exactly like
 * active-users.js mergeGate's return so every consumer reads one object:
 * the clocks and the takedown come from the rule that owns them (the first
 * majority rule, else the first rule, under an at-least gate), and
 * `mergeable` is whether ANY rule passes. A proposal some rule passes is
 * never auto-rejected out from under it.
 *
 * `opts`:
 *   value          { rules } (the app's, or WHO_DECIDES for a change to who decides)
 *   facts, voters, counts, authorId, openedAt, now
 *   noTimers       the explicit-approval modifier: no quiet wait, no window
 *   memberFloor    the floor for the majority rules of a flagged proposal
 *   mergeGate, applyNoTimerMerge, atLeastGate   governance.js's own
 */
function evaluateRules(opts) {
  const rules = opts.value.rules;
  const results = rules.map((r) => evaluateRule(r, opts));
  const owner = results.find((r) => r.kind === 'majority') || results[0];
  let gate;
  if (owner.gate) {
    gate = owner.gate;
  } else {
    gate = opts.atLeastGate(owner.need || 1, owner.yes, owner.no, opts.openedAt, opts.now);
    if (owner.need == null) gate = { ...gate, thresholdMet: false, mergeable: false };
  }
  const passedBy = results.find((r) => r.passed) || null;
  const mergeable = !!passedBy;
  // Let in by another rule than the one that owns the clocks (the creator's
  // yes on You or the group): the owner's wait and threshold no longer apply,
  // so every surface that reads them sees a proposal that is through.
  const byOther = !!passedBy && passedBy !== owner;
  return {
    gate: {
      ...gate,
      required: owner.need != null ? owner.need : gate.required,
      thresholdMet: owner.passed || (!!gate.thresholdMet && owner.known),
      mergeable,
      ...(byOther ? {
        // Said in the terms of the rule that let it in ("1 of 1": the
        // creator's yes), which is the count `shown` reports beside it.
        required: passedBy.need,
        thresholdMet: true,
        windowMs: 0,
        windowEndsAt: null,
        windowElapsed: true,
        lazyArmed: false,
        lazyWindowMs: null,
      } : {}),
      // Any rule passing keeps it alive (atLeastGate's keep-alive, for every rule).
      ...(mergeable ? { rejectionArmed: false, rejectionWindowMs: null, rejectionEndsAt: null, rejectable: false } : {}),
    },
    owner,
    // The rule a surface counts for: the one that let it in, else the owner.
    shown: passedBy || owner,
    results,
    passedBy,
    partial: results.some((r) => !r.known),
  };
}

module.exports = {
  PRESET_KEYS,
  PRESETS,
  PRESET_NAMES,
  DEFAULT_PRESET,
  WHO_DECIDES,
  BUILT_IN_GROUPS,
  MAX_RULES,
  MAX_GROUPS,
  MAX_GROUP_PEOPLE,
  MAX_AT_LEAST,
  GROUP_NAME_MAX,
  RulesError,
  groupKey,
  parseRulesBlock,
  readRulesBlock,
  matchPreset,
  blockFor,
  storedForm,
  describeRules,
  evaluateRule,
  evaluateRules,
};
