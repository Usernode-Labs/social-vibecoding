import { SpeakButton } from '../dictation/speak-button';
import { reducedMotion } from '../../lib/reduced-motion';
/**
 * "What do you want to make?": the first thing an account made from the
 * signed-out story is asked (../auth/story.tsx sets the session's
 * `usernode:first-session:make` flag in its sheet; ./index.tsx opens this
 * once the shell has signed them in).
 *
 * Two questions, the New project dialog's own (create-app.tsx), cut down:
 * what it should do, then what to call it — the name is the group's and
 * the project's, since a community and its one project share a name. The
 * starting points (./examples.ts) fill both in. "Make it" creates a
 * private community through the same POST /api/apps the dialog uses
 * (../dialogs/post-create-app.ts; audience 'invited', no invitees yet:
 * inviting comes next), and Homeroom bot builds the first version from the
 * description.
 *
 * ONE FRONT DOOR. It is also what the Create button opens, for everyone and
 * every time (App.showCreateModal, `entry` 'create'), so a second project
 * starts the way the first one did and lands on the same made screen
 * (./made.tsx). `from` is the entry ('first-session' or 'create'): the
 * server sketches the idea for both, and only the first answers the join
 * screen and counts in the admin Journey (routes/apps.js). It is the only
 * door: the New project dialog it once had behind "More options" is gone,
 * and with it choosing Just me or a public community at creation. Those are
 * a project's own levers afterwards (Invite, "Make it public"). Who can change
 * it is one line under the two answers (#4666, ../who-decides/make-rule.tsx
 * `MakeRuleLine`): You or the group unless its Change picks another preset,
 * sent as the project's own governance block.
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
 *     past it). The kit's keyboard avoidance is attached to the scroller
 *     with the bar as its top (lib/composer-keyboard.ts), as every chat
 *     column has it: a tap on a field is focused without the browser's pan,
 *     and the field is revealed once, between the bar and the keys.
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
 * OVER A PAGE THAT HOLDS STILL (onboarding run, 12 Oct 2026, iPhone 17
 * Safari, #4893): a drag the screen's own scroller did not take scrolled
 * Home underneath, and its cards came up behind the status bar. While it is
 * up the page is held (lib/page-lock.ts): the document does not scroll, and
 * on the first session Home takes no tap or focus. In a phone browser on iOS
 * its ground also runs on above it, under the status bar (app.css).
 *
 * STARTING POINTS (Evan, 8 Oct 2026): four tiles, two by two. A tier list,
 * a game and an organizer are sentences with a blank (./examples.ts); the
 * fourth, Your own idea, is the plain description box, which is also what
 * the screen opens on. A tap on the tier list or the organizer picks its
 * first choice, so one tap is a whole description; the chips under the
 * sentence change the blank, and Your own… puts a field for their words in
 * it. The game is always finished in their own words, in a box under the
 * sentence: the fun of a game is in what you build, so it starts on Your
 * own and each starter ("a board game where") still waits for the rest.
 * The name follows the choice ("Hiking Tier List") until they type one.
 *
 * SOMETHING ELSE (Evan, 15 Oct 2026): still two by two, but the tiles are
 * the front three (./examples.ts FRONT: a tier list, a game and an
 * organizer, one config list) and "Something else…". That tile opens a sheet
 * (./more-sheet.tsx) with Your own idea first and then the rest (MORE: a
 * poll, find a time, a sign-up sheet and a group challenge). A pick
 * there takes the fourth tile over, with a chevron that opens the sheet
 * again; Your own idea takes it too, picked there or by writing in the box.
 *
 * A template is a starting point, not a choice that sticks: "Write it
 * yourself" turns the sentence into the plain box, and words of their own
 * there let go of the template (Your own idea is marked instead, and Make
 * it no longer sends the template's description). The name stays theirs to
 * keep or change.
 *
 * INSTANT OR CUSTOM (Evan, 15 Oct 2026): one line above Who can change it
 * says what Make it will do, and follows each pick and keystroke
 * (`makeSpeed`). A choice that makes a ready-made app is Instant, ready in
 * about a minute; anything Homeroom bot builds (their own words, Write it
 * yourself, a game, Your own…) is Custom, 20 to 30 minutes. Before anything
 * is picked or typed there is no line: Make it would only ask for the answer.
 *
 * ARRIVING, NOT LANDING (#5266, 20 Oct 2026): on the first session a quiet
 * line under the question says Welcome, and what to do here — someone just
 * let in off the waitlist, or in from the story, has never seen this screen.
 * It is not drawn from Create, which is a returning maker's New project. The
 * column is wider from a tablet up (`md:max-w-xl`), and the spacer that
 * pushed Make it to the foot of the window is gone, so Make it follows the
 * rule line everywhere. The rule line's ⓘ says in a tip what happens next
 * (../who-decides/make-rule.tsx).
 *
 * PHONE REVIEW (23 Nov 2026, iPhone 17 and iPhone Duo):
 *   - UNDER THE ✕, NOT CUT BESIDE IT (#9). From Create the ✕ stood in a 48px
 *     band above a scroller that clipped at the band's foot, so a heading
 *     scrolled a little was sliced along a straight line. The ✕ floats over
 *     the scroller's head now (MAKE_HEAD of padding there, so the page rests
 *     where it did) and what scrolls up fades out under it (app.css). Every
 *     reveal counts that head as covered (`head`, lib/keyboard-surface.ts).
 *     On the Duo the screen also stops at the system's column (app.css).
 *   - THE KEYS SHORTEN IT AT EVERY WIDTH (#16), app.css; and when the screen
 *     is folded or turned with a field focused, that field is shown again
 *     (`revealField`), whatever was dragged before.
 *   - SOMETHING ELSE KEEPS ITS NAME (S7). Writing in the box used to turn
 *     the fourth tile into "Your own idea", ringed, though nothing had been
 *     picked. Only a pick in the sheet does that now (`ideaChosen`). The
 *     Instant or Custom line keeps its room before there is one to show, so
 *     Make it does not move when it arrives.
 */

import { type KeyboardEvent as ReactKeyboardEvent, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { Button } from '@/components/ui/button';
import { Chip } from '@/components/ui/chip';
import { BoltIcon, ChevronDownIcon, PencilSquareIcon, SparklesIcon, XIcon } from '@/components/ui/icons';
import { Wordmark } from '@/components/ui/wordmark';

import { RichMessage, useMessages } from '../../lib/i18n/react';
import { t as translate } from '../../lib/i18n/runtime';
import { KB_OPEN_CLASS } from '../../lib/keyboard-open';
import { revealScrollTop, useKeyboardSurface } from '../../lib/keyboard-surface';
import { usePageLock } from '../../lib/page-lock';
import { openSheetCount } from '../../lib/sheet';
import { mayFocusByCodeNow } from '../auth/sign-in-sheet';
import { MakeRuleLine } from '../who-decides/make-rule';
import { DEFAULT_PRESET, type PresetKey } from '../who-decides/model';
import { AppAllowance, useAppAllowance } from '../dialogs/app-allowance';
import { deviceTimeZone, postCreateApp } from '../dialogs/post-create-app';
import { descriptionOf, firstChoice, FRONT, MORE, OWN, readyMadeOf, sentence, starterOf, suggestedName, type Template } from './examples';
import { ImportForm, type RepoManifest } from './import-repo';
import { MoreSheet } from './more-sheet';
import { TierChart } from './tier-chart';

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
  /** The template it was made from, while its sentence was still the template's. */
  example: Template | null;
  conversationId: number | null;
  /** Imported from a GitHub repo (./import-repo.tsx): nothing is built from a description. */
  imported?: boolean;
  /** One of Homeroom's ready-made apps (examples.ts `readyMadeOf`): nothing is built, it is ready once it runs. */
  readyMade?: boolean;
  /**
   * A ready-made app's example picture, its main screen with sample entries
   * (POST /api/apps `exampleScreen`, services/app-templates.js): the made
   * screen's card shows it as the App side, tagged as an example.
   */
  exampleScreen?: string | null;
};

