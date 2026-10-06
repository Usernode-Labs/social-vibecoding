/**
 * Right after "Make it" (./make.tsx): something to give, and one thing to
 * do with it.
 *
 *   what      The project, being built: its tile and name, read again every
 *             ten seconds past the service worker's cache (madeAppOf,
 *             madeAppUrl). The build's progress is one line under the card,
 *             never inside it: "Spinning up your app" with a pulsing dot
 *             while the bot works, "Version one is ready to try." once it
 *             is. The step counter ("Step 2 of 7: Read the description")
 *             stays on the app's page and in the bot's chat; this screen
 *             stopped counting steps at a person who has just started
 *             (request 4041, October 2026).
 *   invite    "Invite people to <name>": Share invite opens a short sheet
 *             (InviteSheet below). Once something has gone out, the line
 *             says so and "Invite people later" becomes "Go to the
 *             Homeroom app". Either starts the tour (./index.tsx). While
 *             it is out, the project's community is read again, and the
 *             line says who has joined (joinedLine).
 *
 * Nothing under the two buttons. A quiet "While you wait, look around Home
 * and other apps" used to sit there; "Invite people later" is already the
 * way on without inviting anyone, so it was a third way off one screen
 * (Evan, 5 October 2026).
 *
 * The sheet is the first invite, not the project's full invite pane
 * (features/app-context/invite-pane.tsx, with live links, their limits, an
 * invite by username and the project's joining rule, which stays where it
 * is): what they'll get, "<maker> is making <name>" while its first version
 * is not live, with the note edited in place, then Share link. Nothing else:
 * somebody brand new knows nobody on Homeroom to invite by username yet, and
 * the joining rule is the project's business later (both taken out after
 * Evan's run-through, 5 October 2026). The link it makes works until it is
 * turned off, for anyone it reaches (WP-D): the project is the gift, so the
 * link should outlive a week. The first note shared is also the maker's
 * first message in the group's chat (the sheet says so), so the people it
 * brings find it waiting there. The note is kept per project on this device
 * (noteKey), else read back from the maker's own newest link.
 *
 *   sketch    A featured card of the idea (./sketch-card.tsx,
 *             services/app-sketch.js): its emoji, now the project's icon, a
 *             tagline and what it will do, made from the description in a
 *             few seconds. It is only a preview of the app: nothing about
 *             the build is drawn inside it. The same frame stands while it
 *             is sketched. Without one (a project with no sketch, or one
 *             that never came) the card shows the idea's tile alone, with
 *             the progress line and note under whichever card is shown.
 *
 * Every line says what is true for this project: when Homeroom bot builds
 * it (`made.conversationId`, its DM), its step and "messages you"; when it
 * does not, the description is the project's first request, for whoever
 * builds it. Nothing says how long a first version takes (buildNote).
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { XIcon } from '@/components/ui/icons';
import { Wordmark } from '@/components/ui/wordmark';

import { askForPingWhileBotBuilds } from '../dialogs/ping-ask';

import type { Made } from './make';
import { SketchCard, showsCard, useSketch } from './sketch-card';

type FirstVersion = {
  step?: number; of?: number; stepName?: string | null; ready?: boolean;
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
 * What the build's line says while the bot works: one plain line, never a
 * step counter. Request 4041, October 2026: "Step N of 7" was a lot of
 * process for someone who has just started, and sat inside the app card, so
 * the thumbnail and the progress read as one thing.
 */
export function buildLine(fv: FirstVersion, appStatus: string | null, botBuilds = true): string {
  if (fv && fv.ready) return 'Version one is ready to try.';
  if (botBuilds) return 'Spinning up your app';
  if (appStatus === 'creating') return 'Setting it up…';
  return 'Your description is its first request.';
}

/**
 * The line under the build's: who tells them, or who builds it.
 *
 * It says nothing about how long. It used to promise "usually in about 10
 * minutes", an ordinary request's typical build (WP-E, homeroom-bot-dm.js
 * typicalMinutes), and a first version plans first and waits on its maker's
 * answer: Page Turners, 5 October 2026, sent its plan 11 minutes after Make
 * it and was ready to try 50 minutes after it. No average stands in for it
 * (Evan, the same day).
 *
 * Nor does it explain the plan, or ask for it here. It used to hold a
 * second line while the bot's plan waited, asking for the answer on this
 * screen; request 4041 (October 2026) took that ask off: it lives in the
 * bot's chat and on the app's page, so this is one plain line the whole
 * time, before the plan and after it.
 */
