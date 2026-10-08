/**
 * "Start your community" (it was "What do you want to make?" until 7 Oct
 * 2026: the screen starts a community, and the app is what it makes): the
 * first thing an account made from the signed-out story is asked (../auth/story.tsx sets the session's
 * `usernode:first-session:make` flag in its sheet; ./index.tsx opens this
 * once the shell has signed them in).
 *
 * Two questions, the New project dialog's own (create-app.tsx), cut down:
 * what it should do, then what to call it — the name is the community's and
 * the project's, since a community and its one project share a name. "Make
 * it" creates a private community through the same POST /api/apps the
 * dialog uses (audience 'invited', no invitees yet: inviting comes next),
 * with `from: 'first-session'`, and Homeroom bot builds the first version
 * from the description. The Create app wizard stays as it is, behind the
 * Create button.
 *
 * WHAT IT OPENS WITH (#4038, #4040; canvas C2-make and C2b-make-waitlist,
 * 6 Oct 2026). A title and the one thing: no line under the title, and
 * no greeting above it (owner, 7 Oct 2026: the logo bar, then the title).
 *   - Four tiles that look like buttons: the three examples (./examples.ts)
 *     and "Your own idea". The first example is chosen when the screen
 *     opens, both fields filled with its words, so the screen shows what an
 *     answer looks like and "Make it" works at once. Another example swaps
 *     its words in; "Your own idea" empties both fields and puts the caret
 *     in "What should it do?".
 *   - When they told us on the waitlist what their group's app should do
 *     (`waitlistIdea` on GET /api/auth/me, services/first-session.js), that
 *     answer is in "What should it do?" instead, the name is left to them,
 *     and the examples step back to a row of chips under the fields. Once
 *     an example has replaced their words, a first chip, "Your idea", puts
 *     them back.
 *
 * ONE FRONT DOOR. It is also what the Create button opens, for everyone and
 * every time (App.showCreateModal, `entry` 'create'), so a second project
 * starts the way the first one did and lands on the same made screen
 * (./made.tsx). `from` is the entry ('first-session' or 'create'): the
 * server sketches the idea for both, and only the first answers the join
 * screen and counts in the admin Journey (routes/apps.js). It is the only
 * door: the New project dialog it once had behind "More options" is gone,
 * and with it choosing Just me, a public community or who approves at
 * creation. Those are a project's own levers afterwards (Invite, "Make it
 * public", Members & approvals).
 *
 * From Create, a small "Import from a GitHub repo" under Make it swaps the
 * two questions for ./import-repo.tsx's (`mode` 'import'; #create/import
 * opens it so, `startImport`): the repo and Check, then the name. It is
 * the same private community through the same POST /api/apps, and it lands
 * on the same made screen, Share invite and all (`imported`).
 *
 * "Look around first" is the first session's quiet way out: Home, with
 * nothing asked. It is an answer, like Make it: until one of the two, the
 * question is still the account's to answer, and every boot of the shell
 * asks it again (a reload, the app reopened, another device; ./index.tsx,
 * services/first-session.js). Opened from Create, there is nothing to
 * answer: ✕ (or Escape) closes it, and More options takes its place.
 *
 * It ARRIVES rather than appears: the screen's ground is the wallpaper
 * from its first frame, the same one the signed-out story and the sign-in
 * sheet's leaving cover paint over the same box (../auth/sign-in-sheet.tsx),
 * and what stands on it rises into place a frame later. Transform and
 * opacity only, no delay, so a busy main thread cannot hold it back on iOS;
 * with reduced motion it is simply there.
 *
 * WITH THE KEYBOARD UP (production run, iOS app, 5 Oct 2026):
 *   - The screen was one scroller from the top of the glass, so revealing
 *     the description above the keys scrolled "Start from an example" up
 *     behind the clock. The wordmark bar now stays put and only what is
 *     under it scrolls, so nothing passes under the status bar. The bar
 *     holds the whole mark below the inset (on a notched phone the mark
 *     used to hang 12px out of its box, and the page would have scrolled
 *     past it). The keyboard surface is attached to the scroller
 *     (lib/keyboard-surface.ts): a tap on a field is focused without the
 *     browser's pan, and the field is revealed once, between the bar and
 *     the keys. (Owner, 7 Oct 2026: the bar stays, as on the story and the
 *     invite page.)
 *   - The two answers are one sequence: the description's Return says
 *     "next" and goes on to the name (Shift+Return is a new line), and the
 *     name's Return makes it. In the app the keyboard's own next chevron
 *     did not move from one to the other; Return is a way on that does not
 *     depend on it.
 *   - "Make it" only looks pale while it is making. It used to stay pale
 *     until a name was typed, beside a placeholder that read like a name
 *     already given. A press with an answer missing now puts the caret in
 *     that field and says what it needs, and the placeholder reads as an
 *     example.
 *
 * AND IN SAFARI (iPhone 17 simulator, iOS 26, 5 Oct 2026): with the keyboard
 * up, iOS panned the page to the tapped description, wordmark bar and all,
 * and "Make it" sat under the keyboard's floating bar once a press had
 * scrolled the form. The screen is a `.platform-kb-surface` now: while the
 * keyboard is open it is padded into the band of the page that is actually
 * visible (lib/keyboard-open.ts, app.css), so the bar is at the top of what
 * is seen and the scroller ends where the keys begin. Its fields are
 * lib/keyboard-surface.ts's: a tap focuses without the pan (the first tap on
 * the description, which this screen focuses from code, included), and the
 * focused field is revealed inside the scroller with "Make it" under it when
 * the two fit. Every focus here is `preventScroll`, so that reveal is the
 * only movement. In the app, whose web view ends at the keys, the band is the
 * whole screen and only the reveal does anything.
 *
 * An example is a starting point, not a choice that sticks: typing words of
 * their own into "What should it do?" lets go of the example (its tile is no
 * longer marked, and Make it no longer sends its description), and the name
 * it filled in stays theirs to keep or change.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { DraftEditIcon } from '@/components/ui/icons';
import { XIcon } from '@/components/ui/icons';
import { Wordmark } from '@/components/ui/wordmark';

import { useKeyboardSurface } from '../../lib/keyboard-surface';
import { AppAllowance, useAppAllowance } from '../dialogs/app-allowance';
import { deviceTimeZone, postCreateApp } from '../dialogs/post-create-app';
import { EXAMPLES, type Example } from './examples';
import { ImportForm, type RepoManifest } from './import-repo';

export { deviceTimeZone };

/** The server's floor and ceiling for a description (services/homeroom-bot-dm.js MIN_/MAX_BRIEF_CHARS). */
export const BRIEF_MIN = 10;
export const BRIEF_MAX = 4000;

