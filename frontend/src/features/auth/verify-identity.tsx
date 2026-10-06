/**
 * "Verify to vote on public apps": the sheet a refused public vote opens.
 *
 * With the verified-identity rule on (Admin, Limits; schema.sql
 * public_vote_needs_identity), a vote on a public app counts only from a
 * verified account (a phone, GitHub AND X, or zkPassport) or one let in
 * before the rule was switched on. The vote routes refuse anybody else with
 * `identity_required` (services/communities.js identityVoteRefusal), and the
 * Vote buttons (public/js/app-view.js castVote, castIssueVote) open this
 * instead of a toast nobody can act on:
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

export function VerifyIdentityBody({ phoneOffered, onVerified, onSettings }: {
  phoneOffered: boolean;
  onVerified: () => void;
  onSettings: () => void;
}) {
  return (
    <div data-verify-identity="" className="px-4 pb-5">
      {phoneOffered ? (
        <AddPhoneCard groups={[]} title={VERIFY_TITLE} lead={VERIFY_LEAD} onJoined={() => onVerified()} />
      ) : (
        <section className="mt-3 rounded-2xl bg-white dark:bg-zinc-900 p-5 text-left">
          <h2 className="text-[17px] font-[650] text-zinc-900 dark:text-zinc-100">{VERIFY_TITLE}</h2>
          <p className="mt-1 text-[15px] leading-snug text-zinc-500 dark:text-zinc-400">
            Votes on public apps count from verified accounts, so each person votes once.
          </p>
        </section>
      )}
      <p className="mt-3 text-center text-[14px] text-zinc-500 dark:text-zinc-400">
        {phoneOffered ? 'Or link both GitHub and X in ' : 'Link both GitHub and X in '}
        <a href="#settings" data-verify-identity-settings="" onClick={() => onSettings()} className="font-medium text-violet-700 dark:text-violet-400 hover:underline">
          Settings
        </a>
        .
      </p>
    </div>
  );
}

/** The sheet's contents, once the options say whether phone sign-in is offered. */
function VerifySheet({ onVerified, onSettings }: { onVerified: () => void; onSettings: () => void }) {
  const [phoneOffered, setPhoneOffered] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    void waitlistOptions().then((options) => { if (live) setPhoneOffered(options?.phone_sign_in === true); });
    return () => { live = false; };
  }, []);
  if (phoneOffered === null) return null;
  return <VerifyIdentityBody phoneOffered={phoneOffered} onVerified={onVerified} onSettings={onSettings} />;
}

type SheetKit = { sheet?: (opts: { contentEl: HTMLElement; onDismiss?: () => void }) => { dismiss: () => void } | null };

let open: Promise<boolean> | null = null;

/**
 * Ask the person to verify. Resolves true once a phone is linked (the caller
 * casts the vote again), false when the sheet is closed or there is no kit
 * to show it with. One sheet at a time.
 */
export function askToVerifyIdentity(): Promise<boolean> {
  if (open) return open;
  const kit = (typeof window !== 'undefined' ? (window as unknown as { PlatformUI?: SheetKit }).PlatformUI : null);
  if (!kit || typeof kit.sheet !== 'function' || typeof document === 'undefined') return Promise.resolve(false);
  open = new Promise<boolean>((resolve) => {
    const panel = document.createElement('div');
    let handle: { dismiss: () => void } | null = null;
    let settled = false;
    const finish = (verified: boolean) => {
      if (settled) return;
      settled = true;
      open = null;
      unmountLegacyPortal(panel);
      resolve(verified);
    };
    handle = kit.sheet!({ contentEl: panel, onDismiss: () => finish(false) });
    if (!handle) { finish(false); return; }
    mountLegacyPortal(panel, (
      <VerifySheet
        onVerified={() => { finish(true); handle?.dismiss(); }}
        onSettings={() => { finish(false); handle?.dismiss(); }}
      />
    ));
  });
  return open;
}

if (typeof window !== 'undefined') {
  const host = window as unknown as { UsernodeReact?: Record<string, unknown> };
  const bridge = (host.UsernodeReact ||= {});
  bridge.verifyIdentity = { ask: askToVerifyIdentity };
}
