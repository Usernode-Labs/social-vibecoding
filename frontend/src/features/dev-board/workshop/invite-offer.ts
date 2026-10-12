/**
 * An invite link, followed into the page of the project it is for (#3700).
 *
 * Somebody signed in and not in a project yet, following a live link to it,
 * was asked "Join <name>?" over Home before they had seen anything of what
 * they were asked into. When the project's page is one they may already open
 * (a public community: the link's standing names it as `page`,
 * src/services/community-invites.js), App._followInvite opens that page
 * instead, in its not-joined state, and publishes the link here. The page's
 * hero (./community-card.tsx) then leads with who invited them and one
 * prominent "Join <name>", and that Join follows THIS link (POST
 * /api/invite-links/by-token/:token/redeem): the use is spent and the link's
 * maker hears who came in by it, as the confirm's Join did. "Not now" is
 * leaving the page. A private community's link opens its invite preview
 * instead (../../invite-preview), whose Join is this same joinByInvite.
 *
 * ── Why a store ────────────────────────────────────────────────────────
 *
 * The follow is legacy (public/js/app.js) and the page is React, so app.js
 * publishes through the dev board's bridge (../mount.ts) and the hero
 * subscribes. In memory only: the link's address has been replaced by the
 * page's, and a reload of the page is just the page, with its ordinary Join.
 *
 * ── After Join ─────────────────────────────────────────────────────────
 *
 * "You're in.", then the page's own landing (the hero's `onJoinedByInvite`,
 * ./workshop.tsx): Needs you at its first card when votes are already
 * waiting on the new member, else the hub they are on. An account the join
 * itself made new (a test account on its first sign-in) is shown "You're in"
 * from features/first-session instead, as the confirm showed it.
 */

import { useSyncExternalStore } from 'react';

import { t } from '../../../lib/i18n/runtime';

export type InviteOffer = {
  /** The link's token. Null for the `?shot=invite-join` capture, which follows nothing. */
  token: string | null;
  slug: string;
  name: string;
  inviter: string | null;
  inviterName: string | null;
  inviterMadeIt: boolean;
  /** Its first version is still on its way: "Maya is making it". */
  building: boolean;
  note: string | null;
  /**
   * The `?shot=invite-join` capture: the page drawn as an invitee sees it,
   * for whoever is looking, member or not.
   */
  preview?: boolean;
  /**
   * Opens "You're in" for an account the join made new, for the project the
   * join answered with; false when it will not show.
   */
  welcome?: ((newAccount: boolean, slug: string) => boolean) | null;
  /** Settles App._inviteFollow: true once this link has brought them in. */
  settle?: ((joined: boolean) => void) | null;
};

/** What joining through a link needs: the public page's offer, or a private community's preview. */
export type InviteSource = Pick<InviteOffer, 'token' | 'welcome' | 'settle'>;

let current: InviteOffer | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

/** What App._followInvite publishes (through the dev board's bridge); null takes it down. */
export function publishInviteOffer(offer: InviteOffer | null): void {
  current = offer && offer.slug ? offer : null;
  emit();
}

function dropInviteOffer(offer: InviteSource): void {
  if (current !== offer) return;
  current = null;
  emit();
}

/** The link this project's page was opened from, if it was. */
export function inviteOfferFor(slug: string): InviteOffer | null {
  return current && slug && current.slug === slug ? current : null;
}

export function useInviteOffer(slug: string): InviteOffer | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    () => inviteOfferFor(slug),
    () => null,
  );
}

/**
 * Who it is from, over the Join: the words the confirm used
 * (App._followInvite), "Maya made it and invited you" when the sender made
 * the project ("is making it" while its first version is on its way), else
 * "@maya invited you".
 */
export function invitedByLine(offer: Pick<InviteOffer, 'inviter' | 'inviterName' | 'inviterMadeIt' | 'building'>): string {
  if (offer.inviterMadeIt && offer.inviterName) {
    return offer.building
      ? t('project:invite.from.isMaking', { name: offer.inviterName })
      : t('project:invite.from.made', { name: offer.inviterName });
  }
  return offer.inviter ? t('project:invite.from.invited', { username: offer.inviter }) : t('project:invite.from.unnamed');
}

/** Why a link no longer works, by the server's reason: message ids, read when the toast is shown. */
const DEAD: Record<string, string> = {
  expired: 'project:invite.dead.expired',
  revoked: 'project:invite.dead.revoked',
  used_up: 'project:invite.dead.usedUp',
  unknown: 'project:invite.dead.unknown',
};

export type InviteJoin = {
  /**
   * 'joined' ("You're in." said), 'welcomed' (features/first-session took
   * over), 'dead' (the link died meanwhile, and the toast said why) or
   * 'failed' (said, and the link is still on offer).
   */
  outcome: 'joined' | 'welcomed' | 'dead' | 'failed';
  /** The project it let them into, once it has. */
  slug: string | null;
};

const FAILED: InviteJoin = Object.freeze({ outcome: 'failed', slug: null }) as InviteJoin;

/**
 * Join through the link. A 401 is the viewer's session rather than the
 * link, and goes to the shell's own handling, which reloads onto the link's
 * page (App._inviteSessionEnded).
 */
export async function joinByInvite(offer: InviteSource): Promise<InviteJoin> {
  const w = window as any;
  const toast = (msg: string, error = false) => w.PlatformUI?.toast?.(msg, error ? { error: true } : undefined);
  if (!offer.token) {
    toast(t('project:invite.previewOnly'));
    return FAILED;
  }
  let res: Response;
  try {
    // A public community asks a provisional handle for a username first
    // (username-first-run.js publicRetry).
    const redeem = () => fetch(`/api/invite-links/by-token/${encodeURIComponent(offer.token!)}/redeem`, {
      method: 'POST',
      credentials: 'same-origin',
    });
    res = w.UsernameFirstRun?.publicRetry ? await w.UsernameFirstRun.publicRetry(redeem) : await redeem();
  } catch {
    toast(t('project:invite.joinFailed'), true);
    return FAILED;
  }
  if (res.status === 401) {
    w.App?._inviteSessionEnded?.(`/invite/${offer.token}`);
    return FAILED;
  }
  const result = await res.json().catch(() => ({}));
  if (result.reason === 'username_required') {
    // "Not now": the offer stays, for when they have one.
    toast(result.error || t('project:invite.usernameFirst'), true);
    return FAILED;
  }
  if (!res.ok || !result.ok || !result.slug) {
    toast(DEAD[result.reason] ? t(DEAD[result.reason]) : t('project:invite.joinFailed'), true);
    if (!result.reason) return FAILED;
    // A link that died meanwhile is not this page's to offer any more: the
    // hero's own Join is still there.
    dropInviteOffer(offer);
    return { outcome: 'dead', slug: null };
  }
  dropInviteOffer(offer);
  offer.settle?.(true);
  // As after the confirm's Join: Home's challenges are read again, because
  // the redeem has just counted "Join a community", and Home's list learns
  // the project is one of theirs.
  if (result.status === 'joined') w.HomePanels?.ensureLoaded?.({ force: true });
  void Promise.resolve(w.Home?.load?.()).catch(() => {});
  if (result.newAccount === true && offer.welcome?.(true, result.slug)) return { outcome: 'welcomed', slug: result.slug };
  toast(t('project:invite.joined'));
  return { outcome: 'joined', slug: result.slug };
}