export function buildNote(botBuilds: boolean): string {
  if (!botBuilds) return 'You or anyone you invite can build it from there.';
  return 'Homeroom is making your app. It will message you when the first version is ready to try, or if it has any questions.';
}

/**
 * "alex is making Page Turners" while its first version is not live, and
 * "alex made Page Turners" once it is: what they'll get, in the invite sheet
 * and the title of what it shares.
 */
export function makerLine(me: string, name: string, making: boolean): string {
  if (!me) return making ? `Being made: ${name}` : `Made: ${name}`;
  return `${me} ${making ? 'is making' : 'made'} ${name}`;
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

export function InviteSheet({ made, me, making = true, onClose, onSent }: {
  made: Made;
  me: string;
  /** Its first version is not live yet: "<me> is making <name>" (makerLine). */
  making?: boolean;
  onClose: () => void;
  /** The link went out (shared or copied). */
  onSent: () => void;
}) {
  const [note, setNote] = useState(() => openingNote(made.slug, made.example?.note));
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState(false);
  const linkRef = useRef<string | null>(null);
  // Whether the note in the box is theirs from this device (kept, or typed
  // here); until it is, a note on one of their own links replaces it.
  const ownNote = useRef(keptNote(made.slug) !== null);
  useEffect(() => { const r = requestAnimationFrame(() => setShown(true)); return () => cancelAnimationFrame(r); }, []);
  // The maker's own newest note, when this device kept none.
  useEffect(() => {
    if (ownNote.current) return undefined;
    let live = true;
    fetch(`/api/apps/${encodeURIComponent(made.slug)}/invite-links`, { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        const fromLink = live && !ownNote.current ? linkNote(data?.links) : null;
        if (fromLink) setNote(fromLink);
      })
      .catch(() => {});
    return () => { live = false; };
  }, [made.slug]);
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
      const title = makerLine(me, made.name, making);
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
      onSent();
    } catch {
      setError('Could not share the link. Try again.');
    } finally {
      setBusy(false);
    }
  }, [busy, link, me, made.name, making, note, postNote, onSent]);

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
              <p data-first-session-invite-maker="" className="text-[15px] font-semibold leading-snug">{makerLine(me, made.name, making)}</p>
              <p className="text-[13px] text-zinc-500 dark:text-zinc-400">A link to see it and join the chat</p>
            </div>
          </div>
          <div className="px-3 pb-2 pt-2.5 shadow-[inset_0_1px_0_var(--app-sheet-line)]">
            {/* Named on screen, in the label style of "What they'll get" above
                and the make screen's fields (make.tsx LABEL): unlabelled, the
                note read as part of the card rather than something to write. */}
            <label htmlFor="first-session-note" className="block pb-1 text-[13px] text-zinc-500 dark:text-zinc-400">Note</label>
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
        <div className="mt-4">
          <Button type="button" onClick={() => { void shareLink(); }} disabled={busy} layout="full" variant="pillAccent" size="pillLg" ink="solidLate" className="flex items-center justify-center disabled:opacity-60">
            Share link
          </Button>
        </div>
        {status ? <p role="status" data-first-session-invite-status="" className="mt-3 text-center text-[14px] text-emerald-700 dark:text-emerald-400">{status}</p> : null}
        {error ? <p id="first-session-invite-error" role="alert" className="mt-3 text-center text-[14px] text-red-600 dark:text-red-400">{error}</p> : null}
        <p className="mt-3 text-center text-[13px] text-zinc-500 dark:text-zinc-400">Anyone with the link can join, until you turn it off.</p>
      </div>
    </div>
  );
}

type CommunityMember = { username?: string; display_name?: string | null; source?: string };
type Community = { member_count?: number; members?: CommunityMember[] } | null;

/**
 * The made screen's line once an invite is out: who has joined (joinedLine),
 * or, before anyone has, "✓ Invite sent."
 */
