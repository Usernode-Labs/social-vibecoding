/**
 * `#auth-waitlist-screen`: check your waitlist status (#1538), at
 * `#waitlist?confirm=1`.
 *
 * An address that joined the waitlist (on the marketing site's /waitlist
 * page, or on this screen before #5261) types itself in, gets a six-digit
 * code, and reads back where it stands. The check-my-status mail's button
 * (`/?status=1`, AuthScreens.enter) and the waitlist landing's "Already
 * joined? Check your status" both open it.
 *
 * ── No join form here any more (#5261) ───────────────────────────────
 *
 * This screen also held the in-app join form (email, country, how you found
 * us) and its pitch, a second way onto the waitlist beside Get started,
 * which makes an account that waits in line too: two ways in, two records.
 * The form is retired. Continue (the landing's sign-in sheet) makes the
 * account and puts it in line, and the two optional questions are asked
 * after it, in the waiting room (./waiting-about.tsx), saved to the same
 * keys on the account's own row. A bare `#waitlist`, and an old
 * `#waitlist?ref=<code>` link, open Continue instead
 * (AuthScreens.retireWaitlistLink), keeping the code for the waiting room
 * to send on. A signed-in visitor is sent to the waiting room, which shows
 * their spot. What stays is the status check, because the rows the
 * marketing site and the old form made have no account to sign in to.
 *
 * ── Two steps, not one form (#1876) ──────────────────────────────────
 *
 * `#waitlist-confirm-address` collects the address and sends the code,
 * `#waitlist-confirm-code` takes the six digits and carries a way back.
 *
 * "I already have a code" skips the send rather than decorating it:
 * `issueVerificationCode` deletes every unconsumed code for an address
 * before minting the next one, so a forced send would invalidate the code
 * sitting in the inbox of the very person who followed that mail's
 * `?status=1` button here. And the step lives in the fragment
 * (`#waitlist?confirm=1&step=code`), derived in both directions on every
 * show, so Back walks the flow backwards and either step survives a reload.
 *
 * Before anything is sent, the address is looked up (#2201,
 * POST /api/public/waitlist/status): not on the list says so and offers
 * Continue; on it and confirmed reads the state straight back; on it and
 * unconfirmed sends the code. A status panel never shows a queue position:
 * nothing ranks the waitlist (services/waitlist-signals.js computes no
 * score), so a number here would be invented.
 *
 * ── One waitlist room (#5262) ────────────────────────────────────────
 *
 * This was a second page about the same wait, in its own words: a "Step 1
 * of 2" bar, "Check your status" over the answer, the daily code cap printed
 * before anybody had asked for one. A signed-in account never reaches it:
 * the router sends any `#waitlist` a waiting session opens to the waiting
 * room (App.restoreFromHash → AuthScreens.showWaiting), which shows their
 * spot with no code. The code check stays for an address with no session
 * (the status mail's `?status=1` button lands here), and once it answers it
 * speaks as the room does: "You're on the waitlist" over the room's own lead
 * (auth:waiting.*), in the room's card. The step bar is gone (the code step
 * carries its own label and way back), and the cap is said only when a
 * request is actually refused for it (a 429, auth:waitlist.code.limited).
 *
 * ── Screenshot state ─────────────────────────────────────────────────
 *
 * One per settled state, because a shot can only navigate:
 * `?shot=waitlist-code-entry` is the address step, `?shot=waitlist-code-step`
 * the code step after it, `?shot=waitlist-not-found` the address step after
 * a lookup that found nothing, `?shot=waitlist-status` the panel for a
 * confirmed signup still waiting, and `?shot=waitlist-admitted` the released
 * panel. All of them are pure UI state: none POSTs, none writes.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

import { RichMessage, useMessages } from '../../lib/i18n/react';
import { t as translate } from '../../lib/i18n/runtime';
import { useMountedOnReveal } from '../../lib/mount-on-reveal';
import { useVisibilityHiddenClass } from '../../lib/visibility-store';
import { AuthBackButton } from './back-button';
import { CodeBoxes } from './code-boxes';
import {
  AUTH_SCREEN_IDS,
  hiddenFirst,
  hiddenLast,
  legacy,
  useAuthScreensPatch,
} from './shared';
import {
  MsgTone,
  msgClass,
  StatusPill,
  SURVEY_FIELD,
  SURVEY_HINT,
  SURVEY_LABEL,
  useSurveyAnswered,
  WaitlistStatus,
} from './waitlist-shared';

/**
 * The advertised gap between code requests, in seconds, and where it is
 * remembered.
 *
 * The server's answer carries the same number (`cooldown_seconds`), and the
 * client counts it down locally rather than asking again — deliberately, and
 * it is the same reason the response body is a constant: a countdown the
 * SERVER reported per address would say "wait 47 more seconds" to a member
 * and "go ahead" to a stranger, which is a membership test with extra steps.
 * So the number is fixed, the real per-address gap lives in the mail
 * throttle, and this is a courtesy that stops a double-tap rather than a
 * security boundary.
 *
 * localStorage, not state: a reload is the obvious way to get a fresh button,
 * and a courtesy that a refresh defeats is not one. A browser that refuses
 * storage simply gets the un-persisted version, which is why every access is
 * wrapped.
 */