const FIELD = 'px-4 pt-3 pb-2 [&:not(:last-child)]:border-b [&:not(:last-child)]:border-zinc-200 dark:[&:not(:last-child)]:border-zinc-800';
const LABEL = 'block text-[13px] text-zinc-500 dark:text-zinc-400';
/*
 * UNDER ITS LABEL (newcomer run six, 14 Oct 2026, iPhone Safari, keyboard
 * up): a description of about 200 characters is longer than the three rows
 * the box shows, so the box scrolls, and its text ran up to the box's top
 * edge, which was the label's own bottom edge. The line cut off there read
 * as text passing under "What should it do?". Both fields keep 8px between
 * their label and their writing (`pt-2`), and while the description is
 * scrolled from its top its text fades out over the box's top line
 * (BRIEF_FADE, `briefScrolled`), so a line scrolling up thins out inside its
 * own box, below the label, never against it. Unscrolled there is no fade
 * and the first line is drawn whole. The name is one line, which scrolls
 * sideways and never up, so it needs the gap only.
 *
 * Run seven (14 Oct 2026, iPhone Safari) still saw a grey half line touching
 * the label: the description's 8px was padding, inside its own scroll box,
 * so scrolled text rose through it to the label's bottom edge, and the fade
 * there was only starting. The description's gap is a margin now
 * (BRIEF_INPUT, `mt-2`, no top padding), so the box's clip edge sits 8px
 * under the label, and the fade hides the box's top 6px outright before it
 * ramps in by 24px. Unscrolled, the first line starts 8px under the label as
 * before. The name keeps its padding (INPUT).
 */
const INPUT = 'w-full border-0 bg-transparent px-0 pb-1 pt-2 text-[17px] text-zinc-900 dark:text-zinc-100 placeholder-zinc-500 focus:outline-none';
const BRIEF_INPUT = 'mt-2 w-full border-0 bg-transparent px-0 pb-1 pt-0 text-[17px] text-zinc-900 dark:text-zinc-100 placeholder-zinc-500 focus:outline-none';
export const BRIEF_FADE = '[mask-image:linear-gradient(to_bottom,transparent_6px,#000_24px)]';
/** Whether the description's box is scrolled from its top, so its top edge fades (BRIEF_FADE). Pure. */
export function briefFades(box: { scrollTop: number } | null | undefined): boolean {
  return !!box && box.scrollTop > 0;
}
// Where the bar and the form start, and where they settle (see the header).
const ARRIVING = 'translate-y-6 opacity-0 transition-[transform,opacity] duration-300 ease-out motion-reduce:transition-none';
const ARRIVED = 'translate-y-0 opacity-100 transition-[transform,opacity] duration-300 ease-out motion-reduce:transition-none';
const HINT = 'pb-1 text-xs text-zinc-500 dark:text-zinc-400';
const NEEDED = 'pb-1 text-xs text-red-700 dark:text-red-400';
// What stands in a template's blank, and the field for their own words there.
const BLANK = 'rounded-md bg-violet-50 px-1 py-px font-semibold text-violet-700 [box-decoration-break:clone] dark:bg-violet-950 dark:text-violet-300';
const BLANK_FIELD = 'mx-0.5 inline-block w-[9.5em] max-w-full rounded-md border-0 bg-violet-50 px-1.5 align-baseline text-[17px] font-semibold leading-[26px] text-violet-700 placeholder-zinc-500 shadow-[inset_0_-2px_0_var(--accent)] focus:outline-none dark:bg-violet-950 dark:text-violet-300';
// The game's box for the rest of the sentence: a field, plainly, ringed in
// the accent while it is empty so it is the next thing to do.
const WORDS_BOX = 'mt-1.5 block w-full resize-none rounded-xl border-0 bg-white px-3 py-2.5 text-[17px] leading-[22px] text-zinc-900 placeholder-zinc-500 focus:shadow-[inset_0_0_0_2px_var(--accent),0_0_0_4px_rgba(10,110,224,0.15)] focus:outline-none dark:bg-zinc-900 dark:text-zinc-100';
const WORDS_EMPTY = 'shadow-[inset_0_0_0_2px_var(--accent),0_0_0_4px_rgba(10,110,224,0.15)]';
const WORDS_FILLED = 'shadow-[inset_0_0_0_1px_var(--app-sheet-line)]';
const TILE = 'relative flex items-center gap-2.5 rounded-2xl bg-white px-3 py-2.5 text-start dark:bg-zinc-900';
const TILE_ON = 'shadow-[inset_0_0_0_2px_var(--accent)]';
const TILE_OFF = 'shadow-[inset_0_0_0_1px_var(--app-sheet-line)]';

/** The tile that is the plain description box. */
export const OWN_IDEA = 'idea';

/** Who a new project is for (services/create-options.js): Just me, A group, A community. */
export type CreateAudience = 'solo' | 'invited' | 'open';
/** The fourth tile while nothing from "Something else…" holds it. */
export const MORE_TILE = 'more';

/**
 * INSTANT OR CUSTOM: what Make it will do with what is on screen now.
 * `instant` while it would make a ready-made app, which is Make it's own
 * test (`readyMadeOf` while the sentence is still the template's, not
 * written out); `custom` while Homeroom bot would build it; null while
 * nothing is picked or typed, when Make it would only ask for the answer.
 * Pure.
 */
export type MakeSpeed = 'instant' | 'custom' | null;
export function makeSpeed(
  picked: Template | typeof OWN_IDEA | null,
  choice: string,
  written: string | null,
  brief: string,
): MakeSpeed {
  const template = picked && picked !== OWN_IDEA ? picked : null;
  if (template && written === null && readyMadeOf(template, choice)) return 'instant';
  if (!picked && !brief.trim()) return null;
  return 'custom';
}

/**
 * #6842: why Make it is pale, as a message id, one for each limit the
 * allowance names (`blockedReason`). The same sentence the server refuses
 * with. Create draws its own allowance card instead; every other door says
 * the one line (this screen, and the import form's own slot for it).
 */
