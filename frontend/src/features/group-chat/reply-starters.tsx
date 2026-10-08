/**
 * Reply chips over a project's group chat composer, for somebody who has not
 * said anything there yet.
 *
 * ── What they are for ─────────────────────────────────────────────────
 *
 * The first-session plan (path A, "I was invited"): the group chat is not
 * blank, it already holds the maker's own words (their invite note, posted
 * as their first message), and the newcomer is prompted to say something
 * back. So the chips show when someone else has spoken and the viewer has
 * not: at least one message from another person among the rows, and none of
 * the viewer's. They go the moment the viewer's first message lands, which
 * the transcript store carries like any other row. The quiet card
 * (./quiet-card.tsx) is the other half: it is the prompt when NOBODY has
 * spoken, so the two never show together.
 *
 * A tap PUTS THE WORDS IN THE BOX, focused with the caret at the end, to be
 * finished or sent; it never sends. That is what Homeroom bot's suggested
 * replies do (features/agent-session/index.tsx `Replies`, #3033), and these
 * wear the same pill.
 *
 * ── Whether "never posted" can be known ──────────────────────────────
 *
 * Only from rows that are loaded. The quiet card's `exhausted` fact (the
 * module has paged history back to the beginning) is what makes it honest:
 * with older pages unread the viewer may have posted in one of them, and a
 * member of a busy channel should not be asked to say hi. A newcomer's first
 * visit to a new group's chat is one short page. `canPost` keeps them off a
 * read-only view, which has no composer anyway.
 *
 * ── Ownership ─────────────────────────────────────────────────────────
 *
 * Drawn inside ./general-chat.tsx's composer bar, a subtree no module writes
 * into, and it renders from ./transcript-store.ts, which group-chat.js
 * publishes. The textarea stays the module's: a tap writes its value the way
 * restoring a draft does and fires `input`, so the module's own listener
 * saves the draft and grows the field.
 */

import { useState } from 'react';

import { useStoreState } from '../../lib/use-store-state';
import { transcriptStore, type TranscriptView } from './transcript-store';

export const REPLY_STARTERS: readonly { label: string; text: string }[] = [
  { label: '\u{1F44B} Hi!', text: '\u{1F44B} Hi!' },
  { label: 'Love it!', text: 'Love it!' },
  // Started, not finished: the caret waits after the space.
  { label: 'Could it also…', text: 'Could it also ' },
];

/** Whether the general chat's transcript calls for the chips (see the header). */
export function startersDue(view: TranscriptView | undefined | null): boolean {
  const quiet = view?.lead?.quiet;
  if (!view || !quiet || !quiet.exhausted || !quiet.canPost) return false;
  let theirs = false;
  for (const m of view.messages) {
    if (m.kind !== 'message') continue;
    if (m.mine) return false;
    if (!m.deleted) theirs = true;
  }
  return theirs;
}

/** Put a chip's words in the general composer, focused, caret at the end. */
export function startReply(text: string, doc: Document | null = typeof document === 'undefined' ? null : document): void {
  const input = doc?.getElementById('gc-input') as HTMLTextAreaElement | null | undefined;
  if (!input) return;
  input.value = text;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.focus();
  try { input.setSelectionRange(text.length, text.length); } catch { /* not a text field */ }
}

const CHIP = 'shrink-0 rounded-full border border-violet-200 bg-white px-3 py-1.5 text-sm text-violet-700 hover:bg-violet-50 dark:border-violet-800 dark:bg-zinc-900 dark:text-violet-300 dark:hover:bg-violet-950/40';

export function ReplyStartersView({ onPick }: { onPick: (text: string) => void }) {
  return (
    <div role="group" aria-label="Start a reply" className="flex gap-2 overflow-x-auto pb-2" data-gc-reply-starters="">
      {REPLY_STARTERS.map(({ label, text }) => (
        <button key={label} type="button" className={CHIP} data-gc-reply-starter="" onClick={() => onPick(text)}>
          {label}
        </button>
      ))}
    </div>
  );
}

export function ReplyStarters() {
  const view = useStoreState(transcriptStore).byKey.main;
  // The view in the store when this composer mounted may be the LAST
  // channel's: the store keeps its rows until group-chat.js publishes this
  // one's (GroupChat.render, which every mount of the pane is followed by:
  // at once for a channel already open, after the history page for a new
  // one). Only a view published since is this channel's.
  const [atMount] = useState(view);
  if (view === atMount || !startersDue(view)) return null;
  return <ReplyStartersView onPick={(text) => startReply(text)} />;
}
