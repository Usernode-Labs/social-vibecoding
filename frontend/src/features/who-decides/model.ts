/**
 * #4666, WHO SAYS YES: the approval presets and a project's own rules, as the
 * screens draw them. The rules themselves are the server's
 * (src/services/governance-rules.js): this file mirrors its preset table and
 * its canonical block, and says each rule in words. Pure, so the wording is
 * tested without a browser (tests/who-decides-model.test.js).
 */

import { t as translate } from '../../lib/i18n/runtime';

export type PresetKey = 'you_or_the_group' | 'two_yeses' | 'open_floor' | 'group_vote';
export type Kind = 'atLeast' | 'percentOfActive' | 'percentOfEveryone' | 'majority';

/**
 * A rule: whose yes, and how many. `group` is a built-in key or a named group's
 * key; `min`, on a majority or a share that has one, is the fewest yeses it
 * goes live on.
 */
export interface Rule { group: string; kind: Kind; n: number | null; min?: number | null }
/** A named group, by the usernames in it. */
export interface Group { name: string; people: string[] }
/** A rule list, with the groups it can name. `preset` when it is one by name. */
export interface RulesValue { preset: PresetKey | null; groups: Group[]; rules: Rule[] }

export const PRESET_KEYS: readonly PresetKey[] = ['you_or_the_group', 'two_yeses', 'open_floor', 'group_vote'];
export const DEFAULT_PRESET: PresetKey = 'you_or_the_group';
export const BUILT_IN_GROUPS = ['creator', 'members', 'admins'] as const;
export const MAX_RULES = 5;
export const MAX_GROUPS = 10;
export const MAX_AT_LEAST = 50;
/** The smallest minimum a rule takes (the server's MIN_MINIMUM). */
export const MIN_MINIMUM = 2;
export const GROUP_NAME_MAX = 32;

/** The server's table (governance-rules.js PRESETS), rule for rule. */
export const PRESETS: Record<PresetKey, readonly Rule[]> = {
  you_or_the_group: [{ group: 'creator', kind: 'atLeast', n: 1 }, { group: 'members', kind: 'majority', n: null }],
  two_yeses: [{ group: 'members', kind: 'atLeast', n: 2 }],
  open_floor: [{ group: 'members', kind: 'atLeast', n: 1 }],
  group_vote: [{ group: 'members', kind: 'majority', n: null }],
};