export const BLOCKED_LINE = {
  no_slots: 'onboarding:firstSession.make.blocked.noSlots',
  slots: 'onboarding:firstSession.make.blocked.slots',
  server: 'onboarding:firstSession.make.blocked.server',
} as const;

/** The line for each, a message id: its first word is bold (`<0>…</0>`). */
export const SPEED_LINE = {
  instant: 'onboarding:firstSession.make.speed.instant',
  custom: 'onboarding:firstSession.make.speed.custom',
} as const;

export type Missing = 'blank' | 'brief' | 'name' | null;

/** The first answer "Make it" still needs, in the screen's order; null when both are there. */
export function missingAnswer(brief: string, name: string): Missing {
  if (brief.trim().length < BRIEF_MIN) return 'brief';
  if (!name.trim()) return 'name';
  return null;
}

/**
 * What a field says when "Make it" found it missing. `blank` is a
 * template's: their own words in its blank, or, for the game, the rest of
 * its sentence (`finishing`).
 */
export function neededLine(missing: Missing, brief: string, finishing = false): string | null {
  if (missing === 'blank') return finishing ? translate('onboarding:firstSession.make.needed.finish') : translate('onboarding:firstSession.make.needed.blank');
  if (missing === 'brief') return brief.trim() ? translate('onboarding:firstSession.make.needed.briefShort') : translate('onboarding:firstSession.make.needed.brief');
  if (missing === 'name') return translate('onboarding:firstSession.make.needed.name');
  return null;
}

/**
 * The question itself (#5617): hello on the first session when the name is
 * known, the plain question from Create or without one. One title, no
 * eyebrow above it.
 */
export function makeTitle(entry: MakeEntry, who: string): string {
  if (entry !== 'create' && who) return translate('onboarding:firstSession.make.titleHello', { name: who });
  return translate('onboarding:firstSession.make.title');
}

/**
 * Under the description box, quietly, while it still holds the answer the
 * person gave on the waitlist (#4040): it opens on Your own idea with that
 * answer in the box. Gone once they change a word of it. A message id.
 */
export const WAITLIST_IDEA_LINE = 'onboarding:firstSession.make.waitlistIdea';

/**
 * The same quiet line for an idea Discover's search handed in (#5928): the
 * words searched for that no app answered. A message id.
 */
export const SEARCH_IDEA_LINE = 'onboarding:firstSession.make.searchIdea';

/**
 * #6784: the same quiet line for an idea a private thread handed in: the
 * plan agreed with Homeroom bot in it comes along with what they send. A
 * message id.
 */
export const THREAD_IDEA_LINE = 'onboarding:firstSession.make.threadIdea';

/**
 * Where an idea handed to the make screen came from, which decides the line
 * under the box: the waitlist answer (the first session's, and the default),
 * a Discover search (#5928), or a private thread's words (#6019), which says
 * nothing because the person just wrote them there.
 */
export type IdeaSource = 'waitlist' | 'search' | 'thread';

/** The import form's heading and line (./import-repo.tsx), as message ids. */
export const IMPORT_TITLE = 'onboarding:firstSession.import.title';
export const IMPORT_LINE = 'onboarding:firstSession.import.line';

/**
 * N9 (polish board, 19 Oct 2026): A REVEAL NEVER STOPS INSIDE THE HEADING.
 * A pick that grows the form scrolls the description and Make it into view
 * (`revealScrollTop`), and on a phone that left the screen's top edge
 * through "What do you want to make?", showing only its second line. A
 * scrollTop that would cut the heading goes on to its foot instead, so the
 * heading is whole or out of view, and Make it is still in view. Positions
 * are the scroller content's (scrollTop's own measure). Pure.
 */
export function clearOfHeading(top: number, headTop: number, headBottom: number, scrollMax: number): number {
  if (!(top > headTop && top < headBottom)) return top;
  return Math.max(0, Math.min(Math.max(0, scrollMax), Math.ceil(headBottom)));
}

/**
 * N9: WHAT YOU STARTED IS KEPT. ✕ (or Escape, or anything else that leaves
 * the screen) used to throw away a form with a description, a name or a
 * pick in it. From Create the form is kept for the page's life and opens
 * filled the next time; making the project, or leaving it empty, clears it.
 * Only Create's: the first session's screen is answered once. It is kept
 * with whose it is, and opens only for them.
 */
type MakeDraft = {
  brief: string;
  name: string;
  nameTyped: boolean;
  picked: Template | typeof OWN_IDEA | null;
  choice: string;
  words: string;
  written: string | null;
  rule: PresetKey;
  /** Your own idea was picked in the sheet, not only written in the box (S7). */
  ideaChosen?: boolean;
};
let keptDraft: (MakeDraft & { who: string }) | null = null;

/**
 * #6781: a name handed in (a private thread's New project, which offers it
 * with the brief) is a new start, as a brief is: drop the draft left from
 * Create before the screen mounts, so it does not open with that name over
 * the bot's. Called by the door that hands one in (./index.tsx openCreate).
 */
export function forgetKeptDraft(): void {
  keptDraft = null;
}

/** The draft to keep, or null when the form holds nothing worth keeping. Pure. */
export function draftWorthKeeping(draft: MakeDraft | null): MakeDraft | null {
  if (!draft) return null;
  return draft.brief.trim() || draft.name.trim() || draft.words.trim() || draft.picked || draft.rule !== DEFAULT_PRESET
    ? draft : null;
}

/** How long the screen takes to fade off what is under it as it leaves (#8). */
export const MAKE_LEAVE_MS = 200;

/**
 * #9: how much of the scroller's head the ✕ floats over, from Create under
 * the platform header (px; app.css pads the scroller by the same 3rem and
 * fades what scrolls into it). A reveal keeps a field and the heading clear
 * of it.
 */
export const MAKE_HEAD = 48;
/** How long after the window's width last changed (a fold, a turn) the focused field is shown again (ms). */
export const TURN_SETTLE_MS = 300;

/**
 * Bring `field` into the scroller's view, with `action` (Make it) under it
 * when the two fit, counting `head` px at the scroller's top as covered.
 * `viewBottom` caps where the view ends (Safari's toolbar, with the keys
 * down). Returns the scrollTop asked for, or null when nothing moved.
 */
