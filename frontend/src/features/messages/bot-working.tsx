import { WorkingDots } from '@/components/ui/chat';

import { useMessages } from '../../lib/i18n/react';
import { UserAvatar } from './format';
import type { BotDoing, Typist } from './store';

/*
 * THE BOT AT WORK (1 November 2026). "Homeroom bot should say when it's
 * thinking or working on something, with a card, not just be quiet." An
 * answer from the bot can take minutes (it reads requests, the project's
 * code, draws a screen), and all it showed was "Homeroom bot is typing…" in
 * the thin status line under the transcript.
 *
 * So while the bot is typing in the place on screen (a conversation's main
 * chat or one of its threads, store.ts `typingUsers`), the transcript ends
 * on this card, where its answer will appear: the bot's face as its rows
 * draw it, its name over what it says it is doing (its typing event's
 * `doing`, services/homeroom-bot-dm.js typingDoing) or "Thinking", and the
 * breathing dots as the ellipsis. The words are this catalog's, by the
 * kind the server names. People typing keep the status line.
 *
 * It goes when the typing does, by the store's own rules: a stop that
 * arrives while the answer it typed is still being read holds the card
 * until that answer is drawn (`heldTyping`), so the card gives way to the
 * answer with no gap and no frame of both.
 *
 * Laid out as a bot row in a direct message is (`.messages-message-bubble`:
 * 4px 16px, the face, 12px, the bubble): a card in the bubble's surface
 * with one hairline, rows 15 over 13 (ListRow's pair). It renders nothing
 * of its own until the store says the bot is typing, so a first render is
 * the empty transcript it always was.
 */

type Translate = (id: string, values?: Record<string, unknown>) => string;

/** The Homeroom bot among those typing in a place, or null. */
export function workingBot(typing: readonly Typist[]): Typist | null {
  return typing.find((entry) => entry.bot) || null;
}

/** Those typing, less the bot whose card stands in for its name (`working`): the status line's names. */
export function typingBesides(typing: readonly Typist[], working: Typist | null): readonly Typist[] {
  return working ? typing.filter((entry) => entry !== working) : typing;
}

// Message ids by the kind of work the bot names (homeroom-bot-dm.js DOING_KINDS).
const DOING_WORDS: Record<string, string> = {
  progress: 'messages:thread.botWorking.progress',
  drawing: 'messages:thread.botWorking.drawing',
  designing: 'messages:thread.botWorking.designing',
  drafting: 'messages:thread.botWorking.drafting',
};

/** What the card says the bot is doing: "Reading request #12", or "Thinking" for nothing (or a kind it does not know). */
export function botDoingLine(t: Translate, doing: BotDoing | null | undefined): string {
  if (doing?.kind === 'request' && doing.number) return t('messages:thread.botWorking.request', { number: doing.number });
  if (doing?.kind === 'code') {
    return doing.project ? t('messages:thread.botWorking.code', { project: doing.project }) : t('messages:thread.botWorking.codeUnnamed');
  }
  return t((doing && DOING_WORDS[doing.kind]) || 'messages:thread.botWorking.thinking');
}

export function BotWorkingCard({ typist }: { typist: Typist }) {
  const t = useMessages('messages');
  return (
    <div className="flex items-start gap-3 px-4 py-1" data-bot-working={typist.doing?.kind || 'thinking'}>
      <UserAvatar user={{ id: 0, username: typist.name, bot: true }} size="md" shape="square" />
      <div className="min-w-0 max-w-[78%] rounded-[20px] bg-[color:var(--messages-surface)] px-4 py-2 shadow-[inset_0_0_0_1px_var(--app-sheet-line)]">
        <div className="truncate text-[0.9375rem] font-[650] leading-5 text-zinc-900 dark:text-zinc-100">{typist.name}</div>
        <div className="mt-0.5 flex min-w-0 items-center text-[0.8125rem] leading-[1.125rem] text-zinc-500 dark:text-zinc-400">
          <span className="min-w-0 truncate" data-bot-working-doing="">{botDoingLine(t, typist.doing)}</span>
          <WorkingDots />
        </div>
      </div>
    </div>
  );
}
