/**
 * Right after "Make it" (./make.tsx): something to give, and one thing to
 * do with it.
 *
 *   what      The project, being built: its tile and name, Homeroom bot's
 *             step from GET /api/apps/:slug (`app.first_version`, "Step 2 of
 *             7: Read the description"), read again every ten seconds,
 *             past the service worker's cache (madeAppOf, madeAppUrl).
 *   plan      B6: once the bot has read the description it waits for its
 *             plan's Build it (`first_version.plan`) and builds nothing
 *             until then. The plan is drawn first, under "Needs you", as
 *             the same card as in the chat and on the App tab: Build it is
 *             decided here through the chat's own call, and Change
 *             something leaves for the chat with the plan quoted
 *             (./index.tsx). A plan built from here stays, chosen.
 *   invite    "Invite people to <name>": Share invite opens a short sheet
 *             (InviteSheet below). Once something has gone out, the line
 *             says so and "Invite people later" becomes "Go to the
 *             Homeroom app". Either starts the tour (./index.tsx). While
 *             it is out, the project's community is read again, and the
 *             line says who has joined (joinedLine), and to whom an invite
 *             by username went (sentLines).
 *
 * The sheet is the first invite, not the project's full invite pane
 * (features/app-context/invite-pane.tsx, with live links and their limits,
 * which stays where it is): what they'll get, with the note edited in place,
 * then Share link; a username sits behind one button. The link it makes
 * works until it is turned off, for anyone it reaches (WP-D) — the project
 * is the gift, so the link should outlive a week. Under it, one line on what
 * joining means, from the project's real rule and the people in it (GET
 * .../invite-links `joiningRule`), read again once an invite by username has
 * gone, so it counts them. The first note shared is also
 * the maker's first message in the group's chat (the sheet says so), so the
 * people it brings find it waiting there.
 *
 * First-session run-through, 5 October 2026 (Page Turners): an invite by
 * username closed the sheet with nothing said (the line under it said who
 * had joined, not that it went), and the note was back to the default the
 * next time the sheet opened. Now Send keeps the sheet up and says where it
 * went (sentLine), or in plain words why not (inviteError); the invite
 * carries the note, as a link does, for the invite the person accepts
 * (features/notifications); and the note is kept per project on this device
 * (noteKey), else read back from the maker's own newest link.
 *
 *   sketch    A sketch of its main screen (services/app-sketch.js), drawn
 *             from the description in about half a minute: "Sketching…" from
 *             GET /api/apps/:slug/sketch, read every two seconds, then the
 *             page itself in a frame with an empty `sandbox` (no script, its
 *             own origin). Without one (no description, no model, a reply
 *             that was not usable) the card shows the build as before.
 *
 * Every line says what is true for this project: when Homeroom bot builds
 * it (`made.conversationId`, its DM), its step and "messages you"; when it
 * does not, the description is the project's first request, for whoever
 * builds it.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { XIcon } from '@/components/ui/icons';
import { Wordmark } from '@/components/ui/wordmark';

import { askForPingWhileBotBuilds } from '../dialogs/ping-ask';
import { decideBotAction, MessagesApiError } from '../messages/api';
import { PlanCardView } from '../messages/bot-plan-view';
import type { HomeroomBotPlanQuestion } from '../messages/types';

import type { Made } from './make';

/** B6: the plan Homeroom bot waits on before it builds anything. */
export type WaitingPlan = {
  bullets: string[];
  questions: HomeroomBotPlanQuestion[];
  actionId: number;
  messageId: number | null;
  conversationId: number | null;
};

type FirstVersion = {
  step?: number; of?: number; stepName?: string | null; ready?: boolean;
  /** WP-E: about how many minutes a build takes, while this one is not ready. */
  typicalMinutes?: number;
  /** B6: the plan waiting for Build it, for its creator (GET /api/apps/:slug). */
  plan?: Partial<WaitingPlan> | null;
} | null;

/**
 * The project's record as GET /api/apps/:slug answers it, which is `{ app }`:
 * its first version (null while the bot builds nothing) and its status. Null
 * for an answer without a record. Page Turners, 5 October 2026: the made
 * screen read `first_version` off the answer itself, never found one, and
 * so never drew the plan its maker waited 18 minutes on.
 */