export function revealField(
  scroller: HTMLElement, field: Element, action: Element | null, head: number, viewBottom?: number,
): number | null {
  const view = scroller.getBoundingClientRect();
  const box = field.getBoundingClientRect();
  const act = action ? action.getBoundingClientRect() : null;
  const scrollMax = scroller.scrollHeight - scroller.clientHeight;
  const reveal = revealScrollTop({
    scrollTop: scroller.scrollTop,
    scrollMax,
    viewTop: view.top + head,
    viewBottom: viewBottom == null ? view.bottom : Math.min(view.bottom, viewBottom),
    fieldTop: box.top,
    fieldBottom: box.bottom,
    actionTop: act ? act.top : null,
    actionBottom: act ? act.bottom : null,
  });
  // N9: never stop inside the heading. Under the ✕'s head it is cut as soon
  // as its top passes the head's foot, so that is where "inside" starts.
  const heading = scroller.querySelector('#first-session-make-title')?.getBoundingClientRect();
  const top = heading
    ? clearOfHeading(reveal, heading.top - view.top + scroller.scrollTop - head, heading.bottom - view.top + scroller.scrollTop, scrollMax)
    : reveal;
  if (top === Math.round(scroller.scrollTop)) return null;
  try {
    scroller.scrollTo({ top, behavior: reducedMotion() ? 'auto' : 'smooth' });
  } catch {
    scroller.scrollTop = top;
  }
  return top;
}

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
  who, onMade, onLookAround, entry = 'first-session', onClose, startImport = false, underHeader = false, idea = null, name: startName = null, ideaSource = 'waitlist',
  audience = 'invited', threadRootId = null,
}: {
  who: string;
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
  /**
   * The first session's: what the person answered on the waitlist, known at
   * mount (the signed-in user's, or a screenshot state's). When there is
   * one, the screen opens on Your own idea with it in the box.
   */
  idea?: string | null;
  /**
   * #6781: the name Homeroom bot suggested with its offer (Create, from a
   * private thread's New project). The screen opens with it in the name
   * field, editable, and it counts as typed: a tile picked later keeps it.
   */
  name?: string | null;
  /** Where `idea` came from (IdeaSource): the line under the box says so. */
  ideaSource?: IdeaSource;
  /**
   * #6019 follow-up: who a project made from a private thread's idea is for
   * (Just me, A group, A community), as the person answered there. Create
   * and the first session make it a private project otherwise.
   */
  audience?: CreateAudience;
  /**
   * #6784: the private thread New project was tapped in (Create, from a
   * thread with Homeroom bot). Sent with the brief, so the project is made
   * from the plan agreed there, not from a line of it.
   */
  threadRootId?: number | null;
}) {
  const t = useMessages('onboarding');
  const waitlistIdea = typeof idea === 'string' && idea.trim() ? idea : null;
  // #6781: a name handed in counts as theirs: it survives a tile picked later.
  const handedName = typeof startName === 'string' && startName.trim() ? startName.trim().slice(0, 60) : null;
  const fromCreate = entry === 'create';
  // At the allowance's limit (or a full server), Make it and Import it are
  // pale and the row above says why (the retired dialog's rule: never offer
  // a submit the server will refuse). Never pale for a missing answer.
  // #6842: `reason` says which limit it is, so the line names it truthfully.
  const { blocked: quotaBlocks, reason: quotaReason } = useAppAllowance();
  // Make it, or (from Create only) Import it.
  const [mode, setMode] = useState<'make' | 'import'>(fromCreate && startImport ? 'import' : 'make');
  // N9: Create's form as it was last left (keptDraft), read once at mount.
  // An idea handed in (a private thread's) wins over a kept draft; a name
  // handed in drops it before the screen mounts (forgetKeptDraft).
  const [draft] = useState(() => (fromCreate && !startImport && !waitlistIdea && keptDraft?.who === who ? keptDraft : null));
  const [brief, setBrief] = useState(draft ? draft.brief : waitlistIdea ?? '');
  const [name, setName] = useState(draft ? draft.name : handedName ?? '');
  // The tile picked: a template, Your own idea, or nothing yet.
  const [picked, setPicked] = useState<Template | typeof OWN_IDEA | null>(draft ? draft.picked : waitlistIdea ? OWN_IDEA : null);
  // S7: Your own idea PICKED (in the sheet, or the screen opening on an idea
  // handed in), which is what the fourth tile shows. Words written in the box
  // are `picked` Your own idea too, since they let go of a template, but
  // nothing was chosen: the tile keeps its name.
  const [ideaChosen, setIdeaChosen] = useState(draft ? !!draft.ideaChosen : !!waitlistIdea);
  // The template's choice, and their own words: in its blank, or the rest
  // of the game's sentence.
  const [choice, setChoice] = useState(draft ? draft.choice : '');
  const [words, setWords] = useState(draft ? draft.words : '');
  // "Write it yourself": the sentence it put in the plain box. The template
  // stays picked until they change those words.
  const [written, setWritten] = useState<string | null>(draft ? draft.written : null);
  // A name they typed: from then on a choice no longer suggests one. A name
  // handed in (#6781) counts as typed from the start.
  const [nameTyped, setNameTyped] = useState(draft ? draft.nameTyped : !!handedName);
  // Who can change it (#4666): You or the group, unless Change picked another.
  // Sent only when it is another, as the project's own governance block.
  const [rule, setRule] = useState<PresetKey>(draft ? draft.rule : DEFAULT_PRESET);
  // Kept when the screen goes, unless it went because the project was made.
  const formRef = useRef<MakeDraft | null>(null);
  formRef.current = fromCreate ? { brief, name, nameTyped, picked, choice, words, written, rule, ideaChosen } : null;
  const madeRef = useRef(false);
  const whoRef = useRef(who);
  whoRef.current = who;
  useEffect(() => () => {
    if (!fromCreate) return;
    const kept = madeRef.current ? null : draftWorthKeeping(formRef.current);
    keptDraft = kept ? { ...kept, who: whoRef.current } : null;
  }, [fromCreate]);
  // "Something else…" (./more-sheet.tsx), while it is up.
  const [sheetOpen, setSheetOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dictating, setDictating] = useState(false);
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
  // Their own words in a template: the field in its blank, or the game's box.
  const wordsFieldRef = useRef<HTMLInputElement>(null);
  const wordsBoxRef = useRef<HTMLTextAreaElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  // UNDER ITS LABEL: the description's top edge fades while it is scrolled.
  // Read on its scroll, and again after each render, since a box swapped in
  // or a shorter description can land it back at its top without a scroll.
  const [briefScrolled, setBriefScrolled] = useState(false);
  useEffect(() => { setBriefScrolled(briefFades(briefRef.current)); });
  // Home holds still under it, and takes no tap or focus (lib/page-lock.ts).
  // From Create the header and what stands above this screen stay in use, so
  // only the scrolling stops there.
  const rootRef = useRef<HTMLDivElement>(null);
  usePageLock(rootRef, { inert: !underHeader });
  // The caret for a hardware keyboard; on a phone the first tap raises the
  // keys (without iOS's pan: lib/keyboard-surface.ts takes that tap). A
  // touch screen gets no caret from code (#4597, the sign-in sheet's own
  // `mayFocusByCode`): in the Homeroom app's web view a field focused from
  // code raises the keyboard, and this screen opens whole, under no keys.
  useEffect(() => { if (mayFocusByCodeNow()) briefRef.current?.focus({ preventScroll: true }); }, []);
  // Taps on the fields without the pan, and the focused field (with Make it
  // when they fit) revealed inside the scroller once the keys are up.
  // #9: under the platform header the ✕ floats over the scroller's head.
  const head = underHeader ? MAKE_HEAD : 0;
  useKeyboardSurface(scrollerRef, { head });
  // MAKE IT IN VIEW (onboarding run two, 12 Oct 2026, iPhone 17 Safari): a
  // starting idea fills in its sentence and chips, the form grows, and Make
  // it went under Safari's toolbar. With the keys down, a pick brings the
  // description and Make it into view together, as the keyboard surface does
  // with the keys up. Safari draws this box only to the foot of its layout
  // viewport (`innerHeight` with the keys down), whatever runs on under the
  // toolbar (app.css), so that is where the view ends.
  const picks = useRef(0);
  useEffect(() => {
    if (picks.current++ === 0) return undefined;
    const raf = requestAnimationFrame(() => {
      const scroller = scrollerRef.current;
      if (!scroller || document.documentElement.classList.contains(KB_OPEN_CLASS)) return;
      const card = scroller.querySelector('[data-make-brief]');
      const button = scroller.querySelector('[data-make-submit]');
      if (!card || !button) return;
      revealField(scroller, card, button, head, window.innerHeight);
    });
    return () => cancelAnimationFrame(raf);
  }, [picked, choice, written, head]);
  // #16: FOLDED OR TURNED WITH A FIELD FOCUSED (iPhone Duo, 23 Nov 2026).
  // Folding to the cover while typing left the field behind the keys and the
  // heading cut in half: the screen is a different shape, and nothing showed
  // the field again. A change of the window's width is that, never a
  // keyboard, so once it has settled the focused field is revealed as a tap
  // on it would be, whatever was dragged before.
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    let width = window.innerWidth;
    let timer: number | null = null;
    const onResize = () => {
      if (window.innerWidth === width) return;
      width = window.innerWidth;
      if (timer != null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        const scroller = scrollerRef.current;
        const field = document.activeElement;
        if (!scroller || !field || !scroller.contains(field) || !field.matches('input, textarea')) return;
        revealField(scroller, field, scroller.querySelector('[data-make-submit]'), head);
      }, TURN_SETTLE_MS);
    };
    window.addEventListener('resize', onResize, { passive: true });
    return () => {
      window.removeEventListener('resize', onResize);
      if (timer != null) window.clearTimeout(timer);
    };
  }, [head]);
  // One frame on the wallpaper alone, so the rise has a start.
  const [arrived, setArrived] = useState(false);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setArrived(true));
    return () => cancelAnimationFrame(raf);
  }, []);
  // IT LEAVES THE WAY IT CAME (polish board #8, 19 Oct 2026). From Create,
  // ✕ and Escape unmounted it in the frame they were pressed in, after a
  // 300ms rise in: it vanished. Now the form falls back the way it rose and
  // the screen fades off what is under it, over MAKE_LEAVE_MS, and only then
  // does `onClose` take it away (the fade's transitionend, or a timer a
  // little past it). With reduced motion it goes at once.
  const [leaving, setLeaving] = useState(false);
  const leavingRef = useRef(false);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const leave = useCallback(() => {
    const close = closeRef.current;
    if (!close || leavingRef.current) return;
    leavingRef.current = true;
    const root = rootRef.current;
    const still = reducedMotion();
    if (still || !root) { close(); return; }
    let done = false;
    const gone = () => {
      if (done) return;
      done = true;
      root.removeEventListener('transitionend', onEnd);
      closeRef.current?.();
    };
    const onEnd = (e: TransitionEvent) => { if (e.target === root && e.propertyName === 'opacity') gone(); };
    root.addEventListener('transitionend', onEnd);
    window.setTimeout(gone, MAKE_LEAVE_MS + 80);
    // On the node, not in the render: React keeps only the ground it set.
    root.style.transition = `opacity ${MAKE_LEAVE_MS}ms ease-in`;
    root.style.opacity = '0';
    root.style.pointerEvents = 'none';
    setLeaving(true);
  }, []);
  const motion = arrived && !leaving ? ARRIVED : ARRIVING;
  // From Create, Escape closes it, as it closes a dialog; not while a sheet
  // is up over it ("Something else…"), whose Escape it is (lib/sheet.ts).
  useEffect(() => {
    if (!onClose) return undefined;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented && !openSheetCount()) leave(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, leave]);

  const template = picked && picked !== OWN_IDEA ? picked : null;
  // The fourth tile: a pick from "Something else…" (Your own idea, or one of
  // MORE) takes it over and opens the sheet again; until then it is the way in.
  // S7: Your own idea holds it only when it was picked, not when words were
  // written in the box (`ideaChosen`).
  const fourth: Template | typeof OWN_IDEA | null = picked === OWN_IDEA
    ? (ideaChosen ? OWN_IDEA : null)
    : template && MORE.includes(template) ? template : null;
  // The sentence is drawn until it is written out as plain text.
  const templated = !!template && written === null;
  const said = template ? sentence(template, choice, words) : null;
  // What Make it sends as the description: the sentence, or the plain box.
  const text = templated && said ? said.text : brief;
  // INSTANT OR CUSTOM: the line above Who can change it.
  const speed = makeSpeed(picked, choice, written, brief);
  // After the tap that drew it, the field for their words (or the plain box).
  const focusSoon = (field: () => HTMLElement | null) => {
    setTimeout(() => field()?.focus({ preventScroll: true }), 0);
  };
  const wordsField = () => wordsBoxRef.current || wordsFieldRef.current;

  const pickTemplate = useCallback((t: Template) => {
    if (picked === t && written === null) return;
    const first = firstChoice(t);
    setPicked(t);
    setIdeaChosen(false);
    setChoice(first);
    setWords('');
    setWritten(null);
    if (!nameTyped) setName(suggestedName(t, first, ''));
    setError(null);
    setMissing(null);
    if (first === OWN) focusSoon(wordsField);
  }, [picked, written, nameTyped]);

  const pickIdea = useCallback(() => {
    if (picked === OWN_IDEA && ideaChosen) return;
    // S7: a pick, which the fourth tile shows, even when words in the box
    // had already made the idea theirs.
    setIdeaChosen(true);
    if (picked !== OWN_IDEA) {
      setPicked(OWN_IDEA);
      setWritten(null);
      if (!nameTyped) setName('');
    }
    setError(null);
    setMissing(null);
    focusSoon(() => briefRef.current);
  }, [picked, ideaChosen, nameTyped]);

  const pickChoice = useCallback((key: string) => {
    if (!template) return;
    setChoice(key);
    if (!nameTyped) setName(suggestedName(template, key, words));
    setError(null);
    setMissing(null);
    if (key === OWN || template.finish) focusSoon(wordsField);
  }, [template, nameTyped, words]);

  const changeWords = (next: string) => {
    setWords(next);
    if (template && !nameTyped) setName(suggestedName(template, choice, next));
    setError(null);
    setMissing(null);
  };

  const writeOut = useCallback(() => {
    if (!said) return;
    setWritten(said.text);
    setBrief(said.text);
    setMissing(null);
    focusSoon(() => briefRef.current);
  }, [said]);

  const toName = (e: ReactKeyboardEvent<HTMLElement>) => {
    // Return goes on to the name, as the key says; Shift+Return is a new line.
    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    nameRef.current?.focus({ preventScroll: true });
  };

  const make = useCallback(async () => {
    if (dictating || busy || makingRef.current) return;
    const gap: Missing = templated && said?.blank ? 'blank' : missingAnswer(text, name);
    if (gap) {
      setMissing(gap);
      (gap === 'name' ? nameRef.current : templated ? wordsField() : briefRef.current)?.focus({ preventScroll: true });
      return;
    }
    makingRef.current = true;
    setBusy(true);
    setError(null);
    // The template's description, emoji and invite note while its sentence
    // is still the template's: words of their own in the plain box let go
    // of it (`picked` is Your own idea then), and are theirs to describe later.
    const example = template;
    // A choice that needs no typing, its sentence as drawn, is one of the
    // ready-made apps: it is made from that, with nothing for Homeroom bot
    // to build, so no brief.
    const ready = templated && example ? readyMadeOf(example, choice) : null;
    // A game preset starts the project from its working game: the brief is
    // still built, on it.
    const starter = templated && example ? starterOf(example, choice) : null;
    const timeZone = deviceTimeZone();
    try {
      const reply = await postCreateApp({
        name: name.trim(),
        audience,
        ...(ready ? { template: ready.template } : { brief: text.trim(), ...(starter ? { template: starter.template } : {}) }),
        // #6784: the thread the plan was agreed in, never with a ready-made
        // app (which has no brief to build from, and no thread to make).
        ...(threadRootId && !ready ? { thread: { rootId: threadRootId } } : {}),
        // A ready-made app's description is the choice's own line. A game or
        // Your own words is built from what they typed, so the line is only
        // the card's fallback: the model writes its tagline from their words
        // (services/app-sketch.js), and that becomes the description.
        ...(example ? { [ready ? 'description' : 'taglineFallback']: descriptionOf(example, choice) } : {}),
        ...(rule !== DEFAULT_PRESET ? { governance: { preset: rule } } : {}),
        from: entry,
        // So the sketch's "today" is the maker's (services/app-sketch.js).
        ...(timeZone ? { timeZone } : {}),
      });
      const data = (reply.ok ? reply.data : {}) as {
        app?: { slug?: string; name?: string }; homeroomBot?: { conversationId?: unknown }; exampleScreen?: unknown;
      };
      if (!reply.ok || !data.app?.slug) {
        setError(reply.ok ? translate('onboarding:firstSession.make.error.notMade') : reply.error);
        return;
      }
      madeRef.current = true;
      onMade({
        slug: data.app.slug,
        name: data.app.name || name.trim(),
        emoji: ready ? ready.emoji : example ? example.emoji : null,
        description: example ? descriptionOf(example, choice) : null,
        example,
        conversationId: Number(data.homeroomBot?.conversationId) || null,
        ...(ready ? { readyMade: true } : {}),
        ...(ready && typeof data.exampleScreen === 'string' && data.exampleScreen ? { exampleScreen: data.exampleScreen } : {}),
      });
    } finally {
      makingRef.current = false;
      setBusy(false);
    }
  }, [dictating, busy, templated, said, text, name, template, choice, rule, entry, onMade]);
  const needed = neededLine(missing, text, !!template?.finish);
  // The chips under the sentence: Your own… last, or first for the game.
  const ownChip = { key: OWN, label: 'onboarding:firstSession.make.ownChip' };
  const chips = !template ? [] : template.finish ? [ownChip, ...template.choices] : [...template.choices, ownChip];
  // The game's box shows an example of the rest: the starter's, or its own
  // (a message id: the box's whole placeholder).
  const boxExample = template ? (choice !== OWN && template.choices.find((c) => c.key === choice)?.example) || template.own.example : '';

  // The import, through the same request: a private community, as Make it
  // makes, from the repo; what it says about itself is its description.
  const importRepo = useCallback(async ({ repoUrl, name: repoName, manifest }: { repoUrl: string; name: string; manifest: RepoManifest }) => {
    const reply = await postCreateApp({ name: repoName, audience: 'invited', repoUrl, from: entry });
    const data = (reply.ok ? reply.data : {}) as { app?: { slug?: string; name?: string } };
    if (!reply.ok || !data.app?.slug) return reply.ok ? translate('onboarding:firstSession.import.error.notImported') : reply.error;
    madeRef.current = true;
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
  const formClass = `mx-auto flex w-full max-w-sm grow flex-col px-4 pb-[max(34px,env(safe-area-inset-bottom))] md:max-w-xl ${motion}`;
  // From Create, the allowance when it bears on Make it (the New project
  // dialog's quiet row, #23): a returning maker can be at their limit, a new
  // account never is. The wrapper goes with it when there is nothing to say.
  // Every other door has no card: it says the one line (#6842) instead, so
  // a pale Make it or Import it is never pale with nothing to explain it.
  const allowance = fromCreate
    ? <div className="mt-4 empty:hidden"><AppAllowance id="make-app-quota" surface="pane" quiet /></div>
    : quotaReason
      ? <p data-make-blocked={quotaReason} className="mt-3 text-[14px] text-red-700 dark:text-red-400">{t(BLOCKED_LINE[quotaReason])}</p>
      : null;

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-labelledby="first-session-make-title"
      data-first-session-make=""
      data-make-entry={entry}
      className={underHeader ? MAKE_ROOT_UNDER_HEADER : MAKE_ROOT}
      style={{ background: 'var(--home-wallpaper, #fffeea)' }}
    >
      {/* Stays put over the scroller, so nothing scrolls under the status bar.
          At least 32px tall under the status bar's inset, so the whole mark
          is inside it and what scrolls stops below the mark, not beside it.
          From Create, ✕ at its leading edge closes the screen. Under the
          platform header the header is the top of the screen: this bar is
          only the ✕, with no mark of its own and no inset to clear, and it
          takes no room (#9): the ✕ floats over the scroller's head, which
          is padded by MAKE_HEAD and fades what scrolls up under it. */}
      <div className={underHeader ? `relative z-10 h-0 shrink-0 ${motion}` : `relative flex h-[max(52px,calc(env(safe-area-inset-top)+32px))] shrink-0 items-center justify-center pt-[env(safe-area-inset-top)] ${motion}`}>
        {onClose ? (
          <button
            type="button"
            data-make-close=""
            onClick={leave}
            aria-label={t('core:common.close')}
            className={`absolute start-3 flex h-9 w-9 items-center justify-center rounded-full bg-white text-zinc-500 shadow-[inset_0_0_0_1px_var(--app-sheet-line)] dark:bg-zinc-900 dark:text-zinc-400 ${underHeader ? 'top-2' : 'bottom-1'}`}
          >
            <XIcon className="h-4 w-4" aria-hidden="true" />
          </button>
        ) : null}
        {underHeader ? null : <Wordmark className="h-6 w-auto text-zinc-950 dark:text-white" />}
      </div>
      {/* The scroller the keyboard surface reveals fields in. Its className
          stays constant: nothing here varies it. Under the platform header
          its head is the ✕'s (app.css, the root's `platform-under-header`). */}
      <div ref={scrollerRef} data-first-session-make-scroll="" className="flex min-h-0 grow flex-col overflow-y-auto">
        {mode === 'import' ? (
          <ImportForm
            className={formClass}
            header={(
              <div className="text-center">
                <h1 id="first-session-make-title" className="mt-2.5 text-balance text-[30px] font-extrabold leading-[34px]">{t(IMPORT_TITLE)}</h1>
                <p className="mt-2.5 text-pretty text-[16px] leading-[22px] text-zinc-500 dark:text-zinc-400">{t(IMPORT_LINE)}</p>
              </div>
            )}
            submit={importRepo}
            blocked={quotaBlocks}
            onDescribe={() => { setMode('make'); setTimeout(() => briefRef.current?.focus({ preventScroll: true }), 0); }}
            allowance={allowance}
          />
        ) : (
        <form
          className={`mx-auto flex w-full max-w-sm grow flex-col px-4 pb-[max(34px,env(safe-area-inset-bottom))] md:max-w-xl ${motion}`}
          onSubmit={(e) => { e.preventDefault(); void make(); }}
        >
          <div className="text-center">
            <h1 id="first-session-make-title" className="mt-2.5 text-balance text-[30px] font-extrabold leading-[34px]">{makeTitle(entry, who)}</h1>
            {/* #5266: the first session's, not New project's: someone who has
                just come in has not seen this screen before. Props only, so
                the prerender and the hydration say the same. */}
            {fromCreate ? null : (
              <p data-make-welcome="" className="mt-2.5 text-pretty text-[16px] leading-[22px] text-zinc-500 dark:text-zinc-400">{t('onboarding:firstSession.make.welcome')}</p>
            )}
          </div>
          <p className="mt-6 pb-2 text-[13px] text-zinc-500 dark:text-zinc-400">{t('onboarding:firstSession.make.startFromIdea')}</p>
          <div className="grid grid-cols-2 gap-2" role="group" aria-label={t('onboarding:firstSession.make.ideasLabel')}>
            {FRONT.map((example) => {
              const on = picked === example;
              return (
                <button
                  key={example.key}
                  type="button"
                  aria-pressed={on}
                  data-first-session-example={example.key}
                  onClick={() => pickTemplate(example)}
                  className={`${TILE} ${on ? TILE_ON : TILE_OFF}`}
                >
                  <span className="app-icon-tile flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-2xl" aria-hidden="true">{example.chart ? <TierChart /> : example.emoji}</span>
                  <span className="text-[15px] font-[650] leading-tight">{t(example.short)}</span>
                </button>
              );
            })}
            {/* SOMETHING ELSE (Evan, 15 Oct 2026): the fourth tile opens the
                sheet with Your own idea and the rest (./more-sheet.tsx). A
                pick there takes the tile over, chevron and all, so the grid
                always shows what is chosen and one tap opens the list again.
                Its glyph is four of what is behind it. */}
            <button
              type="button"
              aria-pressed={!!fourth}
              aria-haspopup="dialog"
              data-first-session-example={fourth ? (fourth === OWN_IDEA ? OWN_IDEA : fourth.key) : MORE_TILE}
              onClick={() => setSheetOpen(true)}
              className={`${TILE} ${fourth ? TILE_ON : TILE_OFF}`}
            >
              <span className="app-icon-tile flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-2xl" aria-hidden="true">
                {fourth === OWN_IDEA ? '💡' : fourth ? (fourth.chart ? <TierChart /> : fourth.emoji) : (
                  <span className="grid grid-cols-2 gap-0.5 text-[14px] leading-4">
                    {MORE.slice(0, 4).map((m) => <span key={m.key}>{m.emoji}</span>)}
                  </span>
                )}
              </span>
              <span className="min-w-0 flex-1 text-[15px] font-[650] leading-tight">
                {fourth === OWN_IDEA ? t('onboarding:firstSession.make.ownIdea') : fourth ? t(fourth.short) : t('onboarding:firstSession.make.somethingElse')}
              </span>
              {fourth ? <ChevronDownIcon className="h-4 w-4 shrink-0 text-zinc-500 dark:text-zinc-400" aria-hidden="true" /> : null}
            </button>
          </div>
          <div data-make-brief="" className="mt-4 overflow-hidden rounded-2xl bg-white shadow-[inset_0_0_0_1px_var(--app-sheet-line)] dark:bg-zinc-900">
            <div className={FIELD}>
              {templated && template && said ? (
                <>
                  <div className="flex items-baseline justify-between gap-3">
                    <span className={LABEL}>{t('onboarding:firstSession.make.briefLabel')}</span>
                    {template.finish ? null : (
                      <button
                        type="button"
                        data-make-write-out=""
                        onClick={writeOut}
                        className="shrink-0 text-[13px] font-medium text-violet-700 hover:underline dark:text-violet-400"
                      >
                        {t('onboarding:firstSession.make.writeItYourself')}
                      </button>
                    )}
                  </div>
                  <p data-make-sentence={template.key} className="pt-1 text-[17px] leading-7 text-zinc-900 dark:text-zinc-100">
                    {said.head}
                    {template.finish
                      ? (said.fill ? <span className={BLANK}>{said.fill}</span> : null)
                      : choice === OWN
                        ? (
                          <input
                            ref={wordsFieldRef}
                            id="make-words"
                            type="text"
                            autoComplete="off"
                            enterKeyHint="next"
                            maxLength={60}
                            value={words}
                            aria-label={t('onboarding:firstSession.make.ownWordsLabel')}
                            onChange={(e) => changeWords(e.target.value)}
                            onKeyDown={toName}
                            placeholder={t(template.own.example)}
                            className={BLANK_FIELD}
                          />
                        )
                        : <span className={BLANK}>{said.fill}</span>}
                    {said.tail}
                  </p>
                  {template.finish ? (
                    <>
                      <label htmlFor="make-words" className="mt-3 flex items-center gap-1.5 text-[13px] font-semibold text-violet-700 dark:text-violet-400">
                        <PencilSquareIcon className="h-3.5 w-3.5" aria-hidden="true" />
                        {t('onboarding:firstSession.make.finishLabel')}
                      </label>
                      <textarea
                        ref={wordsBoxRef}
                        id="make-words"
                        rows={2}
                        // Room for the sentence around it, under the server's ceiling.
                        maxLength={BRIEF_MAX - 200}
                        value={words}
                        enterKeyHint="next"
                        aria-describedby={missing === 'blank' ? 'first-session-brief-needed' : undefined}
                        onChange={(e) => changeWords(e.target.value)}
                        onKeyDown={toName}
                        placeholder={t(boxExample)}
                        className={`${WORDS_BOX} ${words.trim() ? WORDS_FILLED : WORDS_EMPTY}`}
                      />
                    </>
                  ) : null}
                  <div className="mb-1 mt-3 flex flex-wrap gap-1.5" role="group" aria-label={t('onboarding:firstSession.make.choicesLabel')}>
                    {chips.map((c) => (
                      <Chip
                        key={c.key}
                        size="bar"
                        selected={choice === c.key}
                        data-make-choice={c.key}
                        onClick={() => pickChoice(c.key)}
                        className={choice === c.key ? 'px-3' : `px-3 ${TILE_OFF}`}
                      >
                        {t(c.label)}
                      </Chip>
                    ))}
                  </div>
                </>
              ) : (
                <>
                  <label htmlFor="first-session-brief" className={LABEL}>{t('onboarding:firstSession.make.briefLabel')}</label>
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
                      // Words of their own: the idea is theirs now. Your own
                      // idea is marked, and a template lets go.
                      if (picked !== OWN_IDEA && next !== written) {
                        setPicked(OWN_IDEA);
                        setWritten(null);
                      }
                      setError(null);
                      setMissing(null);
                    }}
                    onKeyDown={toName}
                    onScroll={(e) => setBriefScrolled(briefFades(e.currentTarget))}
                    placeholder={t('onboarding:firstSession.make.briefPlaceholder')}
                    className={`${BRIEF_INPUT}${briefScrolled ? ` ${BRIEF_FADE}` : ''} resize-none leading-[22px]`}
                  />
                  {threadRootId ? <p data-make-thread-idea="" className={HINT}>{t(THREAD_IDEA_LINE)}</p> : null}
                  {waitlistIdea && brief === waitlistIdea && ideaSource === 'waitlist' ? <p data-make-waitlist-idea="" className={HINT}>{t(WAITLIST_IDEA_LINE)}</p> : null}
                  {waitlistIdea && brief === waitlistIdea && ideaSource === 'search' ? <p data-make-search-idea="" className={HINT}>{t(SEARCH_IDEA_LINE)}</p> : null}
                </>
              )}
              <div className="flex justify-end">
                <SpeakButton scope={`make:${mode}:${template?.key || 'idea'}:${written === null ? choice : 'written'}`} disabled={busy || mode !== 'make'} onBusyChange={setDictating}
                  getText={() => templated ? words : brief} maxLength={templated ? template?.finish ? BRIEF_MAX - 200 : 60 : BRIEF_MAX}
                  onText={(next) => {
                    if (templated) { setChoice(OWN); changeWords(next); if (template && !nameTyped) setName(suggestedName(template, OWN, next)); }
                    else { setBrief(next); setPicked(OWN_IDEA); setWritten(null); setError(null); setMissing(null); }
                  }} />
              </div>
              {missing === 'brief' || missing === 'blank' ? <p id="first-session-brief-needed" role="alert" className={NEEDED}>{needed}</p> : null}
            </div>
            <div className={FIELD}>
              <label htmlFor="first-session-name" className={LABEL}>{t('onboarding:firstSession.make.nameLabel')}</label>
              <input
                ref={nameRef}
                id="first-session-name"
                type="text"
                autoComplete="off"
                enterKeyHint="go"
                value={name}
                aria-describedby={missing === 'name' ? 'first-session-name-hint' : undefined}
                onChange={(e) => {
                  setName(e.target.value);
                  // A name of their own stays; an emptied one follows the choice again.
                  setNameTyped(e.target.value.trim() !== '');
                  setError(null);
                  setMissing(null);
                }}
                placeholder={t(template ? template.namePlaceholder : 'onboarding:firstSession.make.namePlaceholderOwn')}
                className={INPUT}
              />
              {missing === 'name' ? <p id="first-session-name-hint" role="alert" className={NEEDED}>{needed}</p> : null}
            </div>
          </div>
          {/* INSTANT OR CUSTOM: one line, drawn as the rule line under it is
              (its inks, icon size and inset), a step larger, with no colour
              of its own. It is one line from 390px wide; narrower, it wraps
              without leaving one word on its own.
              ITS ROOM IS KEPT (S7, 23 Nov 2026): the line used to arrive with
              the first word typed and push Make it down under the finger.
              Both lines are laid out in one cell, the one that applies shown
              and the other holding its place unseen, so the slot is as tall
              as the taller of the two at this width from the start, and
              nothing under it moves when a line comes, goes or changes. */}
          <div data-make-speed-slot="" className="mt-3 grid">
            {(['instant', 'custom'] as const).map((key) => (
              <p
                key={key}
                data-make-speed={speed === key ? key : undefined}
                aria-hidden={speed === key ? undefined : true}
                className={`col-start-1 row-start-1 flex items-center gap-2 px-1 text-[14px] leading-[1.4] text-zinc-600 dark:text-zinc-300${speed === key ? '' : ' invisible'}`}
              >
                {key === 'instant'
                  ? <BoltIcon className="h-4 w-4 shrink-0 text-zinc-500 dark:text-zinc-400" aria-hidden="true" />
                  : <SparklesIcon className="h-4 w-4 shrink-0 text-zinc-500 dark:text-zinc-400" aria-hidden="true" />}
                <span className="min-w-0 text-pretty">
                  <RichMessage id={SPEED_LINE[key]} components={[<b className="font-semibold text-zinc-900 dark:text-zinc-100" />]} />
                </span>
              </p>
            ))}
          </div>
          <MakeRuleLine preset={rule} onPick={setRule} who={who} />
          {allowance}
          {error ? <p role="alert" className="mt-3 text-[14px] text-red-700 dark:text-red-400">{error}</p> : null}
          {/* #5266: no spacer here any more: Make it follows the rule line,
              and the form's leftover space stays under "Look around first". */}
          <Button
            type="submit"
            data-make-submit=""
            disabled={dictating || busy || quotaBlocks}
            layout="full"
            variant="pillAccent"
            size="pillLg"
            ink="solidLate"
            className="mt-6 flex items-center justify-center disabled:opacity-50"
          >
            {busy ? t('onboarding:firstSession.make.making') : t('onboarding:firstSession.make.submit')}
          </Button>
          {fromCreate ? (
            // Small, under Make it: the one other way to start a project.
            <p className="mt-3 text-center">
              <button
                type="button"
                data-make-import-link=""
                onClick={() => setMode('import')}
                className="text-[13px] font-medium text-violet-700 hover:underline dark:text-violet-400"
              >
                {t('onboarding:firstSession.make.importLink')}
              </button>
            </p>
          ) : (
            <p className="mt-3 text-center text-[15px] text-zinc-500 dark:text-zinc-400">
              <RichMessage
                id="onboarding:firstSession.make.lookAround"
                components={[<button type="button" onClick={onLookAround} className="font-medium text-violet-700 hover:underline dark:text-violet-400" />]}
              />
            </p>
          )}
          {/* HELD WHILE IT MAKES (onboarding run two): pressed with the keys up,
              the keys went down, the scroller grew past what it could scroll,
              and the form snapped back to its top, "Making it…" out of sight,
              until the made screen came. Room after the form while it makes
              keeps the scroller where it was, so the press stays in view. */}
          {busy ? <div aria-hidden="true" data-make-hold="" className="h-[60vh] shrink-0" /> : null}
        </form>
        )}
      </div>
      {sheetOpen && typeof document !== 'undefined'
        ? createPortal(
          <MoreSheet
            picked={fourth}
            onPick={(next) => { setSheetOpen(false); pickTemplate(next); }}
            onPickIdea={() => { setSheetOpen(false); pickIdea(); }}
            onClose={() => setSheetOpen(false)}
          />,
          document.body,
        )
        : null}
    </div>
  );
}