const RESEND_COOLDOWN_KEY = 'usernode:waitlist-resend-until';
const RESEND_COOLDOWN_SECONDS = 60;

function readCooldownUntil(): number {
  try {
    const raw = window.localStorage.getItem(RESEND_COOLDOWN_KEY);
    const at = raw ? Number(raw) : 0;
    return Number.isFinite(at) && at > Date.now() ? at : 0;
  } catch {
    return 0;
  }
}

function writeCooldownUntil(at: number): void {
  try {
    window.localStorage.setItem(RESEND_COOLDOWN_KEY, String(at));
  } catch {
    /* private mode, or storage denied to a third-party frame */
  }
}

/**
 * "14 March 2026" from an ISO timestamp, or '' when there isn't one. Used for
 * the joined-on line in the status panel (#1538).
 */
function formatJoinedOn(iso: string | null | undefined): string {
  if (!iso) return '';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  try {
    return at.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
  } catch {
    return '';
  }
}

/**
 * The daily code cap (#2201), said only on a refused request (#5262).
 *
 * A CONSTANT, and deliberately so: a per-address "you have 3 left today"
 * would be a membership test readable straight off the page, which is the
 * same oracle the resend endpoint's fixed cooldown exists to avoid. It
 * states the ceiling in services/mail/rate-limit.js's waitlist_code rule
 * (ten per address per day) without saying anything about any address. It
 * used to sit under both send controls before anybody had asked for a
 * code; now it is the one message both sends show on a 429, the answer the
 * request limiters (middleware/rate-limits.js) give every caller alike.
 */
// The cap's words are auth:waitlist.code.limited.

