import { useState } from 'react';

import { CheckIcon } from '@/components/ui/icons';
import { IconTile } from '@/components/ui/icon-tile';

import * as api from './api';
import { afterYesWords, countOf, waitingWords } from './approval-words';
import { botMeta } from './bot-question';
import { scopeKey, setReply } from './store';
import type { ConversationMessage, HomeroomBotAction, HomeroomBotGoesLive, HomeroomBotMeta, HomeroomBotReady } from './types';

/*
 * B7: a change Homeroom bot built, ready to try, as a card in place of the
 * message's words (./message-row.tsx), which still say it for the inbox and
 * the push. Sent once its preview is up and its checks passed or were not
 * needed (services/homeroom-bot-dm.js noteChangeReady).
 *
 *   Try it            its preview, over the chat (AppView.ensureStaging);
 *   Approve           when the person's own Yes counts and is not in yet:
 *                     cast from THEIR browser, on the version the card was
 *                     sent for (api.approveChange). The bot never votes. On
 *                     a project of one person's it is the Yes that makes it
 *                     live;
 *   Change something  quotes the card in the composer, for the bot to
 *                     change it (its revise path).
 *
 * Under its title it says what the change is (changeLine): the change's own
 * title, else the request's, then what its person asked, if they did.
 *
 * A change its before & after shots showed part of failing, which the bot
 * could not fix in its own round, says what does not work instead of
 * calling itself ready (brokenLine).
 *
 * In a group the card says who else it waits on, and how many of them, when
 * fewer approvals are needed than the people it names (./approval-words.ts).
 * Once they approve, here or anywhere, the buttons give way to one line on
 * every device, which says what happens next (approvedLine): it goes live in
 * a minute or two, or when the others approve too, or after one more
 * approval from any of them, or on a day if nobody objects. A version that was
 * replaced since the card was sent approves nothing: the card says to try
 * the new version first, and Approve comes back once they have.
 */

export type ReadyCardState = 'open' | 'approved' | 'stale' | 'updated' | 'closed';

/** Whether a message is a change's ready card. */
export function isReadyMessage(message: ConversationMessage): boolean {
  const meta = botMeta(message);
  return !!meta && meta.kind === 'proposal' && !!meta.ready && !!meta.actions?.length && !message.deleted;
}

/**
 * "Plant Pal is ready to try", or in a group "Your change to Supper Club is
 * ready to try". A change part of which does not work is never called ready:
 * "Flat 4B Chores is built, but not everything works yet".
 */
export function readyTitle(meta: HomeroomBotMeta): string {
  const app = meta.appName || meta.appSlug || 'Your project';
  const who = meta.ready?.group && !meta.firstVersion ? `Your change to ${app}` : app;
  return meta.ready?.broken?.length ? `${who} is built, but not everything works yet` : `${who} is ready to try`;
}

/** Pure: words compared loosely, so a title that only repeats what they asked is said once. */
const same = (a: string, b: string) => a.trim().toLowerCase().replace(/[\s.!?]+$/, '') === b.trim().toLowerCase().replace(/[\s.!?]+$/, '');

/**
 * Pure (#3870): what the change is, under the title: its own title (the
 * proposal's), else the request it answers. Null when there is neither, or
 * when it only repeats what they asked ("You asked: …" says it already).
 */
export function changeLine(meta: HomeroomBotMeta): string | null {
  const what = (meta.changeTitle || meta.issueTitle || '').trim();
  if (!what) return null;
  if (meta.askedText && same(what, meta.askedText)) return null;
  return what;
}

/**
 * Pure: what does not work, in plain words: "One thing isn’t working yet:
 * Tapping ‘mark as done’ ticks it off". Null when everything it tried works.
 */
export function brokenLine(ready: HomeroomBotReady | undefined): string | null {
  const said = (ready?.broken || []).filter((item) => typeof item === 'string' && item.trim());
  if (!said.length) return null;
  return said.length === 1
    ? `One thing isn’t working yet: ${said[0]}`
    : `${said.length} things aren’t working yet: ${said.join('; ')}`;
}

/**
 * Pure: who it waits on, in a group: "Waiting for approval from you and
 * @ada" when it needs every one of them, "Needs 2 approvals from you, @priya
 * or @mo" when it needs fewer (./approval-words.ts waitingWords). Nothing on
 * a project of one, or when their Yes is the last needed.
 */
