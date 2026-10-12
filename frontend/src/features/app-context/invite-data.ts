/**
 * What the invite pane (./invite-pane.tsx) shows, read BEFORE the sheet goes
 * up, so the sheet goes up once, at the height it ends at.
 *
 * ── Why it is read first ──────────────────────────────────────────────
 *
 * On a phone the menu is a kit sheet, and the kit measures its content once,
 * when it presents, and springs up to that height. Content that grows later
 * is measured again (public/usernode-native/v1/native.js, `watchSize`): the
 * sheet slides up a second time from where it stood, and the dim, which is
 * 1 - offset / height, drops back by the share of the sheet that was added
 * and fades in again. The pane used to open on its one-line "Making your
 * link…" and grow to its full height when the link arrived, about 200ms
 * later: a short rise, then a second, taller one, with the dim restarting
 * between them (the hub's Invite, October 2026).
 *
 * So `AppContext.openInvite()` asks for the pane's state here first and
 * presents once it has it, or after a short wait, whichever is sooner. The
 * pane takes the answer on its FIRST render (`preparedInvite`), so the height
 * the kit measures is the height it keeps. When the wait runs out first, the
 * pane stands its skeleton, drawn at the loaded pane's own rows, and joins
 * the same read rather than starting another.
 *
 * ONE READ PER OPENING. Opening the pane makes the viewer's first link when
 * they have none, so two reads racing would make two links; a second ask
 * while one is on its way gets the same promise.
 */

import { t } from '../../lib/i18n/runtime';

export type InviteLink = {
  id: number;
  token: string;
  path: string;
  /** null: any number of people (WP-D). */
  maxUses: number | null;
  uses: number;
  /** null: no end date; it works until it is turned off (WP-D). */
  expiresAt: string | null;
  createdBy: string | null;
  mine: boolean;
};

export type InviteState = {
  links: InviteLink[];
  manages: boolean;
  canCreate: boolean;
  grant: 'member' | 'collaborator';
  defaults: { days: number; maxUses: number };
  limits: { minDays: number; maxDays: number; minUses: number; maxUses: number };
  /** WP-D: what joining means here, from the project's real rule. */
  joiningRule?: string | null;
};

/** How an opening's read came out: the state, or what to say instead. */
export type InviteOutcome = {
  slug: string;
  state: InviteState | null;
  error: string | null;
};

export async function inviteApi(url: string, init?: RequestInit): Promise<any> {
  const res = await fetch(url, { credentials: 'same-origin', ...init });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error || t('agent:appContext.invite.error.generic'));
  return body;
}

export function inviteLinksUrl(slug: string): string {
  return `/api/apps/${encodeURIComponent(slug)}/invite-links`;
}

/**
 * The pane's state. `makeIfNone` makes the viewer's first link when they may
 * and have none, which is what opening the pane does.
 *
 * The new link goes on the front of the list the first read returned rather
 * than costing a second read: POST answers with the link exactly as GET lists
 * it (services/community-invites.js `serializeLink`), and GET lists newest
 * first. One round trip fewer is the difference between the sheet waiting for
 * its link and going up without it.
 */
export async function readInviteState(slug: string, makeIfNone: boolean): Promise<InviteState> {
  const base = inviteLinksUrl(slug);
  const state: InviteState = await inviteApi(base);
  if (!makeIfNone || !state.canCreate || state.links.some((l) => l.mine)) return state;
  const made = await inviteApi(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  if (made?.link) return { ...state, links: [made.link as InviteLink, ...state.links] };
  return inviteApi(base);
}

let opening: { slug: string; promise: Promise<InviteOutcome> } | null = null;
let settled: InviteOutcome | null = null;

/**
 * Start this opening's read for `slug`, or join the one on its way. Never
 * rejects: a failure is an outcome with an `error`, which the pane shows.
 */
export function prepareInvite(slug: string): Promise<InviteOutcome> {
  if (opening && opening.slug === slug) return opening.promise;
  // A new opening never shows the last one's answer.
  settled = null;
  const promise: Promise<InviteOutcome> = readInviteState(slug, true).then(
    (state) => ({ slug, state, error: null }),
    (err) => ({ slug, state: null, error: (err as Error)?.message || t('agent:appContext.invite.error.generic') }),
  ).then((outcome) => {
    if (opening && opening.promise === promise) {
      opening = null;
      settled = outcome;
    }
    return outcome;
  });
  opening = { slug, promise };
  return promise;
}

/** This opening's answer for `slug`, if it has come; read, not taken. */
export function preparedInvite(slug: string): InviteOutcome | null {
  return settled && settled.slug === slug ? settled : null;
}

/** The pane has it: the next opening reads again. */
export function forgetPreparedInvite(): void {
  settled = null;
}
