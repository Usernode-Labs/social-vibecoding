/**
 * `?shot=hub-first-week`: a project's hub in its first week, for the
 * before/after shots (#4045, #4074).
 *
 * Only a brand-new project reaches that hub, and only while Homeroom bot
 * builds its first version: a person who just made it, or who just joined
 * it, with a plan waiting. No staging copy has one, and the shots copies run
 * no model, so the state is drawn here the way AppView.showFirstVersionShot
 * draws `?shot=first-version`: the hub's one read (GET /api/apps/:slug/
 * community, ./community-card.tsx readCommunity) answers this made-up
 * community instead of the server's, for whatever project the address
 * names. Nothing behind it is real: Review the plan opens Messages, and its
 * channel has no composer.
 *
 *   hub-first-week           as the person who started it, its plan waiting
 *   hub-first-week-member    as somebody who joined: Planning it, See the plan
 *                            (with `&ws=plan`, the plan itself, read only)
 *   hub-first-week-question  as the person who started it, Homeroom bot
 *                            waiting on their answer to a question
 *   hub-first-week-link      as the person who started it, nobody else in
 *                            yet, an invite link out: "Just you so far",
 *                            and Share it saying the link is out
 *   hub-version              a version of Tier list (docs/plans/versions.md),
 *                            as its maker: "Made from Tier list · Gets its
 *                            updates" in the hero, and the Update card for
 *                            Tier list's latest, not yet looked at
 *   hub-original             Tier list itself, as one of its approvers: "214
 *                            versions · 160 get its updates" in the hero, and
 *                            From its versions (suggestions, lately, the
 *                            last update)
 *
 * The two versions shots answer the cards' own reads too (GET
 * /api/apps/:slug/upstream and /versions, ../../versions/upstream.ts), with
 * the made-up states below.
 *
 * The hub is drawn the same from a project's first day (15 Oct 2026); the
 * shots keep their names.
 */

import type { CommunityPayload } from './community-card';

export type HubShot = 'creator' | 'member' | 'question' | 'link' | 'version' | 'original';

const SHOTS: Readonly<Record<string, HubShot>> = Object.freeze({
  'hub-first-week': 'creator',
  'hub-first-week-member': 'member',
  'hub-first-week-question': 'question',
  'hub-first-week-link': 'link',
  'hub-version': 'version',
  'hub-original': 'original',
});

/** Which hub shot the address asks for, or null. */
export function hubShot(search: string = typeof location !== 'undefined' ? location.search : ''): HubShot | null {
  try {
    const shot = new URLSearchParams(search).get('shot') || '';
    return Object.prototype.hasOwnProperty.call(SHOTS, shot) ? SHOTS[shot] : null;
  } catch {
    return null;
  }
}

/** The plan members read in the shot: the canvas's (4b · The plan, for members). */
export const SHOT_PLAN = Object.freeze({
  bullets: Object.freeze([
    'Everyone’s miles this week',
    'Log a run for any day',
    'Each runner’s miles against their goal',
    'Past weeks, to see who keeps up',
  ]) as unknown as string[],
  questions: Object.freeze([
    Object.freeze({ question: 'What counts as keeping up?', suggested: 'Each runner picks their own goal' }),
  ]) as unknown as Array<{ question: string; suggested: string | null }>,
});

/** The two versions shots' made-up original (docs/plans/versions.md). */
const SHOT_ORIGINAL = Object.freeze({ slug: 'tier-list', name: 'Tier list', emoji: '🏆', iconUrl: null });

/**
 * `hub-version`'s GET /api/apps/:slug/upstream: a version that gets Tier
 * list's updates, with its latest not yet looked at. Null for any other
 * shot. Pure.
 */
export function hubShotUpstream(kind: HubShot | null): Record<string, unknown> | null {
  if (kind !== 'version') return null;
  return {
    enabled: true,
    original: { ...SHOT_ORIGINAL },
    following: true,
    share: false,
    canManage: true,
    private: true,
    behind: true,
    offer: {
      state: 'available',
      sessionId: null,
      href: null,
      fromSha: '5f1c0de5f1c0de5f1c0de5f1c0de5f1c0de5f1c0',
      brings: [
        { title: 'Other people: pick anyone in the group and see their whole board' },
        { title: 'Comments on each item, with @mentions' },
        { title: 'A help sheet, from a small ? beside the title' },
      ],
      facts: { tablesAdded: ['comments'], destructive: [], hostsAdded: [], secretsAdded: [], ai: false, storage: false },
      keeps: { count: 3, titles: ['Rate out of 10, not S to F', 'Who suggested each book'] },
      conflicts: [],
    },
  };
}

/**
 * `hub-original`'s GET /api/apps/:slug/versions: Tier list, with two
 * suggestions in from its versions. Null for any other shot. Pure.
 */