/**
 * Which door it was opened through: the first session, or the Create
 * button. Sent as the create's `from`, which is the same two words.
 */
export type MakeEntry = 'first-session' | 'create';

export type Made = {
  slug: string;
  name: string;
  emoji: string | null;
  description: string | null;
  example: Example | null;
  conversationId: number | null;
  /** Imported from a GitHub repo (./import-repo.tsx): nothing is built from a description. */
  imported?: boolean;
};

const FIELD = 'px-4 pt-3 pb-2 [&:not(:last-child)]:border-b [&:not(:last-child)]:border-zinc-200 dark:[&:not(:last-child)]:border-zinc-800';
const LABEL = 'block text-[13px] text-zinc-500 dark:text-zinc-400';
const INPUT = 'w-full border-0 bg-transparent px-0 py-1 text-[17px] text-zinc-900 dark:text-zinc-100 placeholder-zinc-500 focus:outline-none';
// Where the bar and the form start, and where they settle (see the header).
const ARRIVING = 'translate-y-6 opacity-0 transition-[transform,opacity] duration-300 ease-out motion-reduce:transition-none';
const ARRIVED = 'translate-y-0 opacity-100 transition-[transform,opacity] duration-300 ease-out motion-reduce:transition-none';
const NEEDED = 'pb-1 text-xs text-red-700 dark:text-red-400';
// The tiles and chips are buttons and look it: a white face lifted off the
// wallpaper by a soft shadow, with a hairline, or the accent's ring when chosen.
const LIFT = 'bg-white transition-transform active:scale-[0.98] motion-reduce:transition-none dark:bg-zinc-900';
const RING_OFF = 'shadow-[0_1px_3px_rgba(0,0,0,0.1),inset_0_0_0_1px_var(--app-sheet-line)]';
const RING_ON = 'shadow-[0_1px_3px_rgba(0,0,0,0.1),inset_0_0_0_2px_var(--accent)]';
const TILE = `flex min-h-16 items-center gap-2.5 rounded-2xl px-3 py-2 text-left ${LIFT}`;
const TILE_FACE = 'flex h-10 w-10 shrink-0 items-center justify-center rounded-[11px]';
const TILE_LABEL = 'min-w-0 flex-1 text-[15px] font-semibold leading-[19px]';
const CHIP = `flex h-10 items-center gap-1.5 rounded-full pl-2.5 pr-3.5 text-[15px] font-semibold ${LIFT}`;

