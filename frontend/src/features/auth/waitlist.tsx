/**
 * `#auth-waitlist-screen` — the stage-1 waitlist survey (#1080, step 2 chunk C,
 * screen 5 of 6).
 *
 * Four questions on their own screen (`#waitlist`), reached from the landing
 * CTA link and the persistent header's "Join waitlist" button. The chips and
 * the country list come from `GET /api/public/waitlist/options` so the form and
 * the server's validation share one definition — see waitlist-shared.tsx, which
 * stage 2 reads too.
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
 * ── Screenshot state ─────────────────────────────────────────────────
 *
 * `?shot=waitlist-joined` paints the post-submit success state with the stage-2
 * offer, so the captures and dapp.json's check have a URL for it. Pure UI
 * state: it never POSTs, never writes, and the stage-2 link keeps its inert
 * prerendered href.
 */

import { useCallback, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';

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
  useWaitlistOptions,
} from './waitlist-shared';

export function WaitlistScreen() {
  const rootRef = useRef<HTMLElement>(null);
  useVisibilityHiddenClass(rootRef, AUTH_SCREEN_IDS.waitlist, false);

  const options = useWaitlistOptions();

  const [hasSession, setHasSession] = useState(false);
  const [joined, setJoined] = useState(false);
  // The stage-2 offer and its token are separate: `?shot=waitlist-joined`
  // shows the offer with no token at all, and its link keeps the inert
  // prerendered href.
  const [offer, setOffer] = useState(false);
  const [moreToken, setMoreToken] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ text: string; tone: MsgTone } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [discovery, setDiscovery] = useState<string | null>(null);

  const email = useRef<HTMLInputElement>(null);
  const madeUrl = useRef<HTMLInputElement>(null);
  const madeNote = useRef<HTMLInputElement>(null);
  const country = useRef<HTMLSelectElement>(null);
  const city = useRef<HTMLInputElement>(null);
  const discoveryDetail = useRef<HTMLInputElement>(null);
  const referrer = useRef<HTMLInputElement>(null);

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
    // The success state, painted without a submit.
    const shotJoined = shot === 'waitlist-joined';
    if (shotJoined) {
      setMsg(null);
      setJoined(true);
      setOffer(true);
    }

    const session = sessionExists();
    setHasSession(session);
    // Never resurrect the form over the success state (a re-show after a join,
    // e.g. back-then-forward).
    if (!session && !joined && !shotJoined) {
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
      const madeUrlVal = madeUrl.current?.value.trim() || '';
      // Client preflight mirroring the server's stage-1 rules, so the common
      // misses get a message without a round trip.
      if (!emailVal) return setMsg({ text: 'Please enter your email.', tone: 'error' });
      if (!madeUrlVal) {
        return setMsg({ text: 'Please link something you have made.', tone: 'error' });
      }
      if (!discovery) {
        return setMsg({ text: 'Please tell us how you found us.', tone: 'error' });
      }

      setSubmitting(true);
      try {
        const res = await fetch('/api/public/waitlist', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: emailVal,
            made_url: madeUrlVal,
            made_note: madeNote.current?.value.trim() || undefined,
            country: country.current?.value || undefined,
            city: city.current?.value.trim() || undefined,
            discovery_source: discovery,
            discovery_detail: discoveryDetail.current?.value.trim() || undefined,
            referrer_handle: referrer.current?.value.trim() || undefined,
          }),
        });
        const data = await res.json().catch(() => null);
        if (res.ok) {
          // Joined: swap the form for the success state, and offer stage 2
          // right away when this was a first join (the email carries the same
          // link for anyone who stops here).
          setMsg(null);
          setJoined(true);
          const token = (data && data.more_token) || null;
          if (token) {
            setMoreToken(token);
            setOffer(true);
          }
        } else {
          setMsg({
            text: (data && data.error) || 'Something went wrong — try again.',
            tone: 'error',
          });
        }
      } catch {
        setMsg({ text: 'Connection issue — try again.', tone: 'error' });
      }
      setSubmitting(false);
    },
    [discovery],
  );

  const live = useRef({ waitlistOnShow });
  live.current = { waitlistOnShow };
  useAuthScreensPatch({
    _wireWaitlist: () => {},
    _waitlistOnShow: () => live.current.waitlistOnShow(),
  });

  const detailLabel = (options?.discovery_detail_labels || {})[discovery || ''] || 'Which one?';

  return (
    <main
      ref={rootRef}
      id="auth-waitlist-screen"
      className="hidden fixed inset-0 z-40 overflow-y-auto platform-safe-scroll bg-white dark:bg-zinc-950"
    >
      <a
        href="#landing"
        data-auth-back=""
        className="fixed left-4 z-10 text-sm text-zinc-500 dark:text-zinc-400 hover:text-violet-400"
        style={{ top: 'calc(env(safe-area-inset-top, 0px) + 1rem)' }}
      >
        &larr; Back
      </a>
      <div className="max-w-2xl mx-auto px-6 py-16">
        <h1 className="text-2xl font-bold">
          Join the waitlist
        </h1>
        <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">
          Usernode Social Vibecoding is a place where users describe the app
        they want in chat, an AI builds it, and the community votes the
        changes in. Every app in the directory was built here by the people
        who use it — they run on the Usernode chain, and contributors own a
        share of what they build.
        </p>
        <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">
          Platform access opens in batches. Join the waitlist and we'll email
        you when your spot opens — the public apps are open to everyone right
        now.
          <span className="font-medium text-zinc-700 dark:text-zinc-200">
            Four questions to join.
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
            <label
              htmlFor="waitlist-made-url"
              className="block text-sm font-medium text-zinc-700 dark:text-zinc-200"
            >
              Link something you&rsquo;ve made
              <span className="text-red-700 dark:text-red-400">
                *
              </span>
            </label>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5 mb-1.5">
              A repo, a site, a bot, a mod, a newsletter, a spreadsheet that runs your fantasy league. Built with AI counts — we care that it exists, not how you made it.
            </p>
            <input
              ref={madeUrl}
              id="waitlist-made-url"
              type="url"
              maxLength={2000}
              placeholder="https://"
              className="w-full rounded-lg bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent"
            />
            <input
              ref={madeNote}
              id="waitlist-made-note"
              type="text"
              maxLength={140}
              placeholder="What is it, in one line? — optional"
              className="mt-2 w-full rounded-lg bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-200">
              Where are you?
              <span className="text-zinc-500 font-normal dark:text-zinc-400">
                Optional
              </span>
            </label>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5 mb-1.5">
              We balance each group across regions. It&rsquo;s never used to reject anyone — leave it blank if you&rsquo;d rather not say.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <select
                ref={country}
                id="waitlist-country"
                className="w-full rounded-lg bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent"
              >
                <option value="">
                  Select a country&hellip;
                </option>
                {Object.entries(options?.countries || {}).map(([region, codes]) => (
                  <optgroup key={region} label={region}>
                    {Object.entries(codes).map(([code, name]) => (
                      <option key={code} value={code}>
                        {name}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
              <input
                ref={city}
                id="waitlist-city"
                type="text"
                maxLength={120}
                placeholder="City"
                className="w-full rounded-lg bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent"
              />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-200">
              How did you find us?
              <span className="text-red-700 dark:text-red-400">
                *
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
            <input
              ref={discoveryDetail}
              id="waitlist-discovery-detail"
              type="text"
              maxLength={255}
              placeholder={detailLabel + ' — optional'}
              className="mt-2 w-full rounded-lg bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent"
            />
            <input
              ref={referrer}
              id="waitlist-referrer"
              type="text"
              maxLength={255}
              placeholder="Did someone refer you? Their handle — optional"
              className="mt-2 w-full rounded-lg bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent"
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
          <p className="text-sm text-emerald-700 dark:text-emerald-400 font-medium">
            You're on the waitlist — we'll email you when your spot opens.
          </p>
          <div
            id="waitlist-more-offer"
            className={hiddenFirst(
              !offer,
              'mt-4 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/60 p-4',
            )}
          >
            <p className="text-xs font-semibold uppercase tracking-widest text-violet-700 dark:text-violet-400">
              Optional — moves you up the list
            </p>
            <h3 className="mt-1 text-base font-semibold">
              Want in sooner?
            </h3>
            <p className="mt-1.5 text-sm text-zinc-500 dark:text-zinc-400">
              Four more questions, about three minutes — the group you&rsquo;d bring,
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
                Or stop here — you&rsquo;re on the list either way, and the link is in your email.
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
          You're already on the waitlist — we'll email you when your spot opens.
        </p>
      </div>
    </main>
  );
}
