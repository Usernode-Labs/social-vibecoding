/**
 * First-run "Add your phone number" (the verified-identity rule): the first
 * thing a new member is asked on a phone, once they are let in.
 *
 * Joining the waitlist takes an email, which is where "you're in" goes. Once
 * somebody is let in after the rule was switched on (Admin, Limits), their
 * public votes count and the full AI budget is theirs only when the account
 * is verified (schema.sql identity_needed). On a phone, where texting a code
 * is the sign-up everybody already knows, that is asked first:
 *
 *   sign in → username → terms → THIS → "What do you want to make?" or
 *           "What communities do you want to join?" → Home
 *
 * ── Who is asked, and where ───────────────────────────────────────────
 *
 * `App.user.phoneAsk` from /api/auth/me: held to the rule, phone sign-in
 * offered, and never answered. Asked ON A PHONE (the native app, or a page
 * that is a phone's: ../../lib/browser-scroll.ts MOBILE_PAGE_QUERY). On a
 * computer nothing is asked here: Home's "Verify your account" card
 * (../home/verify-card.tsx) says the same thing in place, and the vote's
 * own sheet (./verify-identity.tsx) asks when it matters.
 *
 * "Not now", or closing the sheet, answers it (POST
 * /api/me/phone-ask/answered): it is not asked again, and the Home card is
 * where the phone is added after that. A phone linked answers it too.
 *
 * ── Order ─────────────────────────────────────────────────────────────
 *
 * After the terms gate (../settings/terms-first-run.js, which itself waits
 * for the username step), and BEFORE the communities step
 * (./communities-first-run.js): that one awaits `settled()` here, and its
 * `firstSessionNow` is false while this comes first (`comesFirst`), so the
 * make screen is not opened in the same tick as the shell over it. The
 * story sheet's flag (../first-session/index.tsx) waits on it the same way.
 *
 * Published as window.PhoneFirstRun for those two and for app.js's
 * _reconcileSession, which asks again once a snapshot boot's session is
 * confirmed (nothing is asked from the snapshot, as the other steps do).
 */

import { isNative } from './shared';
import { MOBILE_PAGE_QUERY } from '../../lib/browser-scroll';
import { noteVerified, openVerifySheet, type VerifyCopy } from './verify-identity';

export const PHONE_STEP_COPY: VerifyCopy = {
  title: 'Add your phone number',
  lead: 'Verified accounts vote on public apps and get the full AI budget, so each person counts once. '
    + 'Nobody sees your number.',
  reason: 'Verified accounts vote on public apps and get the full AI budget, so each person counts once.',
};

export const ANSWERED_PATH = '/api/me/phone-ask/answered';
// A ghost-click window after the sheet before it, as the terms gate leaves.
const SETTLE_DELAY_MS = 450;

type AskUser = { phoneAsk?: boolean; hasPlatformAccess?: boolean } | null | undefined;
type Legacy = {
  App?: {
    user?: Record<string, unknown> | null;
    _sessionFromSnapshot?: boolean;
    _inviteFollow?: unknown;
    _inviteTokenFromPath?: (path: string) => unknown;
    saveSessionSnapshot?: (user: unknown) => void;
  };
  TermsFirstRun?: { settled?: () => Promise<void>; _inFlight?: boolean; _presented?: boolean };
};

const legacy = () => window as unknown as Legacy;

/** Is this a phone: the native app, or a page laid out for one. */
export function onPhone(): boolean {
  if (typeof window === 'undefined') return false;
  if (isNative()) return true;
  return typeof window.matchMedia === 'function' && window.matchMedia(MOBILE_PAGE_QUERY).matches;
}

/** Is `user` asked this before anything else, here. */
export function comesFirst(user: AskUser): boolean {
  return !!user && user.phoneAsk === true && user.hasPlatformAccess !== false && onPhone();
}

let presented = false;
let inFlight = false;
let answered = false;
let settle: (() => void) | null = null;
let settledPromise: Promise<void> | null = null;

/** Resolves once this document's step is done with: answered, skipped, or never applicable. */
export function settled(): Promise<void> {
  if (!settledPromise) settledPromise = new Promise<void>((resolve) => { settle = resolve; });
  return settledPromise;
}

function resolveStep() {
  settled();
  inFlight = false;
  const done = settle;
  settle = null;
  if (done) done();
}

/** "Not now": the account's copy and this device's snapshot say it is answered. */
function noteAnswered() {
  answered = true;
  const app = legacy().App;
  if (!app?.user) return;
  app.user.phoneAsk = false;
  try { app.saveSessionSnapshot?.(app.user); } catch { /* the next boot reads the server */ }
}

async function recordAnswered() {
  try {
    await fetch(ANSWERED_PATH, { method: 'POST', credentials: 'same-origin' });
  } catch { /* asked again on the next boot, which is honest when this never arrived */ }
}

async function afterTerms() {
  const terms = legacy().TermsFirstRun;
  if (terms && typeof terms.settled === 'function') {
    try { await terms.settled(); } catch { /* a broken gate must not block this one */ }
  }
  // A snapshot boot's terms ask comes again at reconcile: never two sheets.
  for (let i = 0; terms && (terms._inFlight || terms._presented) && i < 2400; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

function skipHere(): boolean {
  let params: URLSearchParams | null = null;
  try { params = new URLSearchParams(location.search); } catch { /* none */ }
  if (params && (params.get('shot') || params.get('demo') || params.get('token'))) return true;
  // The side panel's document: the top window asks, once.
  if (document.documentElement?.classList?.contains('in-side-panel')) return true;
  // An invite being followed brings them into its group first; Home's card
  // asks after.
  const app = legacy().App;
  if (app?._inviteFollow) return true;
  return !!(app && typeof app._inviteTokenFromPath === 'function' && app._inviteTokenFromPath(location.pathname));
}

export async function maybePrompt(): Promise<void> {
  if (presented || inFlight || answered) return;
  const app = legacy().App;
  if (app?._sessionFromSnapshot) { resolveStep(); return; }
  if (!app?.user || !comesFirst(app.user as AskUser) || skipHere()) {
    if (app?.user && !comesFirst(app.user as AskUser)) answered = true;
    resolveStep();
    return;
  }
  // Set before anything is awaited, so the communities step sees it.
  inFlight = true;
  await afterTerms();
  await new Promise((resolve) => setTimeout(resolve, SETTLE_DELAY_MS));
  presented = true;
  const outcome = await openVerifySheet({ copy: PHONE_STEP_COPY, notNow: true });
  presented = false;
  if (outcome === 'verified') {
    answered = true;
    noteVerified();
  } else if (outcome !== 'unavailable') {
    noteAnswered();
    void recordAnswered();
  }
  resolveStep();
}

const PhoneFirstRun = {
  comesFirst,
  settled,
  maybePrompt,
  get _inFlight() { return inFlight; },
  get _presented() { return presented; },
};

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  (window as unknown as { PhoneFirstRun?: typeof PhoneFirstRun }).PhoneFirstRun = PhoneFirstRun;
  if (legacy().App?.user) void maybePrompt();
  else document.addEventListener('sv:authed', () => { void maybePrompt(); }, { once: true });
}