export function madeAppOf(body: unknown): { firstVersion: FirstVersion; status: string | null } | null {
  const app = body && typeof body === 'object' ? (body as { app?: unknown }).app : null;
  if (!app || typeof app !== 'object') return null;
  const { first_version: firstVersion, status } = app as { first_version?: FirstVersion; status?: unknown };
  return { firstVersion: firstVersion || null, status: typeof status === 'string' ? status : null };
}

/**
 * The made screen's read of the project, every ten seconds. Tagged and
 * no-store, as the App tab's recheck is (AppView._recheckFirstVersion): the
 * service worker answers a plain GET /api/apps/:slug from its boot cache
 * first, and a poll is asking what is true now.
 */
export function madeAppUrl(slug: string): string {
  return `/api/apps/${encodeURIComponent(slug)}?status_recheck=1&manifest=summary`;
}

/**
 * The plan waiting for Build it, or null: read the way the App tab's
 * being-built screen reads it (AppView._firstVersionView), so the two agree
 * on when there is one.
 */
export function waitingPlan(fv: FirstVersion): WaitingPlan | null {
  const plan = fv && !fv.ready ? fv.plan : null;
  if (!plan || !Array.isArray(plan.bullets) || !plan.bullets.length || !Number.isInteger(plan.actionId)) return null;
  return {
    bullets: plan.bullets,
    questions: Array.isArray(plan.questions) ? plan.questions : [],
    actionId: Number(plan.actionId),
    messageId: Number.isInteger(plan.messageId) ? Number(plan.messageId) : null,
    conversationId: Number.isInteger(plan.conversationId) ? Number(plan.conversationId) : null,
  };
}

/** Over the plan: it is the one thing on the screen that waits on them. */
export const PLAN_LABEL = 'Needs you';

/** Under the plan, until Build it is tapped. */
export function planNote(name: string): string {
  return `Homeroom bot starts building ${name} when you tap Build it.`;
}

/** "Step 2 of 7: Read the description", or what to say without a build. */
export function buildLine(fv: FirstVersion, appStatus: string | null, botBuilds = true): string {
  if (fv && fv.ready) return 'Version one is ready to try.';
  if (fv && fv.step && fv.of) return `Step ${fv.step} of ${fv.of}${fv.stepName ? `: ${fv.stepName}` : ''}`;
  if (appStatus === 'creating') return 'Setting it up…';
  return botBuilds ? 'Homeroom bot builds it from your description.' : 'Your description is its first request.';
}

/**
 * The line under the build's: who tells them, or who builds it. WP-E: and,
 * while it is building, about how long that usually takes. B6: while its
 * plan waits, that nothing happens until they say so.
 */
export function buildNote(botBuilds: boolean, minutes: number | null = null, planWaits = false): string {
  if (!botBuilds) return 'You or anyone you invite can build it from there.';
  if (planWaits) return 'Homeroom bot is waiting for your go-ahead.';
  return minutes && minutes > 0
    ? `Homeroom bot messages you when it's ready to try, usually in about ${minutes} minutes.`
    : 'Homeroom bot messages you when it\'s ready to try.';
}

export type SketchState = 'loading' | 'none' | 'pending' | 'ready' | 'failed';

/** Under the sketch: what it is, and what happens to it. */
export function sketchCaption(name: string, botBuilds: boolean): string {
  return botBuilds
    ? `A sketch from your description. Homeroom bot builds the real ${name} from it.`
    : `A sketch from your description. Nothing on it works yet: the real ${name} is built from it, by you or anyone you invite.`;
}

// Stop asking after this long: a sketch is drawn in well under a minute.
const SKETCH_POLL_MS = 2000;
const SKETCH_GIVE_UP_MS = 90 * 1000;

