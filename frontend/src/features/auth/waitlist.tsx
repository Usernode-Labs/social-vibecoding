/**
 * `#auth-waitlist-screen` — the stage-1 waitlist survey (#1080, step 2 chunk C,
 * screen 5 of 6).
 *
 * Two questions on their own screen (`#waitlist`), reached from the landing
 * CTA link and the persistent header's "Join waitlist" button. The chips and
 * the country list come from `GET /api/public/waitlist/options` so the form and
 * the server's validation share one definition — see waitlist-shared.tsx, which
 * stage 2 reads too.
 *
 * It asked four until 27 Aug 2026. The free-text city beside the country
 * select, the "which one?" follow-up under the discovery chips and the
 * "did someone refer you?" handle are gone: none was read back, and the
 * referral one asked for a claim the invite link already records as a row
 * reference (`invite_code` / `invited_by`).
 *
 * ── What the initial render must be ───────────────────────────────────
 *
 * Everything options-driven renders empty and everything conditional renders
 * hidden, because that is what the hand-written document shipped and the
 * prerender pass has to reproduce it byte for byte. So: the chip row is an
 * empty `<div>`, the country select holds only its placeholder `<option>`, and
 * the joined / offer / queued blocks keep the `hidden` in the exact position
 * their class attribute had it. The options fetch runs in an effect.
 *
 * ── One step at a time ───────────────────────────────────────────────
 *
 * The screen carries three states in one column, and until the two-step
 * waitlist only the
 * middle one ended visibly. The title and the two intro paragraphs stayed up
 * after a join — still selling the thing you had just said yes to, with the
 * one instruction that now mattered four blocks down — and confirming the code
 * merely HID `#waitlist-confirm`, so the control you were typing into vanished
 * with nothing in its place. A control that disappears without a word reads as
 * a failure.
 *
 * So: the pitch hides on `joined`, `#waitlist-confirmed` takes the confirm
 * block's place on `confirmed`, and `#waitlist-step` names which of the two
 * steps you are on. Two steps, not three — the stage-2 survey is offered after
 * both and counting it would make an optional thing look required.
 *
 * ── Confirming is what puts you on the list ──────────────────────────
 *
 * Submitting the form used to say "You're on the list 🎉" and offer the
 * stage-2 questions immediately, with confirmation an afterthought below
 * them. It read as done, so the address never had to prove it could receive
 * mail — and an unconfirmed row is one we cannot release to.
 *
 * Now the POST buys a code and nothing else: `joined` says "check your
 * email", and both the list-place copy and the offer live behind
 * `confirmed`. The row is still written on the POST — it has to be, to hold
 * the code and to keep the address unique — so this is a change in what the
 * screen CLAIMS and what it unlocks, not in the write model.
 *
 * ── Screenshot state ─────────────────────────────────────────────────
 *
 * Two, because there are two settled states to paint. `?shot=waitlist-joined`
 * stops at the confirm step, where a real join now stops;
 * `?shot=waitlist-confirmed` carries the list place and the stage-2 offer.
 * Both are pure UI state: neither POSTs, neither writes, and the stage-2 link
 * keeps its inert prerendered href.
 */

