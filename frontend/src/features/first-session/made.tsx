/**
 * Right after "Make it" (./make.tsx): something to give, and one thing to
 * do with it.
 *
 *   what      The project, being built: its tile and name, Homeroom bot's
 *             step from GET /api/apps/:slug (`first_version`, "Step 2 of 7:
 *             Read the description"), read again every ten seconds.
 *   invite    "Invite people to <name>": Share invite opens a short sheet
 *             (InviteSheet below). Once something has gone out, the line
 *             says so and "Invite people later" becomes "Go to the
 *             Homeroom app". Either starts the tour (./index.tsx).
 *
 * The sheet is the first invite, not the project's full invite pane
 * (features/app-context/invite-pane.tsx, with live links and their limits,
 * which stays where it is): what they'll get, with the note edited in place,
 * then Share link; a username sits behind one button. The link it makes
 * works until it is turned off, for anyone it reaches (WP-D) — the project
 * is the gift, so the link should outlive a week. Under it, one line on what
 * joining means, from the project's real rule (GET .../invite-links
 * `joiningRule`). The first note shared is also
 * the maker's first message in the group's chat (the sheet says so), so the
 * people it brings find it waiting there.
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

import type { Made } from './make';

type FirstVersion = { step?: number; of?: number; stepName?: string | null; ready?: boolean } | null;

/** "Step 2 of 7: Read the description", or what to say without a build. */
export function buildLine(fv: FirstVersion, appStatus: string | null, botBuilds = true): string {
  if (fv && fv.ready) return 'Version one is ready to try.';
  if (fv && fv.step && fv.of) return `Step ${fv.step} of ${fv.of}${fv.stepName ? `: ${fv.stepName}` : ''}`;
  if (appStatus === 'creating') return 'Setting it up…';
  return botBuilds ? 'Homeroom bot builds it from your description.' : 'Your description is its first request.';
}

