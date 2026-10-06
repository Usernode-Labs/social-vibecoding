/**
 * Verifying an account: the sheet a refused public vote opens, and the body
 * the first-run phone step (./phone-first-run.tsx) and Home's card
 * (../home/verify-card.tsx) draw too.
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

export function VerifyIdentityBody({ phoneOffered, copy = VOTE_COPY, className = 'px-4 pb-5', onVerified, onSettings, onNotNow }: {
  phoneOffered: boolean;
  copy?: VerifyCopy;
  className?: string;
  onVerified: () => void;
  onSettings: () => void;
  /** The first-run step's way past it. */
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
 * the open one's outcome. `notNow` adds the first-run step's "Not now".
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
    w.App.user.phoneAsk = false;
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

if (typeof window !== 'undefined') {
  const host = window as unknown as { UsernodeReact?: Record<string, unknown> };
  const bridge = (host.UsernodeReact ||= {});
  bridge.verifyIdentity = { ask: askToVerifyIdentity };
}
