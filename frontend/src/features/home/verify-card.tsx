/**
 * Home's "Verify your account" card (#home-verify-card): for a member the
 * verified-identity rule holds to it (GET /api/auth/me `identityNeeded`,
 * schema.sql identity_needed). Until the account is verified, its votes on
 * public apps do not count and it gets the unverified AI allowance; this
 * says so where they land, with the phone to add (where phone sign-in is
 * offered) and GitHub and X in Settings.
 *
 * On a phone the first-run step (../auth/phone-first-run.tsx) has asked
 * already; this is where they come back to it. On a computer this IS the
 * ask. A phone linked here hides it everywhere (the nav store's
 * `identityNeeded`); "Not now" hides it on this device only, a convenience
 * kept in localStorage: the vote's own sheet still asks when it matters.
 *
 * NOT IN THE PRERENDER: who is signed in arrives after hydration (the nav
 * store's `identityNeeded`, published by App._syncViewer), so the first
 * render is nothing at all, which is what the document ships.
 */

import { useEffect, useState, type ReactNode } from 'react';

import { useStoreState } from '../../lib/use-store-state';
import { noteVerified, VerifyIdentityBody, type VerifyCopy } from '../auth/verify-identity';
import { waitlistOptions } from '../auth/waitlist-shared';
import { navStore } from '../nav/nav-store.js';

export const VERIFY_CARD_COPY: VerifyCopy = {
  title: 'Verify your account',
  lead: 'Add your phone number to vote on public apps and get the full AI budget. Nobody sees your number.',
  reason: 'Verified accounts vote on public apps and get the full AI budget.',
};

const HIDDEN_KEY = 'usernode:verify-card-hidden';

function hiddenHere(): boolean {
  try { return localStorage.getItem(HIDDEN_KEY) === '1'; } catch { return false; }
}

export function VerifyCard(): ReactNode {
  const { identityNeeded } = useStoreState(navStore);
  const [phoneOffered, setPhoneOffered] = useState<boolean | null>(null);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    if (!identityNeeded) return undefined;
    setHidden(hiddenHere());
    let live = true;
    void waitlistOptions().then((options) => { if (live) setPhoneOffered(options?.phone_sign_in === true); });
    return () => { live = false; };
  }, [identityNeeded]);

  if (!identityNeeded || hidden || phoneOffered === null) return null;

  const notNow = () => {
    try { localStorage.setItem(HIDDEN_KEY, '1'); } catch { /* hidden for this visit */ }
    setHidden(true);
  };
  return (
    <section id="home-verify-card" className="px-3 pb-2 pt-0" aria-label="Verify your account">
      <VerifyIdentityBody
        phoneOffered={phoneOffered}
        copy={VERIFY_CARD_COPY}
        className=""
        onVerified={noteVerified}
        onSettings={() => {}}
        onNotNow={notNow}
      />
    </section>
  );
}