/** The shell's look, so the sketch is drawn in the same one. */
function useDarkClass(): boolean {
  const read = () => typeof document !== 'undefined' && document.documentElement.classList.contains('dark');
  const [dark, setDark] = useState(read);
  useEffect(() => {
    const observer = new MutationObserver(() => setDark(read()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);
  return dark;
}

/** GET /api/apps/:slug/sketch until it is ready, failed, or there is none. */
function useSketch(slug: string): SketchState {
  const [state, setState] = useState<SketchState>('loading');
  useEffect(() => {
    let live = true;
    let timer = 0;
    const started = Date.now();
    const read = async () => {
      const data = await fetch(`/api/apps/${encodeURIComponent(slug)}/sketch`, { credentials: 'same-origin' })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
      if (!live) return;
      const status = data?.status;
      if (status === 'ready' || status === 'failed' || status === 'none') { setState(status); return; }
      // A read that failed is asked again; the card shows the build meanwhile.
      if (status === 'pending') setState('pending');
      if (Date.now() - started > SKETCH_GIVE_UP_MS) { setState((s) => (s === 'pending' ? 'failed' : s)); return; }
      timer = window.setTimeout(() => { void read(); }, SKETCH_POLL_MS);
    };
    void read();
    return () => { live = false; window.clearTimeout(timer); };
  }, [slug]);
  return state;
}

function SketchCard({ made, tile, sketch, line, botBuilds, busy, minutes, planWaits }: {
  made: Made;
  tile: string;
  sketch: 'pending' | 'ready';
  line: string;
  botBuilds: boolean;
  busy: boolean;
  minutes: number | null;
  planWaits: boolean;
}) {
  const dark = useDarkClass();
  return (
    <div data-first-session-sketch={sketch} className="mt-4 rounded-[20px] bg-white p-3 shadow-[inset_0_0_0_1px_var(--app-sheet-line)] dark:bg-zinc-900">
      <div className="flex items-center gap-3 px-1 pb-3">
        <span className="app-icon-tile flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-2xl" aria-hidden="true">{tile}</span>
        <div className="min-w-0 flex-1">
          <h1 id="first-session-made-title" className="truncate text-[17px] font-semibold leading-snug">{made.name}</h1>
          <p className="flex items-center gap-1.5 text-[13px] text-zinc-500 dark:text-zinc-400">
            {busy ? <span className="status-dot creating" aria-hidden="true" /> : null}
            <span data-first-session-build="" className="truncate">{line}</span>
          </p>
        </div>
      </div>
      <div className="relative h-[380px] overflow-hidden rounded-[14px] bg-zinc-100 shadow-[inset_0_0_0_1px_var(--app-sheet-line)] dark:bg-zinc-800">
        {sketch === 'ready' ? (
          <iframe
            title={`A sketch of ${made.name}`}
            src={`/api/apps/${encodeURIComponent(made.slug)}/sketch.html?theme=${dark ? 'dark' : 'light'}`}
            sandbox=""
            referrerPolicy="no-referrer"
            className="h-full w-full border-0"
          />
        ) : (
          <div role="status" className="flex h-full flex-col gap-4 p-5">
            <p className="pr-16 text-[14px] text-zinc-500 dark:text-zinc-400">{`Sketching ${made.name} from your description…`}</p>
            <div className="h-6 w-2/3 animate-pulse rounded-md bg-zinc-200 dark:bg-zinc-700" />
            <div className="h-20 animate-pulse rounded-xl bg-zinc-200 dark:bg-zinc-700" />
            <div className="h-11 w-1/2 animate-pulse rounded-lg bg-zinc-200 dark:bg-zinc-700" />
            <div className="h-24 animate-pulse rounded-xl bg-zinc-200 dark:bg-zinc-700" />
          </div>
        )}
        <span className="pointer-events-none absolute right-2 top-2 rounded-full bg-black/60 px-2 py-0.5 text-[12px] font-semibold text-white">Sketch</span>
      </div>
      <p className="px-1 pt-2.5 text-[13px] leading-snug text-zinc-500 dark:text-zinc-400">
        {sketch === 'ready' ? sketchCaption(made.name, botBuilds) : buildNote(botBuilds, minutes, planWaits)}
      </p>
    </div>
  );
}

const NOTE_DEFAULT = 'Come try it with me!';
// WP-D: the link works until it is turned off, for anyone it is sent to (0 is
// no limit, services/community-invites.js NO_LIMIT): the project is the gift.
const LINK_DAYS = 0;
const LINK_USES = 0;

/** The note, posted once per project as the maker's first chat message. */
const postedKey = (slug: string) => `usernode:first-session:note-posted:${slug}`;

/** The maker's last note for a project, kept on this device. */
export const noteKey = (slug: string) => `usernode:first-session:note:${slug}`;

/** The note they last wrote for `slug`, or null when there is none kept. */
export function keptNote(slug: string): string | null {
  try { return localStorage.getItem(noteKey(slug)); } catch { return null; }
}

function keepNote(slug: string, note: string): void {
  try { localStorage.setItem(noteKey(slug), note); } catch { /* kept for this sheet only */ }
}

/** The note the sheet opens with: the one kept, else the example's, else the default. */
export function openingNote(slug: string, example: string | null | undefined): string {
  const kept = keptNote(slug);
  return kept !== null ? kept : (example || NOTE_DEFAULT);
}

/** The newest note on the maker's own live links (GET .../invite-links `links`), or null. */
export function linkNote(links: unknown): string | null {
  if (!Array.isArray(links)) return null;
  const mine = links.find((l) => l && typeof l === 'object' && (l as { mine?: boolean }).mine
    && typeof (l as { note?: unknown }).note === 'string' && (l as { note: string }).note);
  return mine ? (mine as { note: string }).note : null;
}

/** After Send: where the invite went, and where they will find it. */
export function sentLine(handle: string): string {
  return `Invite sent to @${handle}. They'll find it in their notifications.`;
}

/** Why an invite by username did not go, in the sheet's words (routes/collaborators.js `code`). */
export function inviteError(code: string | null | undefined, handle: string, name: string, fallback?: string | null): string {
  if (code === 'unknown_user') return `No one on Homeroom is called @${handle}. Check the spelling and try again.`;
  if (code === 'already_member') return `@${handle} is already in ${name}.`;
  if (code === 'already_invited') return `@${handle} already has an invite to ${name}.`;
  if (code === 'self') return `That's you. You're already in ${name}.`;
  return fallback || 'Could not send the invite. Try again.';
}

export function InviteSheet({ made, me, onClose, onSent }: {
  made: Made;
  me: string;
  onClose: () => void;
  /** Something went out: `to` is the username, and `close` whether the sheet goes. */
  onSent: (to: string | null, close: boolean) => void;
}) {
  const [note, setNote] = useState(() => openingNote(made.slug, made.example?.note));
  const [byName, setByName] = useState(false);
  const [username, setUsername] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState(false);
  const [rule, setRule] = useState<string | null>(null);
  const linkRef = useRef<string | null>(null);
  // Whether the note in the box is theirs from this device (kept, or typed
  // here); until it is, a note on one of their own links replaces it.
  const ownNote = useRef(keptNote(made.slug) !== null);
  useEffect(() => { const r = requestAnimationFrame(() => setShown(true)); return () => cancelAnimationFrame(r); }, []);
  // WP-D: what joining means here, said from the project's real rule and
  // the people in it; read again after an invite by username, which counts.
  const readRule = useCallback((first: boolean) => fetch(`/api/apps/${encodeURIComponent(made.slug)}/invite-links`, { credentials: 'same-origin' })
    .then((r) => (r.ok ? r.json() : null))
    .then((data) => {
      if (typeof data?.joiningRule === 'string') setRule(data.joiningRule);
      const fromLink = first && !ownNote.current ? linkNote(data?.links) : null;
      if (fromLink) setNote(fromLink);
    })
    .catch(() => {}), [made.slug]);
  useEffect(() => { void readRule(true); }, [readRule]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // The maker's note, as their first message in the group's chat, once.
  const postNote = useCallback(async () => {
    const text = note.trim();
    if (!text) return;
    try { if (localStorage.getItem(postedKey(made.slug))) return; } catch { /* post it */ }
    const res = await fetch(`/api/apps/${encodeURIComponent(made.slug)}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ content: text }),
    }).catch(() => null);
    if (res && res.ok) { try { localStorage.setItem(postedKey(made.slug), '1'); } catch { /* once is best effort */ } }
  }, [note, made.slug]);

  const link = useCallback(async (): Promise<string | null> => {
    if (linkRef.current) return linkRef.current;
    const res = await fetch(`/api/apps/${encodeURIComponent(made.slug)}/invite-links`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ days: LINK_DAYS, maxUses: LINK_USES, note: note.trim() || null }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.link) { setError(data.error || 'Could not make a link. Try again.'); return null; }
    linkRef.current = `${location.origin}${data.link.path}`;
    return linkRef.current;
  }, [made.slug, note]);

  const shareLink = useCallback(async () => {
    if (busy) return;
    setBusy(true); setError(null); setStatus(null);
    try {
      const url = await link();
      if (!url) return;
      const title = `${me ? `${me} made` : 'Made'} ${made.name}`;
      const nav = navigator as Navigator & { share?: (d: ShareData) => Promise<void> };
      let shared = false;
      if (typeof nav.share === 'function') {
        try { await nav.share({ title, text: note.trim() || undefined, url }); shared = true; } catch (err) {
          if ((err as Error)?.name === 'AbortError') return;
        }
      }
      if (!shared) {
        await navigator.clipboard.writeText(note.trim() ? `${note.trim()} ${url}` : url);
        setStatus('Link copied. Paste it in your group chat.');
      }
      keepNote(made.slug, note);
      await postNote();
      onSent(null, true);
    } catch {
      setError('Could not share the link. Try again.');
    } finally {
      setBusy(false);
    }
  }, [busy, link, me, made.name, note, postNote, onSent]);

  // An invite by username carries the note, and the sheet stays up to say
  // where it went: another can follow, and the rule line counts it.
  const sendToUsername = useCallback(async () => {
    const handle = username.trim().replace(/^@/, '');
    if (!handle || busy) return;
    setBusy(true); setError(null); setStatus(null);
    try {
      const res = await fetch(`/api/apps/${encodeURIComponent(made.slug)}/invites`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ username: handle, note: note.trim() || null }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setError(inviteError(data.code, data.username || handle, made.name, data.error)); return; }
      const sentTo = typeof data.username === 'string' && data.username ? data.username : handle;
      keepNote(made.slug, note);
      await postNote();
      setUsername('');
      setStatus(sentLine(sentTo));
      onSent(`@${sentTo}`, false);
      void readRule(false);
    } catch {
      setError('Could not send the invite. Try again.');
    } finally {
      setBusy(false);
    }
  }, [username, busy, made.slug, made.name, note, postNote, onSent, readRule]);

  const tile = made.emoji || made.name.slice(0, 1);
  return (
    <div className="fixed inset-0 z-[9001]" data-first-session-invite="">
      <div aria-hidden="true" onClick={onClose} className={`absolute inset-0 bg-black/40 transition-opacity duration-200 ${shown ? 'opacity-100' : 'opacity-0'}`} />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="first-session-invite-title"
        className={`absolute inset-x-0 bottom-0 max-h-[92%] overflow-y-auto rounded-t-[20px] bg-zinc-100 px-4 pt-2 pb-[max(2rem,env(safe-area-inset-bottom))] transition-transform duration-200 ease-out dark:bg-zinc-900 md:inset-x-auto md:bottom-auto md:left-1/2 md:top-1/2 md:w-full md:max-w-md md:rounded-[20px] md:pb-6 ${shown ? 'translate-y-0 md:-translate-x-1/2 md:-translate-y-1/2' : 'translate-y-full md:-translate-x-1/2 md:-translate-y-1/2'}`}
      >
        <div className="mx-auto h-1.5 w-10 rounded-full bg-zinc-300 dark:bg-zinc-700 md:hidden" aria-hidden="true" />
        <div className="mt-3 flex items-center gap-3">
          <h2 id="first-session-invite-title" className="min-w-0 flex-1 text-[17px] font-semibold">{`Invite people to ${made.name}`}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-zinc-200 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
            <XIcon className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
        <p className="mt-4 pb-1.5 text-[13px] text-zinc-500 dark:text-zinc-400">What they'll get</p>
        <div className="overflow-hidden rounded-2xl bg-white dark:bg-zinc-800">
          <div className="flex items-center gap-3 p-3">
            <span className="app-icon-tile flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-2xl" aria-hidden="true">{tile}</span>
            <div className="min-w-0">
              <p className="text-[15px] font-semibold leading-snug">{`${me ? `${me} made` : 'Made'} ${made.name}`}</p>
              <p className="text-[13px] text-zinc-500 dark:text-zinc-400">A link to see it and join the chat</p>
            </div>
          </div>
          <div className="px-3 pb-2 pt-2.5 shadow-[inset_0_1px_0_var(--app-sheet-line)]">
            <label htmlFor="first-session-note" className="sr-only">Your note</label>
            <textarea
              id="first-session-note"
              rows={2}
              maxLength={280}
              value={note}
              onChange={(e) => { ownNote.current = true; setNote(e.target.value); keepNote(made.slug, e.target.value); }}
              placeholder="Add a note (optional)"
              className="w-full resize-none border-0 bg-transparent p-0 text-[16px] leading-snug placeholder-zinc-500 focus:outline-none"
            />
          </div>
        </div>
        <p className="mt-2 text-[13px] text-zinc-500 dark:text-zinc-400">Your note is also your first message in the group chat.</p>
        <div className="mt-4 flex flex-col gap-2.5">
          <Button type="button" onClick={() => { void shareLink(); }} disabled={busy} layout="full" variant="pillAccent" size="pillLg" ink="solidLate" className="flex items-center justify-center disabled:opacity-60">
            Share link
          </Button>
          {byName ? (
            <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void sendToUsername(); }}>
              <input
                autoFocus
                value={username}
                onChange={(e) => { setUsername(e.target.value); setError(null); }}
                placeholder="@username"
                aria-label="Their username"
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? 'first-session-invite-error' : undefined}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                className="h-11 min-w-0 flex-1 rounded-full border-0 bg-white px-4 text-[16px] placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-violet-500 dark:bg-zinc-800"
              />
              {/* The username keeps focus through the press (lib/keyboard-open.ts). */}
              <Button type="submit" disabled={busy || !username.trim()} variant="pillAccent" size="pill" ink="solid" className="disabled:opacity-60" onMouseDown={(event) => event.preventDefault()}>Send</Button>
            </form>
          ) : (
            <button type="button" onClick={() => setByName(true)} className="flex h-11 w-full items-center justify-center rounded-full bg-white text-[16px] font-semibold text-zinc-900 shadow-sm hover:bg-zinc-50 dark:bg-zinc-800 dark:text-zinc-100 dark:hover:bg-zinc-700">
              Invite by username
            </button>
          )}
        </div>
        {status ? <p role="status" data-first-session-invite-status="" className="mt-3 text-center text-[14px] text-emerald-700 dark:text-emerald-400">{status}</p> : null}
        {error ? <p id="first-session-invite-error" role="alert" className="mt-3 text-center text-[14px] text-red-600 dark:text-red-400">{error}</p> : null}
        <p className="mt-3 text-center text-[13px] text-zinc-500 dark:text-zinc-400">Anyone with the link can join, until you turn it off.</p>
        {rule ? <p data-first-session-rule="" className="mt-1 text-center text-[13px] text-zinc-500 dark:text-zinc-400">{rule}</p> : null}
      </div>
    </div>
  );
}

/**
 * B6: the plan, waiting for Build it, the same card as in the chat with
 * Homeroom bot and on the App tab. Build it is decided once on the server,
 * through the chat's own call (api.decideBotAction); Change something is
 * the screen's owner's (./index.tsx: the chat, with the plan quoted).
 */
export function PlanSection({ name, plan, onBuilt, onGone, onChange }: {
  name: string;
  plan: WaitingPlan;
  /** Built from here, with the answer each choice went with. */
  onBuilt: (plan: WaitingPlan, choices: string[]) => void;
  /** Decided somewhere else already, or replaced: read the project again. */
  onGone: () => void;
  onChange: () => void;
}) {
  const [pressed, setPressed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const build = useCallback(async (answers: Array<string | null>) => {
    if (pressed) return;
    setPressed(true);
    setError(null);
    try {
      await decideBotAction(plan.actionId, 'build', answers.map((a) => a || ''));
    } catch (err) {
      if (err instanceof MessagesApiError && err.status === 409) { onGone(); return; }
      setPressed(false);
      setError('Couldn\'t start building just now. Try again.');
      return;
    }
    onBuilt(plan, plan.questions.map((q, i) => answers[i] || q.answers[0] || ''));
  }, [pressed, plan, onBuilt, onGone]);
  return (
    <section data-first-session-plan="open" aria-labelledby="first-session-plan-label" className="mt-4">
      <p id="first-session-plan-label" className="px-1 pb-1.5 text-[12px] font-bold uppercase tracking-[0.06em] text-zinc-500 dark:text-zinc-400">{PLAN_LABEL}</p>
      <PlanCardView
        surface="app"
        appName={name}
        plan={{ bullets: plan.bullets, questions: plan.questions }}
        state="open"
        busy={pressed}
        onBuild={(answers) => { void build(answers); }}
        onChange={onChange}
      />
      {pressed ? null : <p className="px-1 pt-2 text-[13px] leading-snug text-zinc-500 dark:text-zinc-400">{planNote(name)}</p>}
      {error ? <p role="alert" className="px-1 pt-1 text-[13px] text-red-600 dark:text-red-400">{error}</p> : null}
    </section>
  );
}

type CommunityMember = { username?: string; display_name?: string | null; source?: string };
type Community = { member_count?: number; members?: CommunityMember[] } | null;

/**
 * The made screen's lines once an invite is out: who has joined (joinedLine),
 * and the invite by username last sent, which stays said beside it. Before
 * anyone joins, "✓ Invite sent", to whom when it went by username.
 */
export function sentLines(joined: string | null, sentTo: string | null): string[] {
  const sent = `✓ Invite sent${sentTo ? ` to ${sentTo}` : ''}.`;
  if (!joined) return [sent];
  return sentTo ? [joined, sent] : [joined];
}

/**
 * Who has joined since the invite went out, from GET /api/apps/:slug/community
 * (`members` is the newest few, the maker first as 'creator'; `member_count`
 * is everyone): "✓ Sam joined.", "✓ Sam and Alex joined.", "✓ 3 people
 * joined.", or null while nobody has.
 */
export function joinedLine(community: Community): string | null {
  const members = Array.isArray(community?.members) ? community!.members : [];
  const others = members.filter((m) => m && m.source !== 'creator' && (m.display_name || m.username));
  const counted = Number.isInteger(community?.member_count)
    ? Number(community!.member_count) - (members.length > others.length ? 1 : 0) : 0;
  const count = Math.max(others.length, counted);
  if (count <= 0) return null;
  const named = (m: CommunityMember) => m.display_name || m.username;
  if (count === 1 && others.length === 1) return `✓ ${named(others[0])} joined.`;
  if (count === 2 && others.length === 2) return `✓ ${named(others[0])} and ${named(others[1])} joined.`;
  return `✓ ${count} people joined.`;
}

const JOINED_POLL_MS = 10000;

/** The project's community, read again while an invite is out, so a join shows. */
function useCommunity(slug: string, on: boolean): Community {
  const [community, setCommunity] = useState<Community>(null);
  useEffect(() => {
    if (!on) return undefined;
    let live = true;
    const read = () => fetch(`/api/apps/${encodeURIComponent(slug)}/community`, { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => { if (live && data) setCommunity(data); })
      .catch(() => {});
    read();
    const t = window.setInterval(read, JOINED_POLL_MS);
    return () => { live = false; window.clearInterval(t); };
  }, [slug, on]);
  return community;
}

export function MadeScreen({ made, me, onContinue, onChangePlan }: {
  made: Made;
  me: string;
  /** "Invite people later" / "Go to the Homeroom app": `skipped` when nothing went out. */
  onContinue: (skipped: boolean) => void;
  /** Change something, under the plan: its chat with Homeroom bot, and the plan's message. */
  onChangePlan: (conversationId: number | null, messageId: number | null) => void;
}) {
  const [fv, setFv] = useState<FirstVersion>(null);
  const [appStatus, setAppStatus] = useState<string | null>('creating');
  const [inviting, setInviting] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  // B6: a plan built from here stays, chosen, so the screen says what was decided.
  const [chosen, setChosen] = useState<{ plan: WaitingPlan; choices: string[] } | null>(null);
  const readRef = useRef<() => void>(() => {});

  useEffect(() => {
    let live = true;
    const read = () => fetch(madeAppUrl(made.slug), { credentials: 'same-origin', cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        const app = madeAppOf(body);
        if (live && app) { setFv(app.firstVersion); setAppStatus(app.status); }
      })
      .catch(() => {});
    readRef.current = read;
    read();
    const t = window.setInterval(read, 10000);
    return () => { live = false; window.clearInterval(t); readRef.current = () => {}; };
  }, [made.slug]);

  const community = useCommunity(made.slug, sent);
  const joined = joinedLine(community);
  const waiting = waitingPlan(fv);
  // The plan to decide: one waiting that was not just built from here.
  const plan = waiting && waiting.actionId !== chosen?.plan.actionId ? waiting : null;
  const onBuilt = useCallback((built: WaitingPlan, choices: string[]) => {
    setChosen({ plan: built, choices });
    readRef.current();
  }, []);
  const onGone = useCallback(() => { readRef.current(); }, []);

  const botBuilds = made.conversationId != null;
  // WP-E: "Get a ping when it's ready?" in the Homeroom app, now that there
  // is something to be pinged about (features/dialogs/ping-ask.ts: it shows
  // nothing on the web, or once the phone's answer is decided).
  useEffect(() => { if (botBuilds) askForPingWhileBotBuilds(); }, [botBuilds]);
  const minutes = fv && !fv.ready && typeof fv.typicalMinutes === 'number' ? fv.typicalMinutes : null;
  const sketch = useSketch(made.slug);
  const line = buildLine(fv, appStatus, botBuilds);
  // Something is under way: the project being set up, or the bot's build
  // (not while its plan waits on them: then nothing is).
  const busy = appStatus === 'creating' || (botBuilds && !(fv && fv.ready) && !plan);
  const tile = made.emoji || made.name.slice(0, 1);
  return (
    <div
      role="dialog"
      aria-labelledby="first-session-made-title"
      data-first-session-made=""
      className="fixed inset-0 z-[9000] flex flex-col overflow-y-auto text-zinc-900 dark:text-zinc-100"
      style={{ background: 'var(--home-wallpaper, #f4f2e4)' }}
    >
      <div className="flex h-[52px] shrink-0 items-center justify-center pt-[env(safe-area-inset-top)]">
        <Wordmark className="h-6 w-auto text-[color:var(--brand-ink)]" />
      </div>
      <div className="mx-auto flex w-full max-w-sm grow flex-col px-4 pb-[max(34px,env(safe-area-inset-bottom))]">
        {plan ? (
          <PlanSection
            key={plan.actionId}
            name={made.name}
            plan={plan}
            onBuilt={onBuilt}
            onGone={onGone}
            onChange={() => onChangePlan(plan.conversationId ?? made.conversationId, plan.messageId)}
          />
        ) : chosen ? (
          <div data-first-session-plan="built" className="mt-4">
            <PlanCardView surface="app" appName={made.name} plan={chosen.plan} state="built" choices={chosen.choices} />
          </div>
        ) : null}
        {sketch === 'pending' || sketch === 'ready' ? (
          <SketchCard made={made} tile={tile} sketch={sketch} line={line} botBuilds={botBuilds} busy={busy} minutes={minutes} planWaits={!!plan} />
        ) : (
          <div className="mt-4 flex flex-col items-center rounded-[20px] bg-white px-6 py-7 text-center shadow-[inset_0_0_0_1px_var(--app-sheet-line)] dark:bg-zinc-900">
            <span className="app-icon-tile flex h-20 w-20 items-center justify-center rounded-[22px] text-5xl" aria-hidden="true">{tile}</span>
            <h1 id="first-session-made-title" className="mt-3 text-[22px] font-extrabold leading-tight">{made.name}</h1>
            {made.description ? <p className="mt-1 text-[15px] text-zinc-500 dark:text-zinc-400">{made.description}</p> : null}
            <div className="mt-4 flex items-center gap-2 text-[14px] text-zinc-600 dark:text-zinc-300">
              {busy ? <span className="status-dot creating" aria-hidden="true" /> : null}
              <span data-first-session-build="">{line}</span>
            </div>
            <p className="mt-1 text-[13px] text-zinc-500 dark:text-zinc-400">{buildNote(botBuilds, minutes, !!plan)}</p>
          </div>
        )}
        <div className="mt-6">
          <p className="text-[17px] font-semibold">{`Invite people to ${made.name}`}</p>
          <p className="mt-0.5 text-[14px] leading-snug text-zinc-500 dark:text-zinc-400">They can follow along and chat with you while it's built.</p>
          {sent ? sentLines(joined, sentTo).map((line, i) => (
            <p key={line} data-first-session-sent={joined && i === 0 ? 'joined' : ''} className={`${i ? 'mt-0.5' : 'mt-2'} text-[14px] font-semibold text-emerald-700 dark:text-emerald-400`}>
              {line}
            </p>
          )) : null}
        </div>
        <div className="grow" />
        <div className="mt-6 flex flex-col gap-2.5">
          <Button type="button" onClick={() => setInviting(true)} layout="full" variant="pillAccent" size="pillLg" ink="solidLate" className="flex items-center justify-center">
            Share invite
          </Button>
          <button
            type="button"
            data-first-session-continue=""
            onClick={() => onContinue(!sent)}
            className="flex h-11 w-full items-center justify-center rounded-full bg-white text-[16px] font-semibold text-zinc-900 shadow-sm hover:bg-zinc-50 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800"
          >
            {sent ? 'Go to the Homeroom app' : 'Invite people later'}
          </button>
        </div>
      </div>
      {inviting ? (
        <InviteSheet
          made={made}
          me={me}
          onClose={() => setInviting(false)}
          onSent={(to, close) => { setSent(true); if (to) setSentTo(to); if (close) setInviting(false); }}
        />
      ) : null}
    </div>
  );
}
