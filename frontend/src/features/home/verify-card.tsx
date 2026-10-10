/**
 * Home's "Verify your account" card (#home-verify-card): for a member the
 * verified-identity rule holds to it (GET /api/auth/me `identityNeeded`,
 * schema.sql identity_needed). Until the account is verified, its votes on
 * public apps do not count and it gets the unverified AI allowance; this
 * says so where they land, with the phone to add (where phone sign-in is
 * offered) and GitHub and X in Settings.
 *
 * #4378: it is the follow-up, never the first ask. It shows only once the
 * person has been asked at a public step (a public vote, making a project
 * public, more AI credits: ../auth/verify-identity.tsx) and closed the sheet
 * or chose "Not now" there, which that module keeps in localStorage
 * (ASKED_KEY) the way this card keeps its own dismissal. A phone linked here
 * hides it everywhere (the nav store's `identityNeeded`); its own "Not now"
 * hides it on this device only: the public steps still ask when they matter.
 *
 * NOT IN THE PRERENDER: who is signed in arrives after hydration (the nav
 * store's `identityNeeded`, published by App._syncViewer), so the first
 * render is nothing at all, which is what the document ships.
 */

import { useEffect, useState, type ReactNode } from 'react';

import { useMessages } from '../../lib/i18n/react';
import { useStoreState } from '../../lib/use-store-state';
import { ASKED_EVENT, noteVerified, VerifyIdentityBody, wasAskedHere, type VerifyCopy } from '../auth/verify-identity';
import { waitlistOptions } from '../auth/waitlist-shared';
import { navStore } from '../nav/nav-store.js';

/** The card's three texts, as message ids: read when the card renders. */
export const VERIFY_CARD_COPY: VerifyCopy = {
  title: 'home:verify.title',
  lead: 'home:verify.lead',
  reason: 'home:verify.reason',
};

const HIDDEN_KEY = 'usernode:verify-card-hidden';

function hiddenHere(): boolean {
  try { return localStorage.getItem(HIDDEN_KEY) === '1'; } catch { return false; }
}

export function VerifyCard(): ReactNode {
  const t = useMessages('home');
  const { identityNeeded } = useStoreState(navStore);
  const [phoneOffered, setPhoneOffered] = useState<boolean | null>(null);
  const [hidden, setHidden] = useState(false);
  const [asked, setAsked] = useState(false);

  useEffect(() => {
    if (!identityNeeded) return undefined;
    setHidden(hiddenHere());
    setAsked(wasAskedHere());
    const onAsked = () => setAsked(wasAskedHere());
    window.addEventListener(ASKED_EVENT, onAsked);
    let live = true;
    void waitlistOptions().then((options) => { if (live) setPhoneOffered(options?.phone_sign_in === true); });
    return () => { live = false; window.removeEventListener(ASKED_EVENT, onAsked); };
  }, [identityNeeded]);

  if (!identityNeeded || !asked || hidden || phoneOffered === null) return null;

  const notNow = () => {
    try { localStorage.setItem(HIDDEN_KEY, '1'); } catch { /* hidden for this visit */ }
    setHidden(true);
  };
  return (
    <section id="home-verify-card" className="px-3 pb-2 pt-0" aria-label={t('home:verify.regionLabel')}>
      <VerifyIdentityBody
        phoneOffered={phoneOffered}
        copy={{
          title: t(VERIFY_CARD_COPY.title),
          lead: t(VERIFY_CARD_COPY.lead),
          reason: t(VERIFY_CARD_COPY.reason),
        }}
        className=""
        onVerified={noteVerified}
        onSettings={() => {}}
        onNotNow={notNow}
      />
    </section>
  );
}
