/**
 * Verifying an account: the sheet a refused public vote opens, and the body
 * Home's card (../home/verify-card.tsx) draws too.
 *
 * #4378: it is asked only at a public step, never right after sign-in:
 *
 *   - a vote on a public app (VOTE_COPY, below);
 *   - making a project public (MAKE_PUBLIC_COPY: the hub's "Make it public",
 *     ../dev-board/workshop/community-card.tsx, whose route answers
 *     identity_required too);
 *   - running out of AI credits ("Verify my account" on the out-of-credits
 *     card, public/js/credit-options.js).
 *
 * Closing the sheet, or its "Not now", records here that the person was
 * asked (ASKED_KEY, kept like the Home card's own dismissal), and only then
 * does Home's card show.
 *
 * With the verified-identity rule on (Admin, Limits; schema.sql
 * identity_needed), a vote on a public app counts only from a verified
 * account (a phone, GitHub AND X, or zkPassport) or one let in before the
 * rule was switched on, and only those get the full AI budget. The vote
 * routes refuse anybody else with `identity_required`
 * (services/communities.js identityVoteRefusal), and the Vote buttons
 * (public/js/app-view.js castVote, castIssueVote) open this instead of a
 * toast nobody can act on:
 *
 *   - the phone, when the server offers phone sign-in: #4080's add-a-phone
 *     card (./add-phone.tsx), whose /api/auth/phone-link/verify links the
 *     number to this account. Verified, the vote is cast again.
 *   - GitHub and X, always: both linked in Settings is verified too.
 *
 * The kit owns the sheet (PlatformUI.sheet); React owns what is in it, a
 * legacy portal mounted on open and dropped on dismiss, the seam
 * ../header/node-pill-sheet.tsx uses. Published on
 * window.UsernodeReact.verifyIdentity for the legacy callers.
 */

import { useEffect, useState } from 'react';

import { mountLegacyPortal, unmountLegacyPortal } from '../../lib/legacy-portals';
import { AddPhoneCard } from './add-phone';
import { waitlistOptions } from './waitlist-shared';

export const VERIFY_TITLE = 'Verify to vote on public apps';
export const VERIFY_LEAD = 'Votes on public apps count from verified accounts, so each person votes once. '
  + 'Add your phone number to vote now. Nobody sees your number.';
const VERIFY_REASON = 'Votes on public apps count from verified accounts, so each person votes once.';

const QUIET = 'py-1 text-[15px] font-medium text-violet-700 dark:text-violet-400 hover:underline';

export type VerifyCopy = {
  title: string;
  /** Under the title, with the phone offered. */
  lead: string;
  /** Under the title, without it: why, before "Link both GitHub and X". */
  reason: string;
};

export const VOTE_COPY: VerifyCopy = { title: VERIFY_TITLE, lead: VERIFY_LEAD, reason: VERIFY_REASON };

export const MAKE_PUBLIC_COPY: VerifyCopy = {
  title: 'Verify to make it public',
  lead: 'Public projects need a verified owner, so each person counts once. '
    + 'Add your phone number and it goes public. Nobody sees your number.',
  reason: 'Public projects need a verified owner, so each person counts once.',
};

export const CREDITS_COPY: VerifyCopy = {
  title: 'Verify your account',
  lead: 'Verified accounts get more free AI credits, so each person counts once. Nobody sees your number.',
  reason: 'Verified accounts get more free AI credits, so each person counts once.',
};

/** This device: the person was asked at a public step and closed it. Home's card shows after that. */
export const ASKED_KEY = 'usernode:verify-asked';
export const ASKED_EVENT = 'usernode:verify-asked';

export function wasAskedHere(): boolean {
  try { return localStorage.getItem(ASKED_KEY) === '1'; } catch { return false; }
}

function noteAsked(): void {
  try { localStorage.setItem(ASKED_KEY, '1'); } catch { /* the card waits for the next ask */ }
  try { window.dispatchEvent(new Event(ASKED_EVENT)); } catch { /* no listener to tell */ }
}