export function sentLines(joined: string | null): string[] {
  return [joined || '✓ Invite sent.'];
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

export function MadeScreen({ made, me, onContinue }: {
  made: Made;
  me: string;
  /** "Invite people later" / "Go to the Homeroom app": `skipped` when nothing went out. */
  onContinue: (skipped: boolean) => void;
}) {
  const [fv, setFv] = useState<FirstVersion>(null);
  const [appStatus, setAppStatus] = useState<string | null>('creating');
  const [inviting, setInviting] = useState(false);
  const [sent, setSent] = useState(false);
  // Whether a first version has been read as on its way: once it has, a read
  // without one means it is live (or came to something else), and the
  // project is no longer "being made" (makerLine).
  const [building, setBuilding] = useState(false);

  useEffect(() => {
    let live = true;
    const read = () => fetch(madeAppUrl(made.slug), { credentials: 'same-origin', cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        const app = madeAppOf(body);
        if (live && app) {
          setFv(app.firstVersion);
          setAppStatus(app.status);
          if (app.firstVersion && !app.firstVersion.ready) setBuilding(true);
        }
      })
      .catch(() => {});
    read();
    const t = window.setInterval(read, 10000);
    return () => { live = false; window.clearInterval(t); };
  }, [made.slug]);

  const community = useCommunity(made.slug, sent);
  const joined = joinedLine(community);
  // Not live yet: nothing read, still on its way, or up for approval.
  const making = !(building && !fv);

  const botBuilds = made.conversationId != null;
  // WP-E: "Get a ping when it's ready?" in the Homeroom app, now that there
  // is something to be pinged about (features/dialogs/ping-ask.ts: it shows
  // nothing on the web, or once the phone's answer is decided).
  useEffect(() => { if (botBuilds) askForPingWhileBotBuilds(); }, [botBuilds]);
  const note = buildNote(botBuilds);
  const sketch = useSketch(made.slug);
  const line = buildLine(fv, appStatus, botBuilds);
  // Something is under way: the project being set up, or the bot's build.
  // While the bot's plan waits on its maker's answer, this screen keeps
  // saying it is working: the ask lives in the bot's chat, never here
  // (request 4041).
  const busy = appStatus === 'creating' || (botBuilds && !(fv && fv.ready));
  const tile = sketch.card?.emoji || made.emoji || made.name.slice(0, 1);
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
        {showsCard(sketch.state) ? (
          <SketchCard made={made} sketch={sketch} botBuilds={botBuilds} built={!making || !!(fv && fv.ready)} />
        ) : (
          <div className="mt-4 flex flex-col items-center rounded-[20px] bg-white px-6 py-7 text-center shadow-[inset_0_0_0_1px_var(--app-sheet-line)] dark:bg-zinc-900">
            <span className="app-icon-tile flex h-20 w-20 items-center justify-center rounded-[22px] text-5xl" aria-hidden="true">{tile}</span>
            <h1 id="first-session-made-title" className="mt-3 text-[22px] font-extrabold leading-tight">{made.name}</h1>
            {made.description ? <p className="mt-1 text-[15px] text-zinc-500 dark:text-zinc-400">{made.description}</p> : null}
          </div>
        )}
        {/* The build's progress sits under whichever card is shown, never
            inside it: the card is only a preview of the app (request 4041). */}
        <div className="mt-2.5 flex items-center gap-2 px-1 text-[13px] text-zinc-500 dark:text-zinc-400">
          {busy ? <span className="status-dot creating shrink-0" aria-hidden="true" /> : null}
          <span data-first-session-build="">{line}</span>
        </div>
        <p className="px-1 pt-2.5 text-[13px] leading-snug text-zinc-500 dark:text-zinc-400">{note}</p>
        <div className="mt-6">
          <p className="text-[17px] font-semibold">{`Invite people to ${made.name}`}</p>
          <p className="mt-0.5 text-[14px] leading-snug text-zinc-500 dark:text-zinc-400">They can follow along and chat with you while it's being built.</p>
          {sent ? sentLines(joined).map((line) => (
            <p key={line} data-first-session-sent={joined ? 'joined' : ''} className="mt-2 text-[14px] font-semibold text-emerald-700 dark:text-emerald-400">
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
          made={sketch.card ? { ...made, emoji: sketch.card.emoji } : made}
          me={me}
          making={making}
          onClose={() => setInviting(false)}
          onSent={() => { setSent(true); setInviting(false); }}
        />
      ) : null}
    </div>
  );
}