/** A named group's key: the server's groupKey (case-folded, spaces collapsed). */
export function groupKey(name: string): string {
  return String(name || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

export function isBuiltIn(group: string): boolean {
  return (BUILT_IN_GROUPS as readonly string[]).includes(group);
}

/** What tells two rules apart, the server's ruleSignature: a minimum makes a different rule. */
export function ruleSignature(r: Rule): string {
  return `${r.group}:${r.kind}:${r.kind === 'majority' ? '' : r.n}${minOf(r) != null ? `:min${minOf(r)}` : ''}`;
}

/** A rule's minimum, or null: an "at least" rule never has one. */
export function minOf(r: Rule): number | null {
  return r.kind !== 'atLeast' && r.min != null ? r.min : null;
}

/** The preset a rule list is the same as, in any order, or null. */
export function matchPreset(rules: readonly Rule[]): PresetKey | null {
  if (!rules.length) return null;
  const sig = rules.map(ruleSignature).sort().join('|');
  for (const key of PRESET_KEYS) {
    if (PRESETS[key].map(ruleSignature).sort().join('|') === sig) return key;
  }
  return null;
}

/** A preset as a value to edit: its rules, copied, and no groups. */
export function presetValue(key: PresetKey): RulesValue {
  return { preset: key, groups: [], rules: PRESETS[key].map((r) => ({ ...r })) };
}

/**
 * The value as dapp.json's `governance` block, the server's blockFor: a rule
 * list that is a preset, with no groups, is sent as the preset.
 */
export function blockFor(value: RulesValue): Record<string, unknown> {
  const same = !value.groups.length ? (value.preset || matchPreset(value.rules)) : null;
  if (same) return { preset: same };
  const nameOf = new Map(value.groups.map((g) => [groupKey(g.name), g.name]));
  const out: Record<string, unknown> = {};
  if (value.groups.length) out.groups = value.groups.map((g) => ({ name: g.name, people: [...g.people] }));
  out.rules = value.rules.map((r) => {
    const group = isBuiltIn(r.group) ? r.group : (nameOf.get(r.group) || r.group);
    const rule: Record<string, unknown> = r.kind === 'majority' ? { group, majority: true } : { group, [r.kind]: r.n };
    if (minOf(r) != null) rule.minimum = minOf(r);
    return rule;
  });
  return out;
}

/** Whether two values decide the same way (what the server would see as no change). */
export function sameValue(a: RulesValue | null, b: RulesValue | null): boolean {
  if (!a || !b) return a === b;
  return JSON.stringify(blockFor(a)) === JSON.stringify(blockFor(b));
}

/** The approval block the project's page reads (GET /api/apps/:slug/community). */
export interface ApprovalPayload {
  policy: 'anyone' | 'invited';
  approvals_required: number | null;
  electorate: number;
  required: number;
  mode?: 'rules' | 'columns';
  preset?: PresetKey | null;
  rules?: Array<Rule & { size?: number; need?: number | null; empty?: boolean }> | null;
  groups?: Array<{ name: string; key?: string; people: string[] }>;
  creator?: { id: number; username: string; display_name?: string | null } | null;
  /** Invited approvers' usernames, for a viewer who may read the roster;
      null otherwise, and absent from an older server. */
  approvers?: string[] | null;
}

/**
 * The rule a project has, as a value to start from: its rules, or the preset
 * its old two settings are (the default rule is Group vote). Null for an old
 * setting no preset is (invited approvers, or at least N), which the sheet
 * shows as it is until something else is picked.
 */
export function currentValue(approval: ApprovalPayload | null | undefined): RulesValue | null {
  if (!approval) return null;
  if (approval.mode === 'rules' && Array.isArray(approval.rules) && approval.rules.length) {
    const groups = (approval.groups || []).map((g) => ({ name: g.name, people: [...(g.people || [])] }));
    const rules = approval.rules.map((r): Rule => {
      const rule: Rule = { group: r.group, kind: r.kind, n: r.kind === 'majority' ? null : r.n };
      return minOf(r) != null ? { ...rule, min: minOf(r) } : rule;
    });
    const preset = groups.length ? null : (approval.preset || matchPreset(rules));
    return { preset, groups, rules };
  }
  if (approval.policy === 'anyone' && approval.approvals_required == null) return presetValue('group_vote');
  return null;
}

/** The preset a value is by name, or null for rules of a project's own. */
export function presetOf(value: RulesValue | null): PresetKey | null {
  if (!value || value.groups.length) return null;
  return value.preset || matchPreset(value.rules);
}

// ── Words ────────────────────────────────────────────────────────────────

/** Each preset's messages, by id (frontend/locales/en/dialogs.json). */
const PRESET_IDS: Record<PresetKey, { name: string; line: string }> = {
  you_or_the_group: {
    name: 'dialogs:whoDecides.preset.you_or_the_group.name',
    line: 'dialogs:whoDecides.preset.you_or_the_group.line',
  },
  two_yeses: {
    name: 'dialogs:whoDecides.preset.two_yeses.name',
    line: 'dialogs:whoDecides.preset.two_yeses.line',
  },
  open_floor: {
    name: 'dialogs:whoDecides.preset.open_floor.name',
    line: 'dialogs:whoDecides.preset.open_floor.line',
  },
  group_vote: {
    name: 'dialogs:whoDecides.preset.group_vote.name',
    line: 'dialogs:whoDecides.preset.group_vote.line',
  },
};

/** The one "Anyone makes a change" line of each preset that treats every change alike. */
const PLAYS_ANYONE_IDS: Record<Exclude<PresetKey, 'you_or_the_group'>, string> = {
  two_yeses: 'dialogs:whoDecides.plays.two_yeses.anyone',
  open_floor: 'dialogs:whoDecides.plays.open_floor.anyone',
  group_vote: 'dialogs:whoDecides.plays.group_vote.anyone',
};

/** "You or the group" to its creator; "evan or the group" to everyone else. */
export function presetName(key: PresetKey, viewer: { isCreator: boolean; creator: string | null }): string {
  if (key === 'you_or_the_group' && !viewer.isCreator && viewer.creator) {
    return translate('dialogs:whoDecides.preset.you_or_the_group.nameOther', { creator: viewer.creator });
  }
  return translate(PRESET_IDS[key].name);
}

/** The tile's line under a preset's name. */
export function presetLine(key: PresetKey, viewer: { isCreator: boolean; creator: string | null }): string {
  if (key === 'you_or_the_group' && !viewer.isCreator) {
    return translate('dialogs:whoDecides.preset.you_or_the_group.lineOther', { creator: viewer.creator || translate('dialogs:whoDecides.group.creator') });
  }
  return translate(PRESET_IDS[key].line);
}

/** A group's name on screen: the built-ins by what they are, a named group by its own name. */
export function groupLabel(group: string, groups: readonly Group[]): string {
  if (group === 'creator') return translate('dialogs:whoDecides.group.creator');
  if (group === 'members') return translate('dialogs:whoDecides.group.members');
  if (group === 'admins') return translate('dialogs:whoDecides.group.admins');
  return groups.find((g) => groupKey(g.name) === group)?.name || group;
}

/** One rule as a sentence's clause, capitalised: "At least 2 people in Lifeguards say yes". */
export function rulePhrase(rule: Rule, ctx: { groups: readonly Group[]; creator: string | null }): string {
  if (rule.group === 'creator' && rule.kind !== 'majority') {
    return ctx.creator
      ? translate('dialogs:whoDecides.rule.phrase.creator', { creator: ctx.creator })
      : translate('dialogs:whoDecides.rule.phrase.creatorNobody');
  }
  const group = groupLabel(rule.group, ctx.groups);
  const min = minOf(rule);
  if (rule.kind === 'majority') {
    return min != null
      ? translate('dialogs:whoDecides.rule.phrase.majorityMin', { group, count: min })
      : translate('dialogs:whoDecides.rule.phrase.majority', { group });
  }
  if (rule.kind === 'percentOfActive') {
    return min != null
      ? translate('dialogs:whoDecides.rule.phrase.percentOfActiveMin', { group, percent: rule.n ?? 0, count: min })
      : translate('dialogs:whoDecides.rule.phrase.percentOfActive', { group, percent: rule.n ?? 0 });
  }
  if (rule.kind === 'percentOfEveryone') {
    return min != null
      ? translate('dialogs:whoDecides.rule.phrase.percentOfEveryoneMin', { group, percent: rule.n ?? 0, count: min })
      : translate('dialogs:whoDecides.rule.phrase.percentOfEveryone', { group, percent: rule.n ?? 0 });
  }
  return translate('dialogs:whoDecides.rule.phrase.atLeast', { group, count: rule.n ?? 1 });
}

/** How many people a group has, from what the screen knows. Null when it cannot say. */
export function groupSize(group: string, ctx: { groups: readonly Group[]; creator: string | null; memberCount: number; adminCount: number | null }): number | null {
  if (group === 'creator') return ctx.creator ? 1 : 0;
  if (group === 'members') return ctx.memberCount;
  if (group === 'admins') return ctx.adminCount;
  const g = ctx.groups.find((x) => groupKey(x.name) === group);
  return g ? g.people.length : 0;
}

/** What a rule asks for today, in one line under it. */
export function ruleToday(rule: Rule, ctx: { groups: readonly Group[]; creator: string | null; memberCount: number; adminCount: number | null }): string {
  const size = groupSize(rule.group, ctx);
  const group = groupLabel(rule.group, ctx.groups);
  if (size === 0) return translate('dialogs:whoDecides.rule.today.empty', { group });
  if (rule.group === 'creator' && rule.kind !== 'majority' && ctx.creator) {
    return translate('dialogs:whoDecides.rule.today.creator', { creator: ctx.creator });
  }
  // The minimum as it stands today: never more than the group has.
  const min = minOf(rule);
  const minNeed = min != null && size != null ? Math.min(min, Math.max(size, 1)) : min;
  if (rule.kind === 'majority') {
    return minNeed != null
      ? translate('dialogs:whoDecides.rule.today.majorityMin', { count: minNeed })
      : translate('dialogs:whoDecides.rule.today.majority');
  }
  if (rule.kind === 'percentOfActive') {
    return minNeed != null
      ? translate('dialogs:whoDecides.rule.today.percentOfActiveMin', { count: minNeed })
      : translate('dialogs:whoDecides.rule.today.percentOfActive');
  }
  if (size == null) return translate('dialogs:whoDecides.rule.today.unknown');
  if (rule.kind === 'percentOfEveryone') {
    const need = Math.max(1, Math.ceil(((rule.n ?? 0) / 100) * size), minNeed ?? 0);
    return translate('dialogs:whoDecides.rule.today.percentOfEveryone', { need, total: size });
  }
  const need = Math.min(rule.n ?? 1, Math.max(size, 1));
  return translate('dialogs:whoDecides.rule.today.atLeast', { count: need });
}

/**
 * What "How it plays out" says: one line for `anyone`, or one for the person
 * reading (`you`) and one for anyone else (`other`).
 */
export type PlaysOutLines = { anyone: string } | { you: string; other: string };

/**
 * What "How it plays out" says for one preset, or for a project's own rules
 * (`key` null) (#4894). Only You or the group treats a change by its creator
 * differently from anyone else's, so it says both, from the reader's side:
 * the reader's own change, then anyone else's. Two yeses, Open floor and
 * Group vote treat every change alike, and a project's own rules say in one
 * line how any change goes live, so each says it once, for anyone.
 */
export function playsOut(key: PresetKey | null, viewer: { isCreator: boolean; creator: string | null }): PlaysOutLines {
  if (!key) return { anyone: translate('dialogs:whoDecides.plays.own.anyone') };
  const values = { creator: viewer.creator || translate('dialogs:whoDecides.group.creator') };
  if (key === 'you_or_the_group' && !viewer.isCreator) {
    return {
      you: translate('dialogs:whoDecides.plays.you_or_the_group.youOther', values),
      other: translate('dialogs:whoDecides.plays.you_or_the_group.otherOther', values),
    };
  }
  if (key === 'you_or_the_group') {
    return {
      you: translate('dialogs:whoDecides.plays.you_or_the_group.you'),
      other: translate('dialogs:whoDecides.plays.you_or_the_group.other'),
    };
  }
  return { anyone: translate(PLAYS_ANYONE_IDS[key]) };
}

/** Problems with a value that the server would refuse, in words, or null. */
export function valueProblem(value: RulesValue): string | null {
  if (!value.rules.length) return translate('dialogs:whoDecides.own.problem.noRules');
  if (value.rules.length > MAX_RULES) return translate('dialogs:whoDecides.own.problem.tooManyRules', { max: MAX_RULES });
  if (value.groups.length > MAX_GROUPS) return translate('dialogs:whoDecides.own.problem.tooManyGroups', { max: MAX_GROUPS });
  const keys = new Set(value.groups.map((g) => groupKey(g.name)));
  for (const r of value.rules) {
    if (!isBuiltIn(r.group) && !keys.has(r.group)) return translate('dialogs:whoDecides.own.problem.missingGroup');
  }
  const seen = new Set<string>();
  for (const r of value.rules) {
    const s = ruleSignature(r);
    if (seen.has(s)) return translate('dialogs:whoDecides.own.problem.duplicate');
    seen.add(s);
  }
  return null;
}

/** Whether a named group's name can be used: blank, a built-in or a name taken by another group. */
export function groupNameProblem(name: string, groups: readonly Group[], editing: string | null): string | null {
  const clean = String(name || '').replace(/\s+/g, ' ').trim();
  if (!clean) return translate('dialogs:whoDecides.group.problem.blank');
  if (clean.length > GROUP_NAME_MAX) return translate('dialogs:whoDecides.group.problem.long', { max: GROUP_NAME_MAX });
  const key = groupKey(clean);
  if (isBuiltIn(key)) return translate('dialogs:whoDecides.group.problem.builtIn', { name: clean });
  if (groups.some((g) => groupKey(g.name) === key && groupKey(g.name) !== editing)) {
    return translate('dialogs:whoDecides.group.problem.taken');
  }
  return null;
}
