/**
 * `#auth-more-screen` — the stage-2 waitlist survey (#1080, step 2 chunk C,
 * screen 6 of 6).
 *
 * "Want in sooner?": four optional questions reached at `#more/<token>`, from
 * the stage-1 success state or the join email. Answers merge server-side, so the
 * form is re-openable and every show re-reads
 * `GET /api/public/waitlist/more/<token>` to render what is already stored.
 *
 * ── What the initial render must be ───────────────────────────────────
 *
 * Both outcomes of the token check start hidden — the form AND the bad-token
 * notice — because that is what the hand-written document shipped and the
 * prerender pass has to reproduce it byte for byte. Same for everything the
 * options payload fills: the two selects hold only their placeholder `<option>`,
 * the three chip rows are empty `<div>`s, the connect row and the invites list
 * are empty, and the loss detail block keeps its `hidden`. Nothing is fetched
 * until the router shows the screen.
 *
 * ── Uncontrolled inputs, on purpose ──────────────────────────────────
 *
 * The free-text fields are refs, not React state: a `value` prop would put the
 * stored answers into the prerendered HTML (there aren't any at prerender time,
 * but an empty `value=""` attribute is still a byte difference), and the screen
 * only ever reads them at submit. So the load path assigns `.value` the way
 * `_renderMore` did — the form element is mounted from the first render, just
 * hidden, so its refs are live well before the fetch resolves.
 *
 * ── ?connect= ────────────────────────────────────────────────────────
 *
 * GitHub / X verification is a `/waitlist/connect/<provider>` OAuth round trip
 * that comes back to `#more/<token>?connect=<outcome>` — inside the hash, so the
 * token never reaches a server log. The outcome is read on show and painted into
 * the same status line the submit uses.
 */

import { useCallback, useRef, useState } from 'react';
import { flushSync } from 'react-dom';

import { Button } from '@/components/ui/button';

import { useVisibilityHiddenClass } from '../../lib/visibility-store';
import { AUTH_SCREEN_IDS, hiddenFirst, useAuthScreensPatch } from './shared';
import {
  ChipRow,
  MsgTone,
  MultiChipRow,
  msgClass,
  options as optionList,
  toggleChip,
  waitlistOptions,
  WaitlistOptions,
} from './waitlist-shared';

/** Hard ceiling on invite rows, matching `_addInviteRow`'s own cap. */
const MAX_INVITE_ROWS = 5;

/** `GET /api/public/waitlist/more/<token>`. Every field is optional. */
interface MoreAnswers {
  group?: { name?: string; size?: string; role?: string; tools?: string[]; need?: string };
  loss?: { had?: string; product?: string; kind?: string[]; story?: string };
  handles?: { farcaster?: string; discord?: string; telegram?: string; other?: string };
  verified?: Record<string, string>;
  invites?: string[];
  admit_together?: boolean;
  referrer_handle?: string;
}

interface MorePayload {
  ok?: boolean;
  answers?: MoreAnswers;
  oauth?: Record<string, boolean>;
}

/** One invite row. The id keys the row; the value is only its initial one. */
interface InviteRow {
  id: number;
  initial: string;
}

