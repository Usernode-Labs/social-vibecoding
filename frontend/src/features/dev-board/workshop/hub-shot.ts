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
 *                            yet, an invite link out: their face between
 *                            open seats
 */

import type { CommunityPayload } from './community-card';

export type HubShot = 'creator' | 'member' | 'question' | 'link';

const SHOTS: Readonly<Record<string, HubShot>> = Object.freeze({
  'hub-first-week': 'creator',
  'hub-first-week-member': 'member',
  'hub-first-week-question': 'question',
  'hub-first-week-link': 'link',
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

/** The made-up community a hub shot draws, for `slug`. Pure. */
export function hubShotPayload(slug: string, kind: HubShot, now: number = Date.now()): CommunityPayload {
  const maker = kind !== 'member';
  // A link out and nobody in yet: Just you, with the link's seats.
  const alone = kind === 'link';
  const ago = (min: number) => new Date(now - min * 60000).toISOString();
  return {
    slug,
    name: 'Sunday Run Club',
    description: 'Track your club’s weekly miles and see who keeps up',
    first_week: true,
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