export type Missing = 'brief' | 'name' | null;

/** The first answer "Make it" still needs, in the screen's order; null when both are there. */
export function missingAnswer(brief: string, name: string): Missing {
  if (brief.trim().length < BRIEF_MIN) return 'brief';
  if (!name.trim()) return 'name';
  return null;
}

/** What a field says when "Make it" found it missing. */
export function neededLine(missing: Missing, brief: string): string | null {
  if (missing === 'brief') return brief.trim() ? 'Say a little more about what it should do.' : 'Say what it should do first.';
  if (missing === 'name') return 'Give it a name to make it. You can change it later.';
  return null;
}

/**
 * What the screen opens with: their waitlist answer with no name and no
 * example chosen, or else the first example, chosen and filled in.
 */
export function openingAnswers(idea: string | null | undefined): { brief: string; name: string; picked: Example | null } {
  const said = typeof idea === 'string' ? idea.trim() : '';
  if (said) return { brief: said, name: '', picked: null };
  const first = EXAMPLES[0];
  return { brief: first.brief, name: first.name, picked: first };
}

/** Over the question from Create: what this is. The first session has no greeting above its title. */
export function makeEyebrow(entry: MakeEntry): string | null {
  return entry === 'create' ? 'New project' : null;
}

/**
 * Under Make it, quietly: what is public once it is made (#4174). Every
 * project's repository is public on GitHub, and its first request is a
 * public issue holding the description word for word, with the plan as a
 * comment (services/github.js, services/homeroom-bot-dm.js).
 */
export const MAKE_PUBLIC_LINE = 'What you write here, and the app’s code, are public on GitHub.';

/** The import form's heading and line (./import-repo.tsx). */
export const IMPORT_TITLE = 'Import a GitHub repo';
export const IMPORT_LINE = 'Bring an app that already exists. Your group builds on it from here.';

/**
 * The screen's root. On the first session it is the whole screen: it
 * arrives on the wallpaper after sign-in, over everything. From Create
 * (#4195) it is a screen like the others, below the platform header
 * (`.platform-under-header`, app.css), so the header's back, bell and menus
 * stay where they are; using one leaves this screen (./index.tsx). The tab
 * bar stays covered either way: this is one thing to do, not a tab.
 */
export const MAKE_ROOT = 'platform-kb-surface fixed inset-0 z-[9000] flex flex-col text-zinc-900 dark:text-zinc-100';
export const MAKE_ROOT_UNDER_HEADER = 'platform-kb-surface platform-under-header fixed inset-x-0 bottom-0 z-[9000] flex flex-col text-zinc-900 dark:text-zinc-100';