export function MoreScreen() {
  const rootRef = useRef<HTMLElement>(null);
  useVisibilityHiddenClass(rootRef, AUTH_SCREEN_IDS.more, false);

  // 'idle' is the prerendered state: neither the form nor the notice is shown.
  // 'throttled' is a rate-limited load — the token may be perfectly fine, so
  // it gets its own copy instead of the bad-link notice (#1296).
  const [status, setStatus] = useState<'idle' | 'invalid' | 'throttled' | 'ready'>('idle');
  const [retryText, setRetryText] = useState('a few minutes');
  const [opts, setOpts] = useState<WaitlistOptions | null>(null);
  const [tools, setTools] = useState<string[]>([]);
  const [lossHad, setLossHad] = useState<string | null>(null);
  const [lossKinds, setLossKinds] = useState<string[]>([]);
  const [connect, setConnect] = useState<{
    verified: Record<string, string>;
    oauth: Record<string, boolean>;
  }>({ verified: {}, oauth: {} });
  const [invites, setInvites] = useState<InviteRow[]>([]);
  const [msg, setMsg] = useState<{ text: string; tone: MsgTone } | null>(null);
  const [saving, setSaving] = useState(false);

  const groupName = useRef<HTMLInputElement>(null);
  const groupSize = useRef<HTMLSelectElement>(null);
  const groupRole = useRef<HTMLSelectElement>(null);
  const groupNeed = useRef<HTMLTextAreaElement>(null);
  const lossProduct = useRef<HTMLInputElement>(null);
  const lossStory = useRef<HTMLTextAreaElement>(null);
  const farcaster = useRef<HTMLInputElement>(null);
  const discord = useRef<HTMLInputElement>(null);
  const telegram = useRef<HTMLInputElement>(null);
  const other = useRef<HTMLInputElement>(null);
  const admitTogether = useRef<HTMLInputElement>(null);
  const referrer = useRef<HTMLInputElement>(null);

  // The token from `#more/<token>`, and the next invite row's key.
  const token = useRef<string | null>(null);
  const nextInviteId = useRef(0);
  const inviteEls = useRef(new Map<number, HTMLInputElement | null>());

  /**
   * The invite rows, mirrored in a ref. Add and remove used to read
   * `#more-invites`'s live child count, so several clicks in one tick each saw
   * the previous one's row; reading `invites` instead would see the value from
   * the last render and let a fast clicker past the cap. The ref restores the
   * live read, and every write goes through {@link setInviteRows}.
   */
  const invitesRef = useRef<InviteRow[]>([]);
  const setInviteRows = useCallback((next: InviteRow[]) => {
    invitesRef.current = next;
    setInvites(next);
  }, []);

  const inviteRows = useCallback((values: string[]): InviteRow[] => {
    return values.map((initial) => ({ id: nextInviteId.current++, initial }));
  }, []);

  /**
   * Read the OAuth round trip's outcome out of the hash's own query string.
   * Returns null when there wasn't one, which is the "clear the line" case.
   */
  const connectMsg = useCallback((): { text: string; tone: MsgTone } | null => {
    let outcome: string | null = null;
    try {
      outcome = new URLSearchParams(location.hash.split('?')[1] || '').get('connect');
    } catch {
      outcome = null;
    }
    if (outcome === 'ok') return { text: 'Account verified. Thanks.', tone: 'ok' };
    if (outcome === 'failed' || outcome === 'denied' || outcome === 'unavailable') {
      return {
        text:
          outcome === 'unavailable'
            ? 'That sign-in is not available yet.'
            : 'Could not verify that account. Please try again.',
        tone: 'warn',
      };
    }
    return null;
  }, []);

  /** Apply a loaded payload: state for the rendered bits, refs for the text. */
  const render = useCallback(
    (payload: MorePayload) => {
      const a = payload.answers || {};
      const group = a.group || {};
      const loss = a.loss || {};
      const handles = a.handles || {};

      if (groupName.current) groupName.current.value = group.name || '';
      if (groupSize.current) groupSize.current.value = group.size || '';
      if (groupRole.current) groupRole.current.value = group.role || '';
      setTools(group.tools || []);
      if (groupNeed.current) groupNeed.current.value = group.need || '';

      setLossHad(loss.had || null);
      if (lossProduct.current) lossProduct.current.value = loss.product || '';
      setLossKinds(loss.kind || []);
      if (lossStory.current) lossStory.current.value = loss.story || '';

      if (farcaster.current) farcaster.current.value = handles.farcaster || '';
      if (discord.current) discord.current.value = handles.discord || '';
      if (telegram.current) telegram.current.value = handles.telegram || '';
      if (other.current) other.current.value = handles.other || '';

      setConnect({ verified: a.verified || {}, oauth: payload.oauth || {} });

      if (admitTogether.current) admitTogether.current.checked = !!a.admit_together;
      if (referrer.current) referrer.current.value = a.referrer_handle || '';

      setMsg(connectMsg());
    },
    [connectMsg],
  );

  /**
   * Both requests for a show, together: the memoised options and this token's
   * stored answers. Anything missing — no token, a network failure, a rejected
   * token — lands on the bad-link notice with the form hidden.
   */
  const loadMore = useCallback(async () => {
    const value = token.current;
    if (!value) {
      setStatus('invalid');
      return;
    }
    const [loaded, res] = await Promise.all([
      waitlistOptions(),
      fetch('/api/public/waitlist/more/' + encodeURIComponent(value)).catch(() => null),
    ]);
    if (!loaded || !res || !res.ok) {
      // A 429 is the rate limiter talking, not a verdict on the token —
      // clicking the emailed confirm link right after joining and saving
      // the survey can land here. Say so instead of "bad link" (#1296).
      if (res && res.status === 429) {
        const body = await res.json().catch(() => null);
        const secs = Number(body?.retryAfterSeconds);
        if (Number.isFinite(secs) && secs > 0) {
          const mins = Math.ceil(secs / 60);
          setRetryText(mins > 1 ? `about ${mins} minutes` : 'about a minute');
        } else {
          setRetryText('a few minutes');
        }
        setStatus('throttled');
        return;
      }
      setStatus('invalid');
      return;
    }
    const data: MorePayload | null = await res.json().catch(() => null);
    if (!data || !data.ok) {
      setStatus('invalid');
      return;
    }
    // The options have to be in the DOM before the stored answers are assigned:
    // setting `.value` on a <select> whose <option>s don't exist yet is silently
    // dropped, which is exactly why `_renderMore` called `_fillSelect` first.
    // flushSync reproduces that order — options rendered, then values assigned,
    // all in this tick, so the reveal below is still a single paint.
    const stored = Array.isArray(data.answers?.invites) ? data.answers.invites.slice() : [];
    while (stored.length < 2) stored.push('');
    flushSync(() => {
      setOpts(loaded);
      setInviteRows(inviteRows(stored.slice(0, loaded.max_invites || MAX_INVITE_ROWS)));
    });
    render(data);
    setStatus('ready');
  }, [inviteRows, render, setInviteRows]);

  const moreOnShow = useCallback(
    (value?: string) => {
      token.current = value || null;
      void loadMore();
    },
    [loadMore],
  );

  const toggleTool = useCallback((key: string) => {
    setTools((prev) => toggleChip(prev, key));
  }, []);
  const toggleLossKind = useCallback((key: string) => {
    setLossKinds((prev) => toggleChip(prev, key));
  }, []);

  const addInvite = useCallback(() => {
    const rows = invitesRef.current;
    if (rows.length >= MAX_INVITE_ROWS) return;
    setInviteRows([...rows, ...inviteRows([''])]);
  }, [inviteRows, setInviteRows]);

  /** Drop the row, or — when it's the last one — just empty it. */
  const removeInvite = useCallback(
    (id: number) => {
      const rows = invitesRef.current;
      if (rows.length > 1) {
        setInviteRows(rows.filter((row) => row.id !== id));
        return;
      }
      const el = inviteEls.current.get(id);
      if (el) el.value = '';
    },
    [setInviteRows],
  );

  const onSubmit = useCallback(
    async (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      const value = token.current;
      const typed = [...document.querySelectorAll<HTMLInputElement>('#more-invites [data-invite]')]
        .map((el) => el.value.trim())
        .filter(Boolean);
      setSaving(true);
      try {
        const res = await fetch('/api/public/waitlist/more/' + encodeURIComponent(value || ''), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            group_name: groupName.current?.value.trim() || undefined,
            group_size: groupSize.current?.value || undefined,
            group_role: groupRole.current?.value || undefined,
            group_tools: tools,
            group_need: groupNeed.current?.value.trim() || undefined,
            had_loss: lossHad || undefined,
            loss_product: lossProduct.current?.value.trim() || undefined,
            loss_kind: lossKinds,
            loss_story: lossStory.current?.value.trim() || undefined,
            farcaster: farcaster.current?.value.trim() || undefined,
            discord: discord.current?.value.trim() || undefined,
            telegram: telegram.current?.value.trim() || undefined,
            other_handle: other.current?.value.trim() || undefined,
            invites: typed,
            admit_together: !!admitTogether.current?.checked,
            referrer_handle: referrer.current?.value.trim() || undefined,
          }),
        });
        const data = await res.json().catch(() => null);
        if (res.ok) {
          setMsg({ text: (data && data.message) || 'Saved. Thanks.', tone: 'ok' });
        } else {
          setMsg({
            text: (data && data.error) || 'Something went wrong. Try again.',
            tone: 'error',
          });
        }
      } catch {
        setMsg({ text: 'Connection issue. Try again.', tone: 'error' });
      }
      setSaving(false);
    },
    [lossHad, lossKinds, tools],
  );

  const live = useRef({ moreOnShow });
  live.current = { moreOnShow };
  useAuthScreensPatch({
    _wireMore: () => {},
    _moreOnShow: (value?: string) => live.current.moreOnShow(value),
  });

  // A "no" (or nothing picked) hides the follow-up, exactly as the chip row's
  // onChange used to toggle it.
  const lossDetailHidden = !lossHad || lossHad === 'no';

  return (
    <main
      ref={rootRef}
      id="auth-more-screen"
      className="hidden fixed inset-0 z-40 overflow-y-auto platform-safe-scroll bg-white dark:bg-zinc-950"
    >
      <a
        href="#landing"
        className="fixed left-4 z-10 text-sm text-zinc-500 dark:text-zinc-400 hover:text-violet-400"
        style={{ top: 'calc(env(safe-area-inset-top, 0px) + 1rem)' }}
      >
        &larr; Back
      </a>
      <div className="max-w-2xl mx-auto px-6 py-16">
        <p className="text-xs font-semibold uppercase tracking-widest text-violet-700 dark:text-violet-400">
          Optional (moves you up the list)
        </p>
        <h1 className="mt-1 text-2xl font-bold">
          Want in sooner?
        </h1>
        <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">
          Four more questions, about three minutes. These are the answers we
        actually read when we pick the next group, so they&rsquo;re worth more
        than the order you signed up in. Every one is optional, and you can
        come back and add to this any time.
        </p>
        {/* Bad/expired token state — also hosts the rate-limited copy */}
        <div
          id="more-invalid"
          className={hiddenFirst(
            status !== 'invalid' && status !== 'throttled',
            'mt-6 rounded-lg border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 p-4 text-sm text-amber-800 dark:text-amber-300',
          )}
        >
          {status === 'throttled' ? (
            <>
              Your link is fine, we&rsquo;re limiting requests from your
              address right now. Try again in {retryText}, or just reopen the
              link from your waitlist email then.
            </>
          ) : (
            <>
              {"This link doesn't look right. Use the one from your waitlist email, or "}
              <a href="#landing" className="underline">
                join the waitlist
              </a>
              {' first.'}
            </>
          )}
        </div>
        <form
          id="more-form"
          className={hiddenFirst(status !== 'ready', 'mt-6 space-y-8')}
          onSubmit={onSubmit}
        >
          {/* 5 · The group */}
          <div>
            <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-200">
              Tell us about a group you&rsquo;re part of that could use its own app.
            </label>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5 mb-2">
              A team, a server, a club, a group chat, a co-op, a band, a league, a neighbourhood. Not a hypothetical one, a real group you&rsquo;re actually in.
            </p>
            <input
              ref={groupName}
              id="more-group-name"
              type="text"
              maxLength={255}
              placeholder="A 200-person Discord for indie game devs in Lagos"
              className="w-full rounded-lg bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent"
            />
            <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-2">
              <select
                ref={groupSize}
                id="more-group-size"
                className="w-full rounded-lg bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent"
              >
                <option value="">
                  Roughly how many people?
                </option>
                {optionList(opts?.group_sizes)}
              </select>
              <select
                ref={groupRole}
                id="more-group-role"
                className="w-full rounded-lg bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent"
              >
                <option value="">
                  Your role in it
                </option>
                {optionList(opts?.group_roles)}
              </select>
            </div>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-3 mb-1.5">
              What does it run on today? (pick any)
            </p>
            <MultiChipRow
              id="more-group-tools"
              options={opts?.group_tools || {}}
              value={tools}
              onToggle={toggleTool}
            />
            <textarea
              ref={groupNeed}
              id="more-group-need"
              rows={3}
              maxLength={800}
              placeholder="What would its own app do that those tools can't? Money, membership, voting, scheduling, reputation, records…"
              className="mt-3 w-full rounded-lg bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent"
            >
            </textarea>
          </div>
          {/* 6 · The loss */}
          <div>
            <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-200">
              Ever had a tool you relied on get killed, paywalled, or ruined?
            </label>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5 mb-2">
              An app, a platform, a service, a game, a community. The kind of thing that made you look for something like this in the first place.
            </p>
            <ChipRow
              id="more-loss-had"
              options={opts?.loss_answers || {}}
              value={lossHad}
              onChange={setLossHad}
            />
            <div
              id="more-loss-detail"
              className={hiddenFirst(lossDetailHidden, 'mt-3 space-y-2')}
            >
              <input
                ref={lossProduct}
                id="more-loss-product"
                type="text"
                maxLength={255}
                placeholder="Which one? Google Reader, a Discord server, a game's private servers, an API…"
                className="w-full rounded-lg bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent"
              />
              <p className="text-xs text-zinc-500 dark:text-zinc-400 pt-1">
                What happened? (pick any)
              </p>
              <MultiChipRow
                id="more-loss-kinds"
                options={opts?.loss_kinds || {}}
                value={lossKinds}
                onToggle={toggleLossKind}
              />
              <textarea
                ref={lossStory}
                id="more-loss-story"
                rows={3}
                maxLength={800}
                placeholder="What happened, and what did you do next? Where did everyone go? Did you move them somewhere? Rebuild it? Give up?"
                className="w-full rounded-lg bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent"
              >
              </textarea>
            </div>
          </div>
          {/* 7 · Handles */}
          <div>
            <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-200">
              Where else are you?
            </label>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5 mb-2">
              Connecting an account proves you&rsquo;re a person with a history, which is most of what gets a signup read quickly.
            </p>
            {/*
                GitHub / X: a verified pill when connected, a connect link when
                the platform has OAuth creds for the provider, nothing otherwise
                (the text handles below still work).
            */}
            <div id="more-connect-row" className="flex flex-wrap gap-2 mb-3">
              {[
                ['github', 'GitHub'],
                ['x', 'X'],
              ].map(([provider, label]) =>
                connect.verified[provider] ? (
                  <span
                    key={provider}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-300 dark:border-emerald-500/40 bg-emerald-50 dark:bg-emerald-500/10 px-3 py-1.5 text-xs font-medium text-emerald-700 dark:text-emerald-300"
                  >
                    {'✓ ' + label + ' · ' + connect.verified[provider]}
                  </span>
                ) : connect.oauth[provider] ? (
                  <a
                    key={provider}
                    className="inline-flex items-center rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-700 dark:text-zinc-200 hover:border-zinc-400 dark:hover:border-zinc-500"
                    href={
                      '/waitlist/connect/' +
                      provider +
                      '?token=' +
                      encodeURIComponent(token.current || '')
                    }
                  >
                    {'Connect ' + label}
                  </a>
                ) : null,
              )}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <input
                ref={farcaster}
                id="more-handle-farcaster"
                type="text"
                maxLength={255}
                placeholder="Farcaster (@handle)"
                className="w-full rounded-lg bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent"
              />
              <input
                ref={discord}
                id="more-handle-discord"
                type="text"
                maxLength={255}
                placeholder="Discord (username)"
                className="w-full rounded-lg bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent"
              />
              <input
                ref={telegram}
                id="more-handle-telegram"
                type="text"
                maxLength={255}
                placeholder="Telegram (@handle)"
                className="w-full rounded-lg bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent"
              />
              <input
                ref={other}
                id="more-handle-other"
                type="text"
                maxLength={255}
                placeholder="Anywhere else: Twitch, YouTube, Mastodon…"
                className="w-full rounded-lg bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent"
              />
            </div>
          </div>
          {/* 8 · Friends */}
          <div>
            <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-200">
              Would you join with friends?
            </label>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5 mb-2">
              A network is more fun with people you already know. Drop their handles or emails and we&rsquo;ll try to bring you in together.
            </p>
            <div id="more-invites" className="space-y-2">
              {invites.map((row) => (
                <div key={row.id} className="flex items-center gap-2">
                  <input
                    ref={(el) => {
                      inviteEls.current.set(row.id, el);
                    }}
                    type="text"
                    maxLength={255}
                    placeholder="@handle or email"
                    defaultValue={row.initial}
                    className="flex-1 rounded-lg bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent"
                    data-invite="1"
                  />
                  <button
                    type="button"
                    aria-label="Remove"
                    className="shrink-0 rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-sm text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-white"
                    onClick={() => removeInvite(row.id)}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
            <button
              type="button"
              id="more-invite-add"
              className="mt-2 text-sm font-medium text-violet-700 dark:text-violet-400 hover:underline"
              onClick={addInvite}
            >
              + Add another
            </button>
            <label className="mt-3 flex items-start gap-2 text-sm text-zinc-600 dark:text-zinc-300 cursor-pointer">
              <input
                ref={admitTogether}
                id="more-admit-together"
                type="checkbox"
                className="mt-0.5 size-4 shrink-0 rounded accent-violet-600"
              />
              Only let me in when at least one of them gets in too
            </label>
            <input
              ref={referrer}
              id="more-referrer"
              type="text"
              maxLength={255}
              placeholder="Did someone here refer you? Their handle (optional)"
              className="mt-3 w-full rounded-lg bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent"
            />
          </div>
          <div className="border-t border-zinc-200 dark:border-zinc-800 pt-5">
            <Button
              type="submit"
              id="more-save"
              disabled={saving}
              disabledStyle="dim"
              size="xl"
            >
              Save my answers
            </Button>
            <p id="more-msg" className={msgClass(msg ? msg.tone : null)}>
              {msg ? msg.text : null}
            </p>
            <p className="text-xs text-zinc-500 dark:text-zinc-500 mt-3">
              A blank answer just means we have less to go on, and nothing here is required.
            </p>
          </div>
        </form>
      </div>
    </main>
  );
}