export function WaitlistScreen() {
  const rootRef = useRef<HTMLElement>(null);
  useVisibilityHiddenClass(rootRef, AUTH_SCREEN_IDS.waitlist, false);
  const t = useMessages('auth');
  // The screen's interior mounts on its first reveal, not in the prerender —
  // see lib/mount-on-reveal.ts. AuthScreens.show() asks for it (through
  // window.UsernodeReact.mount) before it wires or reveals the screen, so the
  // hooks this component patches onto AuthScreens are installed and the
  // interior's nodes exist by the time the on-show hook runs.
  const mounted = useMountedOnReveal(AUTH_SCREEN_IDS.waitlist);

  // The stage-2 offer and its token are separate: `?shot=waitlist-status`
  // shows the offer with no token at all, and its link keeps the inert href.
  const [offer, setOffer] = useState(false);
  const [moreToken, setMoreToken] = useState<string | null>(null);
  // #1535: once those questions have been answered the card stops asking for
  // answers and offers to edit them instead.
  const surveyAnswered = useSurveyAnswered(moreToken);
  const [msg, setMsg] = useState<{ text: string; tone: MsgTone } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  /**
   * The address the code went to, echoed back in the code step and in the
   * settled `#waitlist-confirmed` panel (#1537). Stored lower-cased, matching
   * what the server normalizes and stores.
   */
  const [sentTo, setSentTo] = useState('');
  /**
   * Which half of the errand is on screen (#1876): `'address'` collects the
   * address and sends the code, `'code'` takes the six digits. Derived from
   * the fragment in `waitlistOnShow`.
   */
  const [flowStep, setFlowStep] = useState<'address' | 'code'>('address');
  /**
   * Where this signup actually stands, from the confirm or status response
   * (#1538). Null until one lands.
   */
  const [status, setStatus] = useState<WaitlistStatus | null>(null);
  /**
   * Released, and the day they joined (#1538). The date is formatted in the
   * visitor's own locale; a malformed value collapses to '', which hides the
   * line rather than printing "Invalid Date".
   */
  const admitted = !!status?.admitted;
  const joinedOn = formatJoinedOn(status?.joined_at);
  /** The resend button's own status line. Kept apart from #waitlist-msg so a
   *  resend result and a wrong-code error cannot overwrite each other. */
  const [resendNote, setResendNote] = useState<{ text: string; tone: MsgTone } | null>(null);
  /**
   * The address step's own status line (#1876). A request that failed stays
   * on step 1 and says why here; one that succeeded advances and says so on
   * #waitlist-resend-note, beside the field it is about.
   */
  const [requestNote, setRequestNote] = useState<{ text: string; tone: MsgTone } | null>(null);
  /**
   * The lookup answered "that address is not on the waitlist" (#2201). It
   * reveals the way out of the dead end, Continue, which joins now (#5261).
   * Its own flag rather than a tone on `requestNote`, because the note is
   * also where a connection failure and a 429 land, and neither of those
   * should offer to start a join.
   */
  const [notFound, setNotFound] = useState(false);
  const [resending, setResending] = useState(false);
  /** Epoch ms the cooldown ends, and the seconds left, ticked once a second. */
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [cooldownLeft, setCooldownLeft] = useState(0);
  /**
   * Re-entrancy guard for the confirm POST. `submitting` is state and
   * `onConfirmCode` closes over the mount's value of it, so on a slow network
   * the auto-submit below would fire a second request while the first was
   * still open. A ref reads live.
   */
  const busy = useRef(false);

  const code = useRef<HTMLInputElement>(null);
  /** The digits in the code's boxes (./code-boxes.tsx). Kept beside the field
   *  because a programmatic `.value = ''` fires no input event. */
  const [codeValue, setCodeValue] = useState('');
  /** The address the code is for. */
  const confirmEmail = useRef<HTMLInputElement>(null);

  const waitlistOnShow = useCallback(() => {
    // Which half of the split (#1876), from the fragment. Derived in BOTH
    // directions on every show, so the browser's own Back button walks the
    // flow backwards and a reload lands on the step it left.
    try {
      const hashQuery = new URLSearchParams(location.hash.split('?')[1] || '');
      setFlowStep(hashQuery.get('step') === 'code' ? 'code' : 'address');
    } catch {
      setFlowStep('address');
    }

    let shot: string | null = null;
    try {
      shot = new URLSearchParams(location.search).get('shot');
    } catch {
      shot = null;
    }
    // The settled states, painted from literals for the shots. None of them
    // POSTs or writes.
    if (shot === 'waitlist-code-entry') {
      setMsg(null);
      setFlowStep('address');
      // No `sentTo`: nothing was sent on this device.
      setSentTo('');
    }
    if (shot === 'waitlist-code-step') {
      setMsg(null);
      setFlowStep('code');
      // A stand-in address, so the step names where the code went.
      setSentTo('you@example.com');
    }
    if (shot === 'waitlist-not-found') {
      setMsg(null);
      setFlowStep('address');
      setSentTo('');
      setRequestNote({
        text: translate('auth:waitlist.request.notFound'),
        tone: 'error',
      });
      setNotFound(true);
    }
    if (shot === 'waitlist-status') {
      setMsg(null);
      setSentTo('you@example.com');
      setConfirmed(true);
      // The offer stands: a confirmed signup can still move up, and this is
      // the panel that says so.
      setOffer(true);
      setStatus({
        state: 'confirmed',
        admitted: false,
        confirmed: true,
        has_account: false,
        joined_at: '2026-03-14T10:00:00.000Z',
      });
    }
    if (shot === 'waitlist-admitted') {
      setMsg(null);
      setSentTo('you@example.com');
      setConfirmed(true);
      // No stage-2 offer: it is an offer to improve a position this signup
      // no longer has.
      setOffer(false);
      setStatus({
        state: 'admitted',
        admitted: true,
        confirmed: true,
        has_account: false,
        joined_at: '2026-03-14T10:00:00.000Z',
      });
    }
    if (!shot) window.setTimeout(() => confirmEmail.current?.focus({ preventScroll: true }), 0);
    // Mirror into the tab title so the Flutter WebView's AppBar follows the
    // screen, same as the landing header does for the landing page.
    try {
      document.title = translate('auth:waitlist.documentTitle');
    } catch {
      /* ignore */
    }
  }, []);

  /** Arm the cooldown, in state and in storage, from now. */
  const startCooldown = useCallback(() => {
    const until = Date.now() + RESEND_COOLDOWN_SECONDS * 1000;
    setCooldownUntil(until);
    setCooldownLeft(RESEND_COOLDOWN_SECONDS);
    writeCooldownUntil(until);
  }, []);

  /**
   * Adopt any cooldown left over from a previous visit, and tick it down.
   *
   * Read in an effect rather than as initial state on purpose: the interior's
   * first render has to be the markup the hand-written shell shipped, and a
   * button whose label depends on localStorage is not that.
   */
  useEffect(() => {
    const stored = readCooldownUntil();
    if (stored) setCooldownUntil(stored);
  }, []);

  useEffect(() => {
    if (!cooldownUntil) return undefined;
    const tick = () => {
      const left = Math.ceil((cooldownUntil - Date.now()) / 1000);
      setCooldownLeft(left > 0 ? left : 0);
      if (left <= 0) setCooldownUntil(0);
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [cooldownUntil]);
  /** The address the errand is about. */
  const confirmAddress = useCallback(() => confirmEmail.current?.value.trim() || '', []);

  /**
   * Move to the code step, in state and in the fragment (#1876).
   *
   * Assigning the hash pushes a history entry, which is what makes the
   * browser's Back a working "wrong address" undo, and `waitlistOnShow`
   * re-derives the step from it — so the URL and the screen cannot disagree.
   */
  const goToCodeStep = useCallback(() => {
    setFlowStep('code');
    try {
      if (location.hash !== '#waitlist?confirm=1&step=code') {
        location.hash = '#waitlist?confirm=1&step=code';
      }
    } catch {
      /* ignore */
    }
    window.setTimeout(() => code.current?.focus({ preventScroll: true }), 0);
  }, []);

  /** Back to the address step, the same way and for the same reason. */
  const backToAddress = useCallback(() => {
    setMsg(null);
    setFlowStep('address');
    try {
      if (location.hash !== '#waitlist?confirm=1') location.hash = '#waitlist?confirm=1';
    } catch {
      /* ignore */
    }
    window.setTimeout(() => confirmEmail.current?.focus({ preventScroll: true }), 0);
  }, []);

  /**
   * Ask for a fresh code.
   *
   * The endpoint answers the same body to everybody, so there is nothing here
   * to branch on and nothing to report beyond "it is on its way if it applies
   * to you". That vagueness is the feature: a message that said "no such
   * address" would turn this button into a membership oracle.
   */
  const onResend = useCallback(async () => {
    if (resending || cooldownLeft > 0) return;
    const emailVal = confirmAddress();
    if (!emailVal) {
      return setResendNote({ text: translate('auth:waitlist.resend.emailMissing'), tone: 'error' });
    }
    setResending(true);
    setResendNote(null);
    try {
      const res = await fetch('/api/public/waitlist/resend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: emailVal }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok) {
        setResendNote({
          text: (data && data.message)
            || translate('auth:waitlist.resend.sent'),
          tone: 'ok',
        });
        setSentTo(emailVal.toLowerCase());
        startCooldown();
      } else if (res.status === 429) {
        // The daily cap is said when it is the reason, not before (#5262).
        setResendNote({ text: translate('auth:waitlist.code.limited'), tone: 'error' });
      } else {
        setResendNote({
          text: (data && data.error) || translate('auth:waitlist.resend.failed'),
          tone: 'error',
        });
      }
    } catch {
      setResendNote({ text: translate('auth:waitlist.resend.network'), tone: 'error' });
    }
    setResending(false);
  }, [confirmAddress, cooldownLeft, resending, startCooldown]);

  /**
   * Check the address, then do the right one of three things (#2201):
   *
   *   1. not on the list  - say so, offer Continue, send nothing;
   *   2. on it, unconfirmed - send, then advance;
   *   3. on it, confirmed - straight to the status panel, no code at all.
   *
   * POST /api/public/waitlist/status writes nothing and mails nothing. A
   * non-200, a body without `on_list`, a 429 on its bucket: every one of
   * those falls through to the send-and-advance path rather than stranding
   * somebody on a step that cannot continue.
   */
  const onRequestCode = useCallback(async () => {
    if (resending || cooldownLeft > 0) return;
    const emailVal = confirmAddress();
    if (!emailVal) {
      return setRequestNote({ text: translate('auth:waitlist.request.emailMissing'), tone: 'error' });
    }
    setRequestNote(null);
    setNotFound(false);
    setResending(true);

    // `null` means "we did not get a usable answer", which is deliberately
    // distinct from "not on the list" - only the second one is allowed to
    // stop the errand.
    let known: { onList: boolean; status: WaitlistStatus | null } | null = null;
    try {
      const res = await fetch('/api/public/waitlist/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: emailVal }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data && typeof data.on_list === 'boolean') {
        known = { onList: data.on_list, status: data.status || null };
      }
    } catch {
      /* Fall through to the send: a lookup we could not make is not an answer. */
    }

    if (known && !known.onList) {
      setRequestNote({
        text: translate('auth:waitlist.request.notFound'),
        tone: 'error',
      });
      setNotFound(true);
      setResending(false);
      return;
    }

    if (known && known.status?.confirmed) {
      // Already confirmed, so there is nothing a code would prove. Read the
      // state back instead.
      setMsg(null);
      setSentTo(emailVal.toLowerCase());
      setStatus(known.status);
      setConfirmed(true);
      // No stage-2 offer on this path: its link needs a `more_token`, and the
      // status endpoint deliberately never returns one.
      setOffer(false);
      setResending(false);
      return;
    }

    try {
      const res = await fetch('/api/public/waitlist/resend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: emailVal }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok) {
        setResendNote({
          text: (data && data.message)
            || translate('auth:waitlist.request.sent'),
          tone: 'ok',
        });
        setSentTo(emailVal.toLowerCase());
        startCooldown();
        setResending(false);
        goToCodeStep();
        return;
      }
      // The daily cap is said when it is the reason, not before (#5262).
      if (res.status === 429) {
        setRequestNote({ text: translate('auth:waitlist.code.limited'), tone: 'error' });
        setResending(false);
        return;
      }
      setRequestNote({
        text: (data && data.error) || translate('auth:waitlist.request.failed'),
        tone: 'error',
      });
    } catch {
      setRequestNote({ text: translate('auth:waitlist.request.network'), tone: 'error' });
    }
    setResending(false);
  }, [confirmAddress, cooldownLeft, goToCodeStep, resending, startCooldown]);

  /**
   * Carry on with a code already in hand (#1876). Sends nothing on purpose:
   * issuing a new code deletes the unconsumed one, so a send here would
   * invalidate the code the reader came to type.
   */
  const onHaveCode = useCallback(() => {
    const emailVal = confirmAddress();
    if (!emailVal) {
      return setRequestNote({ text: translate('auth:waitlist.request.emailMissing'), tone: 'error' });
    }
    setRequestNote(null);
    setNotFound(false);
    goToCodeStep();
  }, [confirmAddress, goToCodeStep]);

  /**
   * Out of the dead end (#2201): the address is not on the waitlist, so the
   * useful next move is to join. Joining is Continue now (#5261), which
   * makes the account and puts it in line, so this opens the landing with
   * that sheet up (AuthScreens._startSheet, taken on show by landing.tsx).
   */
  const onJoinInstead = useCallback(() => {
    setNotFound(false);
    setRequestNote(null);
    const host = legacy().AuthScreens as { _startSheet?: boolean } | undefined;
    if (host) host._startSheet = true;
    try {
      location.hash = '#landing';
    } catch {
      /* ignore */
    }
  }, []);

  /**
   * Confirm the address with the six-digit code from the mail. The link in
   * that same mail does the same thing; whichever is used first wins.
   */
  const onConfirmCode = useCallback(async () => {
    if (busy.current) return;
    const codeVal = code.current?.value.trim() || '';
    // A link straight to the code step has no address behind it (#1876): an
    // address never travels in a URL. Back to the step that collects one.
    if (!confirmAddress()) {
      backToAddress();
      return setMsg({ text: translate('auth:waitlist.confirm.emailMissing'), tone: 'error' });
    }
    if (!/^[0-9]{6}$/.test(codeVal)) {
      return setMsg({ text: translate('auth:waitlist.confirm.codeMissing'), tone: 'error' });
    }
    busy.current = true;
    setSubmitting(true);
    try {
      const res = await fetch('/api/public/waitlist/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: confirmAddress(), code: codeVal }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok) {
        setMsg(null);
        setConfirmed(true);
        // Confirming is what puts somebody on the list, so it is also what
        // unlocks the questions that move them up it.
        const token = (data && data.more_token) || null;
        if (token) setMoreToken(token);
        // Where they actually stand (#1538), from the same server-side
        // helper `#more/<token>` reads.
        const next: WaitlistStatus | null = (data && data.status) || null;
        setStatus(next);
        // The stage-2 questions move you UP the list, so they are not an
        // offer worth making to somebody already off it.
        setOffer(!next?.admitted);
      } else {
        setMsg({ text: (data && data.error) || translate('auth:waitlist.confirm.rejected'), tone: 'error' });
      }
    } catch {
      setMsg({ text: translate('auth:waitlist.confirm.network'), tone: 'error' });
    }
    busy.current = false;
    setSubmitting(false);
  }, [backToAddress, confirmAddress]);

  /**
   * Keep the field to six digits, and confirm as soon as it has them. People
   * paste the code out of a mail app, which brings "123 456" or "Code:
   * 123456" with it, so strip rather than reject (the field takes a longer
   * paste for exactly that). The Confirm button stays: a wrong code has to be
   * correctable.
   */
  const onCodeInput = useCallback(
    (digits: string) => {
      setCodeValue(digits);
      setMsg(null);
      if (digits.length === 6) void onConfirmCode();
    },
    [onConfirmCode],
  );

  const live = useRef({ waitlistOnShow });
  live.current = { waitlistOnShow };
  useAuthScreensPatch({
    _wireWaitlist: () => {},
    _waitlistOnShow: () => live.current.waitlistOnShow(),
  });

  return (
    <main
      ref={rootRef}
      id="auth-waitlist-screen"
      className="hidden fixed inset-0 z-40 overflow-y-auto platform-safe-scroll"
    >
      {mounted ? (
        <>
      {/*
          The sign-in and register screens' 44px round chevron, from the one
          implementation the three share (./back-button, #2444). It scrolls
          with the page (#1875), so nothing can pass under it.
      */}
      <AuthBackButton href="#landing" />
      <div className="max-w-2xl mx-auto px-6 py-16">
        <div id="waitlist-joined">
          {/*
              Once the state is known the heading is the waiting room's own
              (#5262), so a person who checked by code reads the same words
              as one who is signed in, rather than "Check your status" over
              the answer.
          */}
          <h1 className="text-2xl font-bold">
            {!confirmed
              ? t('auth:waitlist.joined.titleStatus')
              : admitted
                ? t('auth:waitlist.status.titleAdmitted')
                : t('auth:waiting.title')}
          </h1>
          <p className={hiddenLast(confirmed, 'mt-1 text-sm text-zinc-500 dark:text-zinc-400')}>
            {/*
                The lede follows the step (#1876): on step 2 the address field
                is not on screen, so it keeps the claim and drops the
                instruction.
            */}
            {flowStep === 'code'
              ? t('auth:waitlist.joined.leadStatusCode')
              : t('auth:waitlist.joined.leadStatusAddress')}
          </p>
          <div id="waitlist-confirm" className={hiddenLast(confirmed, 'mt-4')}>
            {/*
                Step 1 (#1876): which address, and the send. Plain `hidden`
                on a wrapper, because the whole half comes and goes together.
            */}
            <div
              id="waitlist-confirm-address"
              className={flowStep === 'address' ? '' : 'hidden'}
            >
              <label
                htmlFor="waitlist-confirm-email"
                className={SURVEY_LABEL}
              >
                {t('auth:waitlist.request.label')}
              </label>
              <p className={SURVEY_HINT}>
                {t('auth:waitlist.request.hint')}
              </p>
              <Input
                ref={confirmEmail}
                id="waitlist-confirm-email"
                type="email"
                maxLength={255}
                placeholder={t('auth:waitlist.request.placeholder')}
                autoComplete="email"
                {...SURVEY_FIELD}
                className="mb-2"
              />
              <Button
                id="waitlist-request-code"
                type="button"
                disabled={resending || cooldownLeft > 0}
                disabledStyle="dim"
                size="lg"
                onClick={onRequestCode}
              >
                {cooldownLeft > 0
                  ? t('auth:waitlist.request.cooldown', { count: cooldownLeft })
                  : resending
                    ? t('auth:waitlist.request.sending')
                    : t('auth:waitlist.request.submit')}
              </Button>
              {/*
                  For the reader who arrived from the status mail, which
                  carries a code already. Sends nothing on purpose.
              */}
              <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">
                <button
                  id="waitlist-have-code"
                  type="button"
                  onClick={onHaveCode}
                  className="font-medium text-violet-700 dark:text-violet-400 hover:underline"
                >
                  {t('auth:waitlist.request.haveCode')}
                </button>
              </p>
              <p
                id="waitlist-request-note"
                className={msgClass(requestNote ? requestNote.tone : null)}
              >
                {requestNote ? requestNote.text : null}
              </p>
              {/*
                  The way out of the one dead end this step has (#2201): an
                  address that is not on the list is told so, and offered
                  Continue, which joins now (#5261). Always in the markup and
                  hidden until the lookup says so, with the class on the
                  button itself: the declared checks tell the offered state
                  from the withheld one by `:not(.hidden)` on this id.

                  Filled neutral rather than the accent: the send above it is
                  still the primary action on this step.
              */}
              <Button
                id="waitlist-join-instead"
                type="button"
                size="lg"
                variant="neutral"
                ink="neutral"
                className={hiddenLast(!notFound, 'mt-3')}
                onClick={onJoinInstead}
              >
                {t('auth:waitlist.request.joinInstead')}
              </Button>
            </div>
            {/* Step 2 (#1876): the six digits, the resend and the way back. */}
            <div
              id="waitlist-confirm-code"
              className={flowStep === 'address' ? 'hidden' : ''}
            >
              <p className="mb-1.5">
                <button
                  id="waitlist-change-email"
                  type="button"
                  onClick={backToAddress}
                  className="text-sm font-medium text-violet-700 dark:text-violet-400 hover:underline"
                >
                  {t('auth:waitlist.confirm.back')}
                </button>
              </p>
              <label
                htmlFor="waitlist-code"
                className={SURVEY_LABEL}
              >
                {t('auth:waitlist.confirm.labelStatus')}
              </label>
              <p className={SURVEY_HINT}>
                {/*
                    It never claims a send happened (#2201): the mail throttle
                    can suppress one, and "I already have a code" arrives here
                    with none behind it. Pointing at the inbox is true either
                    way.
                */}
                {sentTo
                  ? t('auth:waitlist.confirm.hintSentTo', { email: sentTo })
                  : t('auth:waitlist.confirm.hintStatus')}
              </p>
              {/*
                  Six boxes over one real field (./code-boxes.tsx): typing,
                  a paste or the keyboard's suggestion from the mail fills
                  them, and Confirm sits under them because six boxes and a
                  button do not fit on one line on a phone (#5989).
              */}
              <div className="flex flex-col items-start gap-2">
                <div className="w-full">
                  <CodeBoxes
                    id="waitlist-code"
                    inputRef={code}
                    digits={codeValue}
                    onDigits={onCodeInput}
                    // Long enough that a pasted "Code: 583 914" reaches the
                    // cleaning whole, as this field has always taken it.
                    maxLength={32}
                  />
                </div>
                <Button
                  id="waitlist-code-submit"
                  type="button"
                  disabled={submitting}
                  disabledStyle="dim"
                  layout="shrink"
                  size="narrow"
                  onClick={onConfirmCode}
                >
                  {t('auth:waitlist.confirm.submit')}
                </Button>
              </div>
              {/*
                  A new code, for the expired one. The gap is a courtesy that
                  collapses a double-tap, not a security boundary.
              */}
              <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
                <RichMessage
                  id={cooldownLeft > 0 ? 'auth:waitlist.resend.cooldown' : resending ? 'auth:waitlist.resend.sending' : 'auth:waitlist.resend.ready'}
                  values={cooldownLeft > 0 ? { count: cooldownLeft } : {}}
                  components={[
                <button
                  id="waitlist-resend"
                  type="button"
                  disabled={resending || cooldownLeft > 0}
                  onClick={onResend}
                  className="font-medium text-violet-700 dark:text-violet-400 hover:underline disabled:opacity-50 disabled:no-underline disabled:cursor-default"
                />,
                ]}
                />
              </p>
              <p
                id="waitlist-resend-note"
                className={msgClass(resendNote ? resendNote.tone : null)}
              >
                {resendNote ? resendNote.text : null}
              </p>
            </div>
          </div>
          {/* A wrong or missing code says so here, under the field. */}
          <p id="waitlist-msg" className={msgClass(msg ? msg.tone : null)}>
            {msg ? msg.text : null}
          </p>
          {/*
              What replaces the block above once the state is known: where
              this signup stands, read back.
          */}
          <div
            id="waitlist-confirmed"
            className={hiddenFirst(
              !confirmed,
              // The waiting room's card (#5262): plane white, 20px, one
              // hairline, so the answer looks like the room it describes.
              'mt-4 rounded-[20px] bg-white p-4 shadow-[inset_0_0_0_1px_var(--app-sheet-line)] dark:bg-zinc-900',
            )}
          >
            <p className="text-sm text-zinc-600 dark:text-zinc-300">
              {admitted
                ? (status?.has_account
                  ? t('auth:waitlist.status.leadHasAccount')
                  : t('auth:waitlist.status.leadAdmitted'))
                : t('auth:waiting.lead')}
            </p>
            {/*
                The same three-state vocabulary the stage-2 screen shows, from
                the same table in waitlist-shared.tsx (#1538).
            */}
            <div className="mt-2">
              <StatusPill
                id="waitlist-status-pill"
                status={status}
                note={false}
              />
            </div>
            {/*
                When they joined: a fact the row holds, in place of a queue
                position nothing on the platform computes.
            */}
            <p
              id="waitlist-status-since"
              className={hiddenFirst(
                !joinedOn,
                'mt-2 text-sm text-zinc-500 dark:text-zinc-400',
              )}
            >
              {joinedOn ? t('auth:waitlist.status.since', { date: joinedOn }) : null}
            </p>
            {/* Which address that mail goes to (#1537). */}
            <p
              id="waitlist-confirmed-email"
              className={hiddenFirst(
                !sentTo,
                'mt-2 text-sm text-zinc-500 dark:text-zinc-400 break-words',
              )}
            >
              <RichMessage id="auth:waitlist.status.registeredWith" values={{ email: sentTo }} components={[<span className="font-medium text-zinc-700 dark:text-zinc-200" />]} />
            </p>
            {/*
                The one thing a released signup can act on (#1538): create
                the account with this address, or sign in when it exists.
            */}
            <a
              id="waitlist-status-action"
              href={status?.has_account ? '#login' : '#signup'}
              className={hiddenFirst(
                !admitted,
                'mt-3 inline-block rounded-lg bg-violet-600 hover:bg-violet-500 px-4 py-2 text-sm font-medium text-white transition-colors',
              )}
            >
              {status?.has_account ? t('auth:waitlist.status.signIn') : t('auth:waitlist.status.createAccount')}
            </a>
          </div>
          <div
            id="waitlist-more-offer"
            // Hidden once admitted (#1538): moving up a list you are already
            // off is not an offer worth making.
            className={hiddenFirst(
              !offer || admitted,
              'mt-4 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/60 p-4',
            )}
          >
            <p className="text-xs font-semibold uppercase tracking-widest text-violet-700 dark:text-violet-400">
              {t('auth:waitlist.more.eyebrow')}
            </p>
            <h3 className="mt-1 text-base font-semibold">
              {t('auth:waitlist.more.title')}
            </h3>
            <p className="mt-1.5 text-sm text-zinc-500 dark:text-zinc-400">
              {surveyAnswered
                ? t('auth:waitlist.more.answered')
                : t('auth:waitlist.more.offer')}
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
              <a
                id="waitlist-more-link"
                href={moreToken ? '#more/' + moreToken : '#landing'}
                className="rounded-lg bg-violet-600 hover:bg-violet-500 px-4 py-2 text-sm font-medium text-white transition-colors"
              >
                {surveyAnswered ? t('auth:waitlist.more.edit') : t('auth:waitlist.more.start')}
              </a>
              <span className="text-xs text-zinc-500 dark:text-zinc-400">
                {t('auth:waitlist.more.skip')}
              </span>
            </div>
          </div>
        </div>
      </div>
        </>
      ) : null}
    </main>
  );
}