/** The line under the build's: who tells them, or who builds it. */
export function buildNote(botBuilds: boolean): string {
  return botBuilds
    ? 'Homeroom bot messages you when it\'s ready to try.'
    : 'You or anyone you invite can build it from there.';
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

function SketchCard({ made, tile, sketch, line, botBuilds, busy }: {
  made: Made;
  tile: string;
  sketch: 'pending' | 'ready';
  line: string;
  botBuilds: boolean;
  busy: boolean;
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
        {sketch === 'ready' ? sketchCaption(made.name, botBuilds) : buildNote(botBuilds)}
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

function InviteSheet({ made, me, onClose, onSent }: {
  made: Made;
  me: string;
  onClose: () => void;
  onSent: (to: string | null) => void;
}) {
  const [note, setNote] = useState(made.example?.note || NOTE_DEFAULT);
  const [byName, setByName] = useState(false);
  const [username, setUsername] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState(false);
  const [rule, setRule] = useState<string | null>(null);
  const linkRef = useRef<string | null>(null);
  useEffect(() => { const r = requestAnimationFrame(() => setShown(true)); return () => cancelAnimationFrame(r); }, []);
  // WP-D: what joining means here, said from the project's real rule.
  useEffect(() => {
    let live = true;
    fetch(`/api/apps/${encodeURIComponent(made.slug)}/invite-links`, { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => { if (live && typeof data?.joiningRule === 'string') setRule(data.joiningRule); })
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
      await postNote();
      onSent(null);
    } catch {
      setError('Could not share the link. Try again.');
    } finally {
      setBusy(false);
    }
  }, [busy, link, me, made.name, note, postNote, onSent]);

  const sendToUsername = useCallback(async () => {
    const handle = username.trim().replace(/^@/, '');
    if (!handle || busy) return;
    setBusy(true); setError(null); setStatus(null);
    try {
      const res = await fetch(`/api/apps/${encodeURIComponent(made.slug)}/invites`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ username: handle }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setError(data.error || 'Could not invite them.'); return; }
      await postNote();
      setUsername('');
      onSent(`@${handle}`);
    } catch {
      setError('Network error');
    } finally {
      setBusy(false);
    }
  }, [username, busy, made.slug, postNote, onSent]);

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
              onChange={(e) => setNote(e.target.value)}
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
                onChange={(e) => setUsername(e.target.value)}
                placeholder="@username"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                className="h-11 min-w-0 flex-1 rounded-full border-0 bg-white px-4 text-[16px] placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-violet-500 dark:bg-zinc-800"
              />
              <Button type="submit" disabled={busy || !username.trim()} variant="pillAccent" size="pill" ink="solid" className="disabled:opacity-60">Send</Button>
            </form>
          ) : (
            <button type="button" onClick={() => setByName(true)} className="flex h-11 w-full items-center justify-center rounded-full bg-white text-[16px] font-semibold text-zinc-900 shadow-sm hover:bg-zinc-50 dark:bg-zinc-800 dark:text-zinc-100 dark:hover:bg-zinc-700">
              Invite by username
            </button>
          )}
        </div>
        {status ? <p className="mt-3 text-center text-[14px] text-emerald-700 dark:text-emerald-400">{status}</p> : null}
        {error ? <p role="alert" className="mt-3 text-center text-[14px] text-red-600 dark:text-red-400">{error}</p> : null}
        <p className="mt-3 text-center text-[13px] text-zinc-500 dark:text-zinc-400">Anyone with the link can join, until you turn it off.</p>
        {rule ? <p data-first-session-rule="" className="mt-1 text-center text-[13px] text-zinc-500 dark:text-zinc-400">{rule}</p> : null}
      </div>
    </div>
  );
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
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  useEffect(() => {
    let live = true;
    const read = () => fetch(`/api/apps/${encodeURIComponent(made.slug)}`, { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((app) => { if (live && app) { setFv(app.first_version || null); setAppStatus(app.status || null); } })
      .catch(() => {});
    read();
    const t = window.setInterval(read, 10000);
    return () => { live = false; window.clearInterval(t); };
  }, [made.slug]);

  const botBuilds = made.conversationId != null;
  const sketch = useSketch(made.slug);
  const line = buildLine(fv, appStatus, botBuilds);
  // Something is under way: the project being set up, or the bot's build.
  const busy = appStatus === 'creating' || (botBuilds && !(fv && fv.ready));
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
        {sketch === 'pending' || sketch === 'ready' ? (
          <SketchCard made={made} tile={tile} sketch={sketch} line={line} botBuilds={botBuilds} busy={busy} />
        ) : (
          <div className="mt-4 flex flex-col items-center rounded-[20px] bg-white px-6 py-7 text-center shadow-[inset_0_0_0_1px_var(--app-sheet-line)] dark:bg-zinc-900">
            <span className="app-icon-tile flex h-20 w-20 items-center justify-center rounded-[22px] text-5xl" aria-hidden="true">{tile}</span>
            <h1 id="first-session-made-title" className="mt-3 text-[22px] font-extrabold leading-tight">{made.name}</h1>
            {made.description ? <p className="mt-1 text-[15px] text-zinc-500 dark:text-zinc-400">{made.description}</p> : null}
            <div className="mt-4 flex items-center gap-2 text-[14px] text-zinc-600 dark:text-zinc-300">
              {busy ? <span className="status-dot creating" aria-hidden="true" /> : null}
              <span data-first-session-build="">{line}</span>
            </div>
            <p className="mt-1 text-[13px] text-zinc-500 dark:text-zinc-400">{buildNote(botBuilds)}</p>
          </div>
        )}
        <div className="mt-6">
          <p className="text-[17px] font-semibold">{`Invite people to ${made.name}`}</p>
          <p className="mt-0.5 text-[14px] leading-snug text-zinc-500 dark:text-zinc-400">They can follow along and chat with you while it's built.</p>
          {sent ? (
            <p data-first-session-sent="" className="mt-2 text-[14px] font-semibold text-emerald-700 dark:text-emerald-400">
              {`✓ Invite sent${sentTo ? ` to ${sentTo}` : ''}.`}
            </p>
          ) : null}
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
          onSent={(to) => { setSent(true); if (to) setSentTo(to); setInviting(false); }}
        />
      ) : null}
    </div>
  );
}