import { useCallback, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';

import { useMountedOnReveal } from '../../lib/mount-on-reveal';
import { useVisibilityHiddenClass } from '../../lib/visibility-store';
import {
  AUTH_SCREEN_IDS,
  hasSession as sessionExists,
  hiddenFirst,
  hiddenLast,
  useAuthScreensPatch,
} from './shared';
import {
  ChipRow,
  MsgTone,
  msgClass,
  // Aliased: `options` is already the name of this screen's fetched
  // options object, and the helper renders a map of them.
  options as opts,
  useWaitlistOptions,
} from './waitlist-shared';

export function WaitlistScreen() {
  const rootRef = useRef<HTMLElement>(null);
  useVisibilityHiddenClass(rootRef, AUTH_SCREEN_IDS.waitlist, false);
  // The screen's interior mounts on its first reveal, not in the prerender —
  // see lib/mount-on-reveal.ts. AuthScreens.show() asks for it (through
  // window.UsernodeReact.mount) before it wires or reveals the screen, so the
  // hooks this component patches onto AuthScreens are installed and the
  // interior's nodes exist by the time the on-show hook runs.
  const mounted = useMountedOnReveal(AUTH_SCREEN_IDS.waitlist);

  const options = useWaitlistOptions();

  const [hasSession, setHasSession] = useState(false);
  const [joined, setJoined] = useState(false);
  // The stage-2 offer and its token are separate: `?shot=waitlist-confirmed`
  // shows the offer with no token at all, and its link keeps the inert
  // prerendered href.
  const [offer, setOffer] = useState(false);
  const [moreToken, setMoreToken] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ text: string; tone: MsgTone } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [discovery, setDiscovery] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  /**
   * The address the code went to, echoed back in the confirm step AND in the
   * settled `#waitlist-confirmed` panel — "which address did I use?" is the
   * question that panel used to leave open (#1537). Empty at first render, and
   * both readers resolve to their address-less form when it is: the prerendered
   * document has no address to name.
   *
   * Stored lower-cased, matching what the server normalizes and stores, so the
   * two surfaces that name the address agree with each other and with the
   * stage-2 screen at `#more/<token>`.
   */
  const [sentTo, setSentTo] = useState('');
  /**
   * Re-entrancy guard for the confirm POST. `submitting` is state and
   * `onConfirmCode` closes over the mount's value of it, so on a slow network
   * the auto-submit below would fire a second request while the first was
   * still open. A ref reads live.
   */
  const busy = useRef(false);

  const email = useRef<HTMLInputElement>(null);
  const code = useRef<HTMLInputElement>(null);
  const country = useRef<HTMLSelectElement>(null);
  /**
   * The inviter's code, from `/#waitlist?ref=<code>`. It rides in the hash's
   * own query segment — after the `?` INSIDE the fragment — the same place
   * the OAuth connect round trip puts its status, so it never reaches a
   * server log, ours or a proxy's. Read on show rather than at mount: this
   * screen stays mounted across navigations.
   */
  const inviteRef = useRef<string | null>(null);

  /**
   * Form vs "you're already on the list", plus the screen title. A
   * waiting-room session already HAS an account in the queue, so the join form
   * is wrong for them — the same predicate the landing header uses.
   */
  const waitlistOnShow = useCallback(() => {
    let shot: string | null = null;
    try {
      shot = new URLSearchParams(location.search).get('shot');
    } catch {
      shot = null;
    }
    // The two settled states, painted without a submit. `waitlist-joined`
    // stops at the confirm step, because that is now where a real join
    // stops; `waitlist-confirmed` is the one that carries the offer.
    const shotJoined = shot === 'waitlist-joined';
    const shotConfirmed = shot === 'waitlist-confirmed';
    if (shotJoined || shotConfirmed) {
      setMsg(null);
      setJoined(true);
      // A stand-in address, so both settled states paint the line that names
      // it. Deliberately a literal and not a fetch: these branches only ever
      // set state, because a shot has no join behind it to read an address
      // from.
      setSentTo('you@example.com');
    }
    if (shotConfirmed) {
      setConfirmed(true);
      setOffer(true);
    }

    // Who invited them, if they arrived on somebody's share link. A code
    // that doesn't resolve is dropped server-side rather than refused, so a
    // stale link never blocks a join.
    try {
      const ref = new URLSearchParams(location.hash.split('?')[1] || '').get('ref');
      inviteRef.current = ref && /^[a-z0-9]{10}$/.test(ref) ? ref : null;
    } catch {
      inviteRef.current = null;
    }

    const session = sessionExists();
    setHasSession(session);
    // Never resurrect the form over the success state (a re-show after a join,
    // e.g. back-then-forward).
    if (!session && !joined && !shotJoined && !shotConfirmed) {
      email.current?.focus({ preventScroll: true });
    }
    // Mirror into the tab title so the Flutter WebView's AppBar follows the
    // screen, same as the landing header does for the landing page.
    try {
      document.title = 'Join the waitlist';
    } catch {
      /* ignore */
    }
  }, [joined]);

  const onSubmit = useCallback(
    async (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      const emailVal = email.current?.value.trim() || '';
      // Client preflight mirroring the server's stage-1 rules. Only the
      // address is required now, so this is the only miss worth catching
      // without a round trip.
      if (!emailVal) return setMsg({ text: 'Please enter your email.', tone: 'error' });

      setSubmitting(true);
      try {
        const res = await fetch('/api/public/waitlist', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: emailVal,
            country: country.current?.value || undefined,
            discovery_source: discovery || undefined,
            invite_code: inviteRef.current || undefined,
          }),
        });
        const data = await res.json().catch(() => null);
        if (res.ok) {
          // Joined: swap the form for the success state, and offer stage 2
          // right away when this was a first join (the email carries the same
          // link for anyone who stops here).
          setMsg(null);
          setJoined(true);
          // Lower-cased to match the stored form: the server normalizes before
          // it writes, so echoing back what was typed would disagree with the
          // address the stage-2 screen names.
          setSentTo(emailVal.toLowerCase());
          // Six digits is the whole of what is left to do, so put the caret
          // there. On a REAL join only: the `?shot=` states have to paint a
          // settled state for the declared checks, and a focus ring is not one.
          window.setTimeout(() => code.current?.focus({ preventScroll: true }), 0);
          // The token is kept but the offer stays down: nothing is offered
          // until the address is confirmed, because until then there is no
          // list place to move up.
          const token = (data && data.more_token) || null;
          if (token) setMoreToken(token);
        } else {
          setMsg({
            text: (data && data.error) || 'Something went wrong. Try again.',
            tone: 'error',
          });
        }
      } catch {
        setMsg({ text: 'Connection issue. Try again.', tone: 'error' });
      }
      setSubmitting(false);
    },
    [discovery],
  );

  /**
   * Confirm the address with the six-digit code from the join mail. The link
   * in that same mail does the same thing; whichever is used first wins.
   *
   * The email input keeps its value after a join — the form is hidden, not
   * cleared — so `email.current` is still the address the code went to.
   */
  const onConfirmCode = useCallback(async () => {
    if (busy.current) return;
    const codeVal = code.current?.value.trim() || '';
    if (!/^[0-9]{6}$/.test(codeVal)) {
      return setMsg({ text: 'Enter the six-digit code from your email.', tone: 'error' });
    }
    busy.current = true;
    setSubmitting(true);
    try {
      const res = await fetch('/api/public/waitlist/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.current?.value.trim() || '', code: codeVal }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok) {
        setMsg(null);
        setConfirmed(true);
        // Confirming is what puts somebody on the list, so it is also what
        // unlocks the questions that move them up it. The token may have
        // arrived on the join response instead of this one, so raise the
        // offer either way.
        const token = (data && data.more_token) || null;
        if (token) setMoreToken(token);
        setOffer(true);
      } else {
        setMsg({ text: (data && data.error) || 'That code did not work.', tone: 'error' });
      }
    } catch {
      setMsg({ text: 'Connection issue. Try again.', tone: 'error' });
    }
    busy.current = false;
    setSubmitting(false);
  }, []);

  /**
   * Keep the field to six digits, and confirm as soon as it has them.
   *
   * The address bar is not where this code comes from: people paste it out of
   * a mail app, which brings "123 456" or "Code: 123456" with it. Strip rather
   * than reject — and because the strip is what enforces the length, the
   * field's own `maxLength` is loose enough that a pasted string reaches it
   * intact instead of being truncated mid-number.
   *
   * The Confirm button stays. Auto-submit is the fast path, not the only one:
   * a wrong code has to be correctable, and correcting one digit of six is an
   * edit, not a sixth keystroke.
   */
  const onCodeInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const el = e.currentTarget;
      const digits = el.value.replace(/[^0-9]/g, '').slice(0, 6);
      if (digits !== el.value) el.value = digits;
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
      <a
        href="#landing"
        data-auth-back=""
        className="fixed left-4 z-10 text-sm text-zinc-500 dark:text-zinc-400 hover:text-violet-400"
        style={{ top: 'calc(env(safe-area-inset-top, 0px) + 1rem)' }}
      >
        &larr; Back
      </a>
      <div className="max-w-2xl mx-auto px-6 py-16">
        {/*
            Where you are. Hidden for a waiting-room session, which is shown
            `#waitlist-queued` rather than a flow it is already past.
        */}
        <p
          id="waitlist-step"
          className={hiddenLast(
            hasSession,
            'text-xs font-semibold uppercase tracking-widest text-violet-700 dark:text-violet-400',
          )}
        >
          {confirmed
            ? 'All done'
            : joined
              ? 'Step 2 of 2 · Confirm your email'
              : 'Step 1 of 2 · Your email'}
        </p>
        {/*
            The pitch. It answers "why would I join", so it belongs to step 1
            only — after the join it is four blocks of answered question sitting
            on top of the one instruction that still matters.
        */}
        <h1 className={hiddenLast(joined, 'mt-1 text-2xl font-bold')}>
          Join the waitlist
        </h1>
        <p className={hiddenLast(joined, 'mt-3 text-sm text-zinc-500 dark:text-zinc-400')}>
          Usernode Social Vibecoding is a place where users describe the app
        they want in chat, an AI builds it, and the community votes the
        changes in. Every app in the directory was built here by the people
        who use it. They run on the Usernode chain, and contributors own a
        share of what they build.
        </p>
        <p className={hiddenLast(joined, 'mt-3 text-sm text-zinc-500 dark:text-zinc-400')}>
          Platform access opens in batches. Join the waitlist and we'll email
        you when your spot opens. The public apps are open to everyone right
        now.
          <span className="font-medium text-zinc-700 dark:text-zinc-200">
            Just your email to join.
          </span>
        </p>
        {/*
            Stage-1 waitlist survey (two-stage waitlist, ported from the
            original topochain waitlist): email, something you've made,
            where you are, how you found us. Option chips and the country
            list render from GET /api/public/waitlist/options so the form
            and server validation share one definition.
        */}
        <form
          id="waitlist-form"
          className={hiddenLast(hasSession || joined, 'mt-8 space-y-5')}
          onSubmit={onSubmit}
        >
          <div>
            <label htmlFor="waitlist-email" className="block text-sm font-medium text-zinc-700 dark:text-zinc-200">
              Your email address
              <span className="text-red-700 dark:text-red-400">
                *
              </span>
            </label>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5 mb-1.5">
              We only email you when your spot comes up. No newsletter.
            </p>
            <input
              ref={email}
              id="waitlist-email"
              type="email"
              required={true}
              maxLength={255}
              placeholder="you@example.com"
              autoComplete="email"
              className="w-full rounded-lg bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-200">
              Country
              <span className="text-zinc-500 font-normal dark:text-zinc-400">
                Optional
              </span>
            </label>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5 mb-1.5">
              We&rsquo;re building early groups across different regions.
            </p>
            <select
              ref={country}
              id="waitlist-country"
              className="w-full rounded-lg bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent"
            >
              <option value="">
                Select a country&hellip;
              </option>
              {/* One flat alphabetical list of all 249 ISO 3166-1 countries
                  and territories. It was six <optgroup> region buckets until
                  #1527: they left ~200 places unselectable and hid the ones
                  they did carry from an alphabetical scan. The server sends
                  the map already sorted by English name, so insertion order
                  IS display order and nothing sorts here. */}
              {opts(options?.countries)}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-200">
              How did you find us?
              <span className="text-zinc-500 font-normal dark:text-zinc-400">
                Optional
              </span>
            </label>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5 mb-1.5">
              Pick the closest one.
            </p>
            <ChipRow
              id="waitlist-discovery-chips"
              options={options?.discovery_sources || {}}
              value={discovery}
              onChange={setDiscovery}
            />
          </div>
          <Button
            type="submit"
            id="waitlist-submit"
            disabled={submitting}
            disabledStyle="dim"
            size="lg"
          >
            Join the waitlist
          </Button>
        </form>
        <p id="waitlist-msg" className={msgClass(msg ? msg.tone : null)}>
          {msg ? msg.text : null}
        </p>
        {/*
            Success state: joined. Stage 2 is offered straight away —
            people are most willing to keep answering right after they
            commit; the join email carries the same link for anyone who
            stops here.
        */}
        <div id="waitlist-joined" className={hiddenFirst(!joined, 'mt-8')}>
          <p className={hiddenLast(confirmed, 'text-sm font-medium text-zinc-700 dark:text-zinc-200')}>
            Check your email
          </p>
          <p className={hiddenLast(confirmed, 'mt-1 text-sm text-zinc-500 dark:text-zinc-400')}>
            One more step. Confirm your address and you&rsquo;re on the list.
          </p>
          {/*
              Confirming by code, for the phone: leaving for the mail app and
              coming back loses the WebView's place, so typing six digits
              beats following a link. The same mail carries both, and the
              first one used stamps confirmed_at.
          */}
          <div id="waitlist-confirm" className={hiddenLast(confirmed, 'mt-4')}>
            <label
              htmlFor="waitlist-code"
              className="block text-sm font-medium text-zinc-700 dark:text-zinc-200"
            >
              Confirm your email
            </label>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5 mb-1.5">
              {sentTo
                ? `We sent a six-digit code to ${sentTo}. You can also just click the link in that email.`
                : 'We sent a six-digit code. You can also just click the link in that email.'}
            </p>
            <div className="flex gap-2">
              <input
                ref={code}
                id="waitlist-code"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={32}
                placeholder="000000"
                onChange={onCodeInput}
                className="w-full rounded-lg bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm font-mono placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent"
              />
              <Button
                id="waitlist-code-submit"
                type="button"
                disabled={submitting}
                disabledStyle="dim"
                layout="shrink"
                size="narrow"
                onClick={onConfirmCode}
              >
                Confirm
              </Button>
            </div>
          </div>
          {/*
              What replaces the block above. `confirmed` used to only hide it,
              so a correct code deleted the control and said nothing — the
              reading of which is that something went wrong.
          */}
          <div
            id="waitlist-confirmed"
            className={hiddenFirst(
              !confirmed,
              'mt-4 rounded-lg border border-emerald-200 dark:border-emerald-500/30 bg-emerald-50 dark:bg-emerald-500/10 p-4',
            )}
          >
            <p className="text-sm font-medium text-emerald-700 dark:text-emerald-400">
              You&rsquo;re on the list 🎉
            </p>
            <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-300">
              We&rsquo;re opening access in small groups. We&rsquo;ll email you when yours comes up.
            </p>
            {/*
                Which address that mail goes to (#1537). Always in the markup and
                hidden until there is an address to name: the prerendered
                document has none, and the id is part of the shell's inventory,
                so rendering the node conditionally would take it out of the
                document entirely. An empty "Registered with" reads as a bug,
                hence `hidden` rather than an empty line. `break-words` so a long
                address wraps instead of widening the card on a phone.
            */}
            <p
              id="waitlist-confirmed-email"
              className={hiddenFirst(
                !sentTo,
                'mt-2 text-sm text-zinc-500 dark:text-zinc-400 break-words',
              )}
            >
              Registered with{' '}
              <span className="font-medium text-zinc-700 dark:text-zinc-200">{sentTo}</span>
            </p>
          </div>
          <div
            id="waitlist-more-offer"
            className={hiddenFirst(
              !offer,
              'mt-4 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/60 p-4',
            )}
          >
            <p className="text-xs font-semibold uppercase tracking-widest text-violet-700 dark:text-violet-400">
              Optional (moves you up the list)
            </p>
            <h3 className="mt-1 text-base font-semibold">
              Want in sooner?
            </h3>
            <p className="mt-1.5 text-sm text-zinc-500 dark:text-zinc-400">
              Four more questions, about three minutes: the group you&rsquo;d bring,
            a tool you&rsquo;ve lost, where else you are. These are the answers we
            actually read when we pick the next group.
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
              <a
                id="waitlist-more-link"
                href={moreToken ? '#more/' + moreToken : '#landing'}
                className="rounded-lg bg-violet-600 hover:bg-violet-500 px-4 py-2 text-sm font-medium text-white transition-colors"
              >
                Answer them now
              </a>
              <span className="text-xs text-zinc-500 dark:text-zinc-400">
                Or stop here. You&rsquo;re on the list either way, and the link is in your email.
              </span>
            </div>
          </div>
        </div>
        {/*
            Swapped in for the form when a (waiting-room) session exists —
            they already have an account in the queue, so asking them to
            join again is wrong. Mirrors #landing-cta-queued.
        */}
        <p
          id="waitlist-queued"
          className={hiddenFirst(!hasSession, 'mt-8 text-sm text-zinc-500 dark:text-zinc-400')}
        >
          You're already on the waitlist. We'll email you when your spot opens.
        </p>
      </div>
        </>
      ) : null}
    </main>
  );
}