/** Whether the shell's copy of the account says the verified-identity rule holds it. */
export function identityNeededHere(): boolean {
  if (typeof window === 'undefined') return false;
  const app = (window as unknown as { App?: { user?: { identityNeeded?: boolean } | null } }).App;
  return app?.user?.identityNeeded === true;
}

export function VerifyIdentityBody({ phoneOffered, copy = VOTE_COPY, className = 'px-4 pb-5', onVerified, onSettings, onNotNow }: {
  phoneOffered: boolean;
  copy?: VerifyCopy;
  className?: string;
  onVerified: () => void;
  onSettings: () => void;
  /** A way past it, where the sheet or the card offers one. */
  onNotNow?: () => void;
}) {
  return (
    <div data-verify-identity="" className={className}>
      {phoneOffered ? (
        <AddPhoneCard groups={[]} title={copy.title} lead={copy.lead} onJoined={() => onVerified()} />
      ) : (
        <section className="mt-3 rounded-2xl bg-white dark:bg-zinc-900 p-5 text-left">
          <h2 className="text-[17px] font-[650] text-zinc-900 dark:text-zinc-100">{copy.title}</h2>
          <p className="mt-1 text-[15px] leading-snug text-zinc-500 dark:text-zinc-400">{copy.reason}</p>
        </section>
      )}
      <p className="mt-3 text-center text-[14px] text-zinc-500 dark:text-zinc-400">
        {phoneOffered ? 'Or link both GitHub and X in ' : 'Link both GitHub and X in '}
        <a href="#settings/linked-accounts" data-verify-identity-settings="" onClick={() => onSettings()} className="font-medium text-violet-700 dark:text-violet-400 hover:underline">
          Settings
        </a>
        .
      </p>
      {onNotNow ? (
        <div className="mt-1 flex justify-center">
          <button type="button" data-verify-identity-not-now="" className={QUIET} onClick={() => onNotNow()}>Not now</button>
        </div>
      ) : null}
    </div>
  );
}

/** The sheet's contents, once the options say whether phone sign-in is offered. */
function VerifySheet({ copy, onVerified, onSettings, onNotNow }: {
  copy: VerifyCopy;
  onVerified: () => void;
  onSettings: () => void;
  onNotNow?: () => void;
}) {
  const [phoneOffered, setPhoneOffered] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    void waitlistOptions().then((options) => { if (live) setPhoneOffered(options?.phone_sign_in === true); });
    return () => { live = false; };
  }, []);
  if (phoneOffered === null) return null;
  return <VerifyIdentityBody phoneOffered={phoneOffered} copy={copy} onVerified={onVerified} onSettings={onSettings} onNotNow={onNotNow} />;
}

type SheetKit = { sheet?: (opts: { contentEl: HTMLElement; onDismiss?: () => void }) => { dismiss: () => void } | null };

/** How the sheet ended: a phone linked, closed, "Not now", Settings, or no kit to show it. */
export type VerifyOutcome = 'verified' | 'dismissed' | 'not-now' | 'settings' | 'unavailable';

let open: Promise<VerifyOutcome> | null = null;

/**
 * Open the verify sheet. One at a time: a second ask while one is open gets
 * the open one's outcome. `notNow` adds a "Not now". Closed or "Not now",
 * the person has been asked: Home's card follows up.
 */