export function waitingLine(ready: HomeroomBotReady | undefined, canApprove: boolean): string | null {
  if (!ready?.group || ready.last) return null;
  return waitingWords({
    you: canApprove, names: ready.waitingOn, more: ready.more, missing: ready.missing, needed: ready.needed,
  });
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Pure: the day a change goes live if nobody objects, in the reader's own
 * clock, worded to follow "It goes live": "later today", "tomorrow", "on
 * Wednesday" within the week, else "on October 12". A day already past
 * (an old card, read later) is its date.
 */
export function liveDay(at: string, now: Date = new Date(Date.now()), locale?: string): string | null {
  const when = new Date(at);
  if (Number.isNaN(when.getTime())) return null;
  const midnight = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  // Rounded: a day across a clock change is 23 or 25 hours long.
  const days = Math.round((midnight(when) - midnight(now)) / DAY_MS);
  if (when.getTime() > now.getTime()) {
    if (days === 0) return 'later today';
    if (days === 1) return 'tomorrow';
    if (days < 7) return `on ${new Intl.DateTimeFormat(locale, { weekday: 'long' }).format(when)}`;
  }
  return `on ${new Intl.DateTimeFormat(locale, { month: 'long', day: 'numeric' }).format(when)}`;
}

/**
 * Pure: whose Yes it still needs, worded to follow "It goes live": "when
 * @ada approves too" when that is everybody it names, "after one more
 * approval from @priya or @mo" when any of them will do.
 */
function whoElse({ missing, waitingOn, more }: HomeroomBotGoesLive): string {
  return afterYesWords({ missing, names: waitingOn, more });
}

/**
 * Pure: what a card says once its person approved the change, from what
 * happens next (services/homeroom-bot-dm.js goesLiveAfterYes): "You approved
 * it. It goes live in a minute or two." when theirs was the last Yes needed;
 * "You approved it. It goes live when @ada approves too, or on Wednesday if
 * nobody objects." while it waits on others and its lazy-consensus clock
 * runs; "You approved it. It goes live after one more approval from @priya
 * or @mo, or on Wednesday if nobody objects." when either will do.
 */
export function approvedLine(next: HomeroomBotGoesLive, now: Date = new Date(Date.now()), locale?: string): string {
  if (next.soon) return 'You approved it. It goes live in a minute or two.';
  const day = next.at ? liveDay(next.at, now, locale) : null;
  if (!next.missing) {
    return day ? `You approved it. It goes live ${day} if nobody objects.` : 'You approved it. It goes live once it has the approvals it needs.';
  }
  const who = whoElse(next);
  return day ? `You approved it. It goes live ${who}, or ${day} if nobody objects.` : `You approved it. It goes live ${who}.`;
}

/**
 * Pure: what happens next when nothing newer says, from what the card was
 * sent with: an older card approved before cards said it, or a Yes whose
 * next step could not be read. No day: only the server knows its clock.
 */
export function goesLiveFromReady(ready: HomeroomBotReady | undefined): HomeroomBotGoesLive {
  if (!ready || ready.last || !ready.group) return { soon: true, at: null, missing: 0, waitingOn: [], more: 0 };
  // One fewer than the card was sent needing, theirs being in; a card sent
  // before cards said how many reads as everybody it names.
  const sent = countOf(ready.missing);
  const missing = sent !== null ? Math.max(sent - 1, 1) : Math.max(ready.waitingOn.length + ready.more, 1);
  return { soon: false, at: null, missing, waitingOn: ready.waitingOn, more: ready.more };
}

/** What the line under a card that is not open says. `goesLive`: what happens next, once it is approved. */
export function readyLine(
  state: ReadyCardState, goesLive: HomeroomBotGoesLive | null = null, now: Date = new Date(Date.now()), locale?: string,
): string | null {
  if (state === 'approved') return goesLive ? approvedLine(goesLive, now, locale) : 'You approved it.';
  if (state === 'stale') return 'This change was updated. Try the new version first.';
  if (state === 'updated') return 'This change was updated. Its newer version is below.';
  if (state === 'closed') return 'No longer needed.';
  return null;
}

export interface ReadyCardViewProps {
  meta: HomeroomBotMeta;
  state: ReadyCardState;
  /** The buttons to show: all of them when open; Try it alone when stale. */
  actions: HomeroomBotAction[];
  error?: string | null;
  busy?: boolean;
  onPress?: (action: HomeroomBotAction) => void;
  /** What happens next, from the Yes just cast here, until the message's own update says it. */
  goesLive?: HomeroomBotGoesLive | null;
  /** For a test: the moment and the locale the day it goes live is worded in. */
  now?: Date;
  locale?: string;
}

/** One card, from its message and its state: pure, so a test can draw every state. */
export function ReadyCardView({
  meta, state, actions, error = null, busy = false, onPress, goesLive = null, now, locale,
}: ReadyCardViewProps) {
  const canApprove = actions.some((action) => action.type === 'vote');
  const waiting = state === 'open' ? waitingLine(meta.ready, canApprove) : null;
  const next = meta.goesLive || goesLive || goesLiveFromReady(meta.ready);
  const broken = state === 'open' ? brokenLine(meta.ready) : null;
  const what = changeLine(meta);
  const line = readyLine(state, next, now || new Date(Date.now()), locale);
  return (
    <div
      className="mt-1 flex max-w-[480px] flex-col gap-2.5 rounded-2xl bg-[color:var(--messages-surface)] px-3 py-2.5"
      role="group"
      aria-label={readyTitle(meta)}
      data-bot-ready={state}
    >
      <div className="flex items-center gap-3">
        <IconTile size="xs" className="h-[38px] w-[38px] rounded-full bg-[color:var(--brand-tint)] text-[color:var(--brand-ink)] dark:bg-[color:var(--brand-tint)] dark:text-[color:var(--brand-ink)]">
          <CheckIcon aria-hidden="true" />
        </IconTile>
        <div className="min-w-0 flex-1">
          <div className="text-[0.9375rem] font-semibold text-zinc-900 dark:text-zinc-100" data-bot-ready-title="">{readyTitle(meta)}</div>
          {what ? <p className="line-clamp-2 text-[0.8125rem] leading-[1.125rem] text-zinc-500 dark:text-zinc-400" data-bot-ready-change="">{what}</p> : null}
          {meta.askedText ? <p className="line-clamp-2 text-[0.8125rem] leading-[1.125rem] text-zinc-500 dark:text-zinc-400">{`You asked: ${meta.askedText}`}</p> : null}
          {broken ? <p className="text-[0.8125rem] leading-[1.125rem] text-red-700 dark:text-red-400" data-bot-ready-broken="">{broken}</p> : null}
          {waiting ? <p className="text-[0.8125rem] leading-[1.125rem] text-zinc-500 dark:text-zinc-400" data-bot-ready-waiting="">{waiting}</p> : null}
        </div>
      </div>
      {line ? <p className="messages-bot-answered" role="status">{line}</p> : null}
      {actions.length ? (
        <div className="messages-bot-answers" role="group" aria-label="Choices">
          {actions.map((action) => (
            <button
              key={action.id}
              type="button"
              disabled={busy}
              className={action.style === 'primary' || actions.length === 1 ? 'messages-bot-primary' : 'messages-bot-secondary'}
              data-bot-ready-action={action.id}
              onClick={() => onPress?.(action)}
            >
              <span>{action.label}</span>
            </button>
          ))}
        </div>
      ) : null}
      {error ? <p className="text-sm text-red-700 dark:text-red-400" role="alert">{error}</p> : null}
    </div>
  );
}

/** Open a change's preview over the chat, or its page when there is no preview overlay to open. */
function tryChange(meta: HomeroomBotMeta, sessionId: number) {
  const view = typeof window !== 'undefined' ? window.AppView : null;
  if (meta.appSlug && view && typeof view.ensureStaging === 'function') {
    void view.ensureStaging(sessionId, null, null, { readOnly: false, app: { slug: meta.appSlug } });
    return;
  }
  if (meta.appSlug) window.location.hash = `#app/${encodeURIComponent(meta.appSlug)}/dev/proposals/${sessionId}`;
}

export function BotReadyCard({ message, conversationId }: { message: ConversationMessage; conversationId: number }) {
  const meta = botMeta(message);
  // What happened here, until the message's own update says it everywhere:
  // the Yes, and what the vote said happens next.
  const [approved, setApproved] = useState(false);
  const [goesLive, setGoesLive] = useState<HomeroomBotGoesLive | null>(null);
  const [stale, setStale] = useState<{ epoch: number | null; tried: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!meta?.ready) return null;
  const all = meta.actions || [];

  let state: ReadyCardState = 'open';
  if (approved || (meta.status === 'answered' && meta.chosen === 'approve')) state = 'approved';
  else if (meta.status === 'closed') state = meta.updated ? 'updated' : 'closed';
  else if (stale) state = 'stale';
  // Stale: Try it, and Approve back (on the version it is at now) once tried.
  const actions = state === 'open' ? all
    : state === 'stale' ? all.filter((action) => action.type === 'preview' || (stale?.tried && action.type === 'vote'))
      : [];

  async function press(action: HomeroomBotAction) {
    if (!meta) return;
    setError(null);
    if (action.type === 'preview' && action.sessionId) {
      tryChange(meta, action.sessionId);
      if (stale) setStale({ ...stale, tried: true });
      return;
    }
    if (action.type === 'reply') {
      setReply(scopeKey(conversationId, null), message);
      window.requestAnimationFrame(() => {
        document.querySelector<HTMLTextAreaElement>('.messages-composer-input')?.focus({ preventScroll: true });
      });
      return;
    }
    if (action.type === 'vote' && action.sessionId) {
      setBusy(true);
      const epoch = stale ? stale.epoch : (action.epoch ?? null);
      const out = await api.approveChange(action.sessionId, epoch);
      setBusy(false);
      if (out.ok) { setGoesLive(out.goesLive || null); setApproved(true); setStale(null); return; }
      if (out.stale) { setStale({ epoch: out.epoch, tried: false }); return; }
      setError(out.error);
    }
  }

  return (
    <ReadyCardView
      meta={meta} state={state} actions={actions} error={error} busy={busy} goesLive={goesLive}
      onPress={(action) => { void press(action); }}
    />
  );
}