export function MakeScreen({
  idea = null, demo = false, onMade, onLookAround, entry = 'first-session', onClose, startImport = false, underHeader = false,
}: {
  /** What they told us on the waitlist the app should do, or null. */
  idea?: string | null;
  /** A screenshot state (./index.tsx makeShot): "Make it" makes nothing. */
  demo?: boolean;
  onMade: (made: Made) => void;
  /** The first session's "Look around first". */
  onLookAround?: () => void;
  entry?: MakeEntry;
  /** From Create: ✕, or Escape. */
  onClose?: () => void;
  /** From Create: open on the import form (#create/import). */
  startImport?: boolean;
  /** From Create, with the platform header showing: below it, not over it (MAKE_ROOT). */
  underHeader?: boolean;
}) {
  const fromCreate = entry === 'create';
  // At the allowance's limit (or a full server), Make it and Import it are
  // pale and the row above says why (the retired dialog's rule: never offer
  // a submit the server will refuse). Never pale for a missing answer.
  const { blocked: quotaBlocks } = useAppAllowance();
  // Make it, or (from Create only) Import it.
  const [mode, setMode] = useState<'make' | 'import'>(fromCreate && startImport ? 'import' : 'make');
  // Decided once, when the screen opens: what they type later is theirs.
  const [opening] = useState(() => openingAnswers(idea));
  const fromWaitlist = !opening.picked;
  const [brief, setBrief] = useState(opening.brief);
  const [name, setName] = useState(opening.name);
  const [picked, setPicked] = useState<Example | null>(opening.picked);
  // "Your own idea" (or, with a waitlist answer, "Your idea") was pressed:
  // its tile or chip is the chosen one.
  const [own, setOwn] = useState(false);
  // With a waitlist answer: an example has replaced their words, so "Your
  // idea" is offered to put them back. It stays once offered.
  const [replaced, setReplaced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The answer a press of "Make it" found missing, said under its field
  // until it changes.
  const [missing, setMissing] = useState<Missing>(null);
  // One request at a time: a second press can land before React has drawn
  // the button busy (the New project dialog's QA 2026-09-24 Q5, which made
  // two projects from one double-click), and Return in the name never goes
  // through the button at all.
  const makingRef = useRef(false);
  const briefRef = useRef<HTMLTextAreaElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  // The caret for a hardware keyboard; on a phone the first tap raises the
  // keys (without iOS's pan: lib/keyboard-surface.ts takes that tap).
  useEffect(() => { briefRef.current?.focus({ preventScroll: true }); }, []);
  // Taps on the fields without the pan, and the focused field (with Make it
  // when they fit) revealed inside the scroller once the keys are up.
  useKeyboardSurface(scrollerRef);
  // One frame on the wallpaper alone, so the rise has a start.
  const [arrived, setArrived] = useState(false);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setArrived(true));
    return () => cancelAnimationFrame(raf);
  }, []);
  const motion = arrived ? ARRIVED : ARRIVING;
  // From Create, Escape closes it, as it closes a dialog.
  useEffect(() => {
    if (!onClose) return undefined;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const pick = useCallback((e: Example) => {
    setPicked(e);
    setOwn(false);
    if (fromWaitlist) setReplaced(true);
    setBrief(e.brief);
    setName(e.name);
    setError(null);
    setMissing(null);
  }, [fromWaitlist]);

  // Empty fields for words of their own, with the caret where they begin
  // (inside the press, so a phone raises its keys).
  const startOwn = useCallback(() => {
    setPicked(null);
    setOwn(true);
    setBrief('');
    setName('');
    setError(null);
    setMissing(null);
    briefRef.current?.focus({ preventScroll: true });
  }, []);

  // "Your idea": their waitlist words back, and the name as the screen
  // opened it (theirs to give).
  const restoreIdea = useCallback(() => {
    setPicked(null);
    setOwn(true);
    setBrief(opening.brief);
    setName(opening.name);
    setError(null);
    setMissing(null);
  }, [opening]);

  const make = useCallback(async () => {
    if (busy || makingRef.current) return;
    const gap = missingAnswer(brief, name);
    if (gap) {
      setMissing(gap);
      (gap === 'brief' ? briefRef.current : nameRef.current)?.focus({ preventScroll: true });
      return;
    }
    if (demo) return;
    makingRef.current = true;
    setBusy(true);
    setError(null);
    // The example's one-line description only while the brief is still the
    // example's own; a brief they rewrote is theirs to describe later.
    const example = picked && brief.trim() === picked.brief ? picked : null;
    const timeZone = deviceTimeZone();
    try {
      const reply = await postCreateApp({
        name: name.trim(),
        audience: 'invited',
        brief: brief.trim(),
        ...(example ? { description: example.description } : {}),
        from: entry,
        // So the sketch's "today" is the maker's (services/app-sketch.js).
        ...(timeZone ? { timeZone } : {}),
      });
      const data = (reply.ok ? reply.data : {}) as {
        app?: { slug?: string; name?: string }; homeroomBot?: { conversationId?: unknown };
      };
      if (!reply.ok || !data.app?.slug) {
        setError(reply.ok ? 'Could not make it. Try again.' : reply.error);
        return;
      }
      onMade({
        slug: data.app.slug,
        name: data.app.name || name.trim(),
        emoji: example ? example.emoji : null,
        description: example ? example.description : null,
        example,
        conversationId: Number(data.homeroomBot?.conversationId) || null,
      });
    } finally {
      makingRef.current = false;
      setBusy(false);
    }
  }, [busy, demo, picked, brief, name, entry, onMade]);
  const needed = neededLine(missing, brief);

  const fields = (
    <div className={`${fromWaitlist ? 'mt-7' : 'mt-3.5'} overflow-hidden rounded-2xl bg-white shadow-[inset_0_0_0_1px_var(--app-sheet-line)] dark:bg-zinc-900`}>
      <div className={FIELD}>
        <label htmlFor="first-session-brief" className={LABEL}>What should it do?</label>
        <textarea
          ref={briefRef}
          id="first-session-brief"
          rows={3}
          maxLength={BRIEF_MAX}
          value={brief}
          enterKeyHint="next"
          aria-describedby={missing === 'brief' ? 'first-session-brief-needed' : undefined}
          onChange={(e) => {
            const next = e.target.value;
            setBrief(next);
            // Their own words let go of the example.
            if (picked && next !== picked.brief) setPicked(null);
            setError(null);
            setMissing(null);
          }}
          onKeyDown={(e) => {
            // Return goes on to the name, as the key says; Shift+Return is a new line.
            if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
            e.preventDefault();
            nameRef.current?.focus({ preventScroll: true });
          }}
          placeholder="For example, a sign-up sheet for our book club"
          className={`${INPUT} resize-none leading-[22px]`}
        />
        {missing === 'brief' ? <p id="first-session-brief-needed" role="alert" className={NEEDED}>{needed}</p> : null}
      </div>
      <div className={FIELD}>
        <label htmlFor="first-session-name" className={LABEL}>What should we call it?</label>
        <input
          ref={nameRef}
          id="first-session-name"
          type="text"
          autoComplete="off"
          enterKeyHint="go"
          value={name}
          aria-describedby={missing === 'name' ? 'first-session-name-needed' : undefined}
          onChange={(e) => { setName(e.target.value); setError(null); setMissing(null); }}
          placeholder="For example, Sunday Run Club"
          className={INPUT}
        />
        {missing === 'name' ? <p id="first-session-name-needed" role="alert" className={NEEDED}>{needed}</p> : null}
      </div>
    </div>
  );

  // The import, through the same request: a private community, as Make it
  // makes, from the repo; what it says about itself is its description.
  const importRepo = useCallback(async ({ repoUrl, name: repoName, manifest }: { repoUrl: string; name: string; manifest: RepoManifest }) => {
    const reply = await postCreateApp({ name: repoName, audience: 'invited', repoUrl, from: entry });
    const data = (reply.ok ? reply.data : {}) as { app?: { slug?: string; name?: string } };
    if (!reply.ok || !data.app?.slug) return reply.ok ? 'Could not import it. Try again.' : reply.error;
    onMade({
      slug: data.app.slug,
      name: data.app.name || repoName,
      emoji: null,
      description: typeof manifest.description === 'string' && manifest.description ? manifest.description : null,
      example: null,
      conversationId: null,
      imported: true,
    });
    return null;
  }, [entry, onMade]);
  const formClass = `mx-auto flex w-full max-w-sm grow flex-col px-4 pb-[max(34px,env(safe-area-inset-bottom))] ${motion}`;
  // From Create, the allowance when it bears on Make it (the New project
  // dialog's quiet row, #23): a returning maker can be at their limit, a new
  // account never is. The wrapper goes with it when there is nothing to say.
  const allowance = fromCreate ? <div className="mt-4 empty:hidden"><AppAllowance id="make-app-quota" surface="pane" quiet /></div> : null;

  return (
    <div
      role="dialog"
      aria-labelledby="first-session-make-title"
      data-first-session-make=""
      data-make-entry={entry}
      className={underHeader ? MAKE_ROOT_UNDER_HEADER : MAKE_ROOT}
      style={{ background: 'var(--home-wallpaper, #f4f2e4)' }}
    >
      {/* Stays put over the scroller, so nothing scrolls under the status bar.
          At least 32px tall under the status bar's inset, so the whole mark
          is inside it and what scrolls stops below the mark, not beside it.
          From Create, ✕ at its leading edge closes the screen. Under the
          platform header the header is the top of the screen: this bar is
          only the ✕, with no mark of its own and no inset to clear. */}
      <div data-first-session-make-top="" className={underHeader ? `relative h-12 shrink-0 ${motion}` : `relative flex h-[max(52px,calc(env(safe-area-inset-top)+32px))] shrink-0 items-center justify-center pt-[env(safe-area-inset-top)] ${motion}`}>
        {onClose ? (
          <button
            type="button"
            data-make-close=""
            onClick={onClose}
            aria-label="Close"
            className="absolute bottom-1 left-3 flex h-9 w-9 items-center justify-center rounded-full bg-white text-zinc-500 shadow-[inset_0_0_0_1px_var(--app-sheet-line)] dark:bg-zinc-900 dark:text-zinc-400"
          >
            <XIcon className="h-4 w-4" aria-hidden="true" />
          </button>
        ) : null}
        {underHeader ? null : <Wordmark className="h-6 w-auto text-[color:var(--brand-ink)]" />}
      </div>
      {/* The scroller the keyboard surface reveals fields in. Its className
          stays constant: nothing here varies it. */}
      <div ref={scrollerRef} data-first-session-make-scroll="" className="flex min-h-0 grow flex-col overflow-y-auto">
        {mode === 'import' ? (
          <ImportForm
            className={formClass}
            header={(
              <div className="text-center">
                <p className="mt-4 text-[13px] font-semibold uppercase tracking-[0.8px] text-zinc-500 dark:text-zinc-400">{makeEyebrow('create')}</p>
                <h1 id="first-session-make-title" className="mt-2.5 text-balance text-[30px] font-extrabold leading-[34px]">{IMPORT_TITLE}</h1>
                <p className="mt-2.5 text-pretty text-[16px] leading-[22px] text-zinc-500 dark:text-zinc-400">{IMPORT_LINE}</p>
              </div>
            )}
            submit={importRepo}
            blocked={quotaBlocks}
            onDescribe={() => { setMode('make'); setTimeout(() => briefRef.current?.focus({ preventScroll: true }), 0); }}
            allowance={allowance}
          />
        ) : (
        <form
          className={`mx-auto flex w-full max-w-sm grow flex-col px-4 pb-[max(34px,env(safe-area-inset-bottom))] ${motion}`}
          onSubmit={(e) => { e.preventDefault(); void make(); }}
        >
          <div className="text-center">
            {makeEyebrow(entry) ? <p className="mt-4 text-[13px] font-semibold uppercase tracking-[0.8px] text-zinc-500 dark:text-zinc-400">{makeEyebrow(entry)}</p> : null}
            <h1 id="first-session-make-title" className={`${fromCreate ? 'mt-2.5' : 'mt-4'} text-balance text-[30px] font-extrabold leading-[34px]`}>Start your community</h1>
          </div>
          {fromWaitlist ? (
            <>
              {fields}
              <p className="mt-[18px] pb-2 text-[13px] text-zinc-500 dark:text-zinc-400">Or start from an example</p>
              <div className="flex flex-wrap gap-2" role="group" aria-label="Examples">
                {replaced ? (
                  <button
                    type="button"
                    aria-pressed={own}
                    data-first-session-own=""
                    onClick={restoreIdea}
                    className={`${CHIP} ${own ? RING_ON : RING_OFF}`}
                  >
                    <DraftEditIcon className="h-4 w-4 text-violet-700 dark:text-violet-300" aria-hidden="true" />
                    Your idea
                  </button>
                ) : null}
                {EXAMPLES.map((e) => {
                  const on = picked?.key === e.key;
                  return (
                    <button
                      key={e.key}
                      type="button"
                      aria-pressed={on}
                      data-first-session-example={e.key}
                      onClick={() => pick(e)}
                      className={`${CHIP} ${on ? RING_ON : RING_OFF}`}
                    >
                      <span className="text-[18px]" aria-hidden="true">{e.emoji}</span>
                      {e.short}
                    </button>
                  );
                })}
              </div>
            </>
          ) : (
            <>
              <div className="mt-7 grid grid-cols-2 gap-2" role="group" aria-label="Start from">
                {EXAMPLES.map((e) => {
                  const on = picked?.key === e.key;
                  return (
                    <button
                      key={e.key}
                      type="button"
                      aria-pressed={on}
                      data-first-session-example={e.key}
                      onClick={() => pick(e)}
                      className={`${TILE} ${on ? RING_ON : RING_OFF}`}
                    >
                      <span className={`app-icon-tile ${TILE_FACE} text-[22px]`} aria-hidden="true">{e.emoji}</span>
                      <span className={TILE_LABEL}>{e.short}</span>
                    </button>
                  );
                })}
                <button
                  type="button"
                  aria-pressed={own}
                  data-first-session-own=""
                  onClick={startOwn}
                  className={`${TILE} ${own ? RING_ON : RING_OFF}`}
                >
                  <span className={`${TILE_FACE} bg-violet-50 text-violet-700 dark:bg-violet-500/10 dark:text-violet-300`} aria-hidden="true">
                    <DraftEditIcon className="h-5 w-5" />
                  </span>
                  <span className={TILE_LABEL}>Your own idea</span>
                </button>
              </div>
              {fields}
            </>
          )}
          {allowance}
          {error ? <p role="alert" className="mt-3 text-[14px] text-red-700 dark:text-red-400">{error}</p> : null}
          <div className="grow" />
          <Button
            type="submit"
            disabled={busy || quotaBlocks}
            layout="full"
            variant="pillAccent"
            size="pillLg"
            ink="solidLate"
            className="mt-6 flex items-center justify-center disabled:opacity-50"
          >
            {busy ? 'Making it…' : 'Make it'}
          </Button>
          <p data-make-public="" className="mt-2 text-center text-[13px] leading-snug text-zinc-500 dark:text-zinc-400">{MAKE_PUBLIC_LINE}</p>
          {fromCreate ? (
            // Small, under Make it: the one other way to start a project.
            <p className="mt-3 text-center">
              <button
                type="button"
                data-make-import-link=""
                onClick={() => setMode('import')}
                className="text-[13px] font-medium text-violet-700 hover:underline dark:text-violet-400"
              >
                Import from a GitHub repo
              </button>
            </p>
          ) : (
            <p className="mt-3 text-center text-[15px] text-zinc-500 dark:text-zinc-400">
              {'Not sure yet? '}
              <button type="button" onClick={onLookAround} className="font-medium text-violet-700 hover:underline dark:text-violet-400">Look around first</button>
            </p>
          )}
        </form>
        )}
      </div>
    </div>
  );
}