export function openVerifySheet({ copy = VOTE_COPY, notNow = false }: { copy?: VerifyCopy; notNow?: boolean } = {}): Promise<VerifyOutcome> {
  if (open) return open;
  const kit = (typeof window !== 'undefined' ? (window as unknown as { PlatformUI?: SheetKit }).PlatformUI : null);
  if (!kit || typeof kit.sheet !== 'function' || typeof document === 'undefined') return Promise.resolve('unavailable');
  open = new Promise<VerifyOutcome>((resolve) => {
    const panel = document.createElement('div');
    let handle: { dismiss: () => void } | null = null;
    let settled = false;
    const finish = (outcome: VerifyOutcome) => {
      if (settled) return;
      settled = true;
      open = null;
      unmountLegacyPortal(panel);
      if (outcome === 'dismissed' || outcome === 'not-now') noteAsked();
      resolve(outcome);
    };
    const leave = (outcome: VerifyOutcome) => { finish(outcome); handle?.dismiss(); };
    handle = kit.sheet!({ contentEl: panel, onDismiss: () => finish('dismissed') });
    if (!handle) { finish('unavailable'); return; }
    mountLegacyPortal(panel, (
      <VerifySheet
        copy={copy}
        onVerified={() => leave('verified')}
        onSettings={() => leave('settings')}
        onNotNow={notNow ? () => leave('not-now') : undefined}
      />
    ));
  });
  return open;
}

/**
 * A phone is linked: the account is verified, and Home's card goes. The
 * shell's copy of the account and the nav store say so at once, and this
 * device's snapshot keeps it for the next boot.
 */
export function noteVerified(): void {
  const w = window as unknown as {
    App?: { user?: Record<string, unknown> | null; saveSessionSnapshot?: (user: unknown) => void };
    UsernodeReact?: { nav?: { setIdentityNeeded?: (on: boolean) => void } };
  };
  if (w.App?.user) {
    w.App.user.identityNeeded = false;
    try { w.App.saveSessionSnapshot?.(w.App.user); } catch { /* the next boot reads the server */ }
  }
  w.UsernodeReact?.nav?.setIdentityNeeded?.(false);
}

/**
 * The vote's ask. Resolves true once a phone is linked (the caller casts the
 * vote again), false when the sheet is closed or there is no kit to show it
 * with.
 */
export function askToVerifyIdentity(): Promise<boolean> {
  return openVerifySheet().then((outcome) => {
    if (outcome !== 'verified') return false;
    noteVerified();
    return true;
  });
}

/**
 * "Make it public" (../dev-board/workshop/community-card.tsx): asked when
 * the account still needs verifying. Resolves true once a phone is linked,
 * and the visibility change goes on as before; false for "Not now" or a
 * closed sheet, which leaves the project private.
 */
export function askToVerifyForPublic(): Promise<boolean> {
  return openVerifySheet({ copy: MAKE_PUBLIC_COPY, notNow: true }).then((outcome) => {
    if (outcome !== 'verified') return false;
    noteVerified();
    return true;
  });
}

/** The out-of-credits card's "Verify my account" (public/js/credit-options.js wire). */
export function askToVerifyForCredits(): Promise<boolean> {
  return openVerifySheet({ copy: CREDITS_COPY }).then((outcome) => {
    if (outcome !== 'verified') return false;
    noteVerified();
    return true;
  });
}

if (typeof window !== 'undefined') {
  const host = window as unknown as { UsernodeReact?: Record<string, unknown> };
  const bridge = (host.UsernodeReact ||= {});
  bridge.verifyIdentity = { ask: askToVerifyIdentity, askForPublic: askToVerifyForPublic, askForCredits: askToVerifyForCredits };
}

// `?shot=verify-public`: "Verify to make it public" for the before/after
// shots, once the shell has a signed-in viewer. Staging holds nobody to the
// rule, so the hub's "Make it public" never asks there.
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  let shot: string | null = null;
  try { shot = new URLSearchParams(window.location.search).get('shot'); } catch { /* no shot */ }
  if (shot === 'verify-public') {
    const show = () => { setTimeout(() => { void openVerifySheet({ copy: MAKE_PUBLIC_COPY, notNow: true }); }, 450); };
    const app = (window as unknown as { App?: { user?: unknown } }).App;
    if (app?.user) show();
    else document.addEventListener('sv:authed', show, { once: true });
  }
}