export function hubShotVersions(kind: HubShot | null, now: number = Date.now()): Record<string, unknown> | null {
  if (kind !== 'original') return null;
  const ago = (min: number) => new Date(now - min * 60000).toISOString();
  return {
    count: 214,
    following: 160,
    suggestions: [
      { sessionId: 990942, href: '#app/tier-list/dev/proposals/990942', title: 'Rate out of 10', from: { slug: 'book-club-picks', name: 'Book club picks' } },
      { sessionId: 990943, href: '#app/tier-list/dev/proposals/990943', title: 'Show who added each item', from: { slug: 'book-club-picks', name: 'Book club picks' } },
    ],
    lately: {
      versions: 31,
      changes: 46,
      rows: [{ title: 'Comments on items', from: { slug: 'board-game-night', name: 'Board game night' }, at: ago(90) }],
    },
    lastUpdate: { offered: 160, took: 98, skipped: 12, deciding: 50 },
  };
}

/** The made-up community a hub shot draws, for `slug`. Pure. */
export function hubShotPayload(slug: string, kind: HubShot, now: number = Date.now()): CommunityPayload {
  if (kind === 'version' || kind === 'original') return versionsShotPayload(slug, kind, now);
  const maker = kind !== 'member';
  // A link out and nobody in yet: Just you so far, Share it saying so.
  const alone = kind === 'link';
  const ago = (min: number) => new Date(now - min * 60000).toISOString();
  return {
    slug,
    name: 'Sunday Run Club',
    description: 'Track your club’s weekly miles and see who keeps up',
    first_version: {
      step: kind === 'question' ? 2 : 3,
      of: 7,
      line: kind === 'member' ? 'plan-member' : kind === 'question' ? 'question' : 'plan',
      ready: false,
      mine: maker,
      creator: 'salah_t1006',
      waits_on: kind === 'member' ? null : kind === 'question' ? 'question' : 'plan',
      conversation_id: null,
      session_id: null,
      plan: kind === 'member' ? { bullets: [...SHOT_PLAN.bullets], questions: SHOT_PLAN.questions.map((q) => ({ ...q })) } : null,
    },
    invite_link: alone,
    // The link out: made a minute ago, for a week, nobody in through it yet.
    invite_summary: alone
      ? { links: 1, joined: 0, waiting: 0, expires_at: new Date(now + 7 * 24 * 60 * 60000 - 60000).toISOString() }
      : null,
    member_count: alone ? 1 : 3,
    is_member: true,
    is_creator: maker,
    audience: alone ? 'solo' : 'invited',
    audience_label: alone ? 'Just you' : 'Private community',
    members: alone ? [{ id: 990901, username: 'salah_t1006' }] : [
      { id: 990901, username: 'salah_t1006' },
      { id: 990902, username: 'imrichl' },
      { id: 990903, username: 'evan_t1006' },
    ],
    channel: {
      last_message: alone ? null : 'Hi, in for Sundays',
      last_at: alone ? null : ago(12),
      last_by: alone ? null : 'imrichl',
      unread_count: 0,
      recent: alone ? [] : [{ id: 990904, content: 'Hi, in for Sundays', created_at: ago(12), by: 'imrichl' }],
      href: `#messages/app/${encodeURIComponent(slug)}`,
      handle: null,
      post_url: null,
    },
    activity: { active_week: 3, shipped_month: 0, daily: [] },
    can_manage: maker,
    audience_change: null,
    approval: { policy: 'anyone', approvals_required: null, electorate: 3, required: 2 },
  };
}

/**
 * The versions shots' community: a private community's version of Tier list
 * ("Made from Tier list · Gets its updates"), or Tier list itself, public,
 * with its versions counted. Pure.
 */
function versionsShotPayload(slug: string, kind: 'version' | 'original', now: number): CommunityPayload {
  const version = kind === 'version';
  const ago = (min: number) => new Date(now - min * 60000).toISOString();
  const people = version
    ? ['maya_t1028', 'dev_t1028', 'rosa_t1028', 'kwame_t1028']
    : ['evan_t1028', 'salah_t1028', 'maya_t1028', 'priya_t1028', 'jonas_t1028'];
  const members = people.map((username, i) => ({ id: 990910 + i, username }));
  const line = version ? 'Can we add the March book before Thursday?' : 'The help sheet is live for everyone';
  return {
    slug,
    name: version ? 'Book club picks' : SHOT_ORIGINAL.name,
    description: version ? 'Every book we have read, ranked together' : 'Rank anything together, S to F',
    first_version: null,
    invite_link: false,
    invite_summary: null,
    live_since: ago(60 * 24 * 40),
    member_count: members.length,
    is_member: true,
    is_creator: version,
    audience: version ? 'invited' : 'open',
    audience_label: version ? 'Private community' : 'Public community',
    members,
    channel: {
      last_message: line,
      last_at: ago(95),
      last_by: people[1],
      unread_count: 0,
      recent: [{ id: 990920, content: line, created_at: ago(95), by: people[1] }],
      href: `#messages/app/${encodeURIComponent(slug)}`,
      handle: null,
      post_url: null,
    },
    activity: { active_week: 3, shipped_month: 2, daily: [] },
    can_manage: true,
    audience_change: null,
    approval: { policy: 'anyone', approvals_required: null, electorate: members.length, required: 2 },
    made_from: version ? { slug: SHOT_ORIGINAL.slug, name: SHOT_ORIGINAL.name, following: true } : null,
    versions: version ? null : { count: 214, following: 160 },
  };
}
