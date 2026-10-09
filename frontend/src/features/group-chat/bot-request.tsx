import { useMessages } from '../../lib/i18n/react';
import { t as translate } from '../../lib/i18n/runtime';
import { waitingWords } from '../messages/approval-words';
import type { BotRequestCard, BotRequestChip, BotRequestState } from './transcript-store';

/*
 * B9: a request asked of Homeroom bot in a project's chat, on the message
 * that asked it (services/homeroom-bot-chat.js). WP-C: or an idea of a
 * newcomer's, which their card offers to suggest to the group.
 *
 * THE CHIP is what everybody in the room sees, first in the message's
 * reactions row: its status, set by the server alone, never a reaction
 * anybody can add or toggle, in the bot's own periwinkle rather than the
 * accent a reaction of yours wears. An emoji and a sentence that says who has
 * the message and what it is doing ("Homeroom bot is looking at this"), so
 * the room can tell from the chip alone that the bot took it. It said one
 * word ("👀 Reading") until 5 October 2026, when the person who suggested an
 * idea read it as part of their private card and asked for the group to be
 * told the bot had it (CHIP_WORDS). Ready is a Try it chip that opens the
 * change's preview for anyone. When the work stops the chip goes; the
 * requester's card and their chat with the bot say why.
 *
 * THE CARD is under the requester's own message only, "Only you can see
 * this": what was taken from it and how long it usually takes, or the
 * question it asks first. It is read from their own requests, never from the
 * room's messages, so nobody else's transcript can hold it. Just after a
 * request is filed it also says that the chip is everybody's
 * (chat:group.botCard.shared).
 *
 * The card follows its request (`state`, read from the platform's records
 * each time the card is: homeroom-bot-chat.js cardsOf): building, built and
 * testing, built and waiting for approval (from whom, with Try it), live,
 * or what stopped it. A fix asked on one of the bot's changes still waiting
 * for approval (`revise`) says it goes into that change, and follows it the
 * same way. Its chip, Fixing, is everybody's: the fix was asked in public.
 *
 * A request filed while its project's first version is not live waits for
 * it (`waiting_first_version`, homeroom-bot.js firstVersionHolds): the card
 * says so in the DM's words, and the chip says Homeroom bot has it, never
 * that it is looking at it.
 */

// `max-w-full`: on a narrow phone a sentence wraps inside the chip rather
// than running past the message.
const CHIP_CLASS = 'inline-flex max-w-full items-center gap-1 rounded-full bg-[color:var(--brand-tint)] px-2.5 py-0.5 text-left text-[0.8125rem] font-semibold text-[color:var(--brand-ink)]';

/**
 * What each chip says (`words`), and what a screen reader hears (`said`)
 * when the words alone leave out who has it or why it waits. Every chip but
 * Live names Homeroom bot: the room learns from it that the bot has the
 * message. Each fits on one line under a message on a 390px phone.
 */
// `words` and `said` are message ids (frontend/locales/en/chat.json), read
// when the chip renders.
export const CHIP_WORDS: Readonly<Record<Exclude<BotRequestChip['status'], 'ready'>, { glyph: string; words: string; said?: string }>> = Object.freeze({
  reading: { glyph: '👀', words: 'chat:group.botChip.reading' },
  building: { glyph: '🔨', words: 'chat:group.botChip.building' },
  fixing: { glyph: '🔧', words: 'chat:group.botChip.fixing' },
  waiting_first_version: {
    glyph: '⏳',
    words: 'chat:group.botChip.hasThis',
    said: 'chat:group.botChip.hasThisSaid',
  },
  live: { glyph: '✅', words: 'chat:group.botChip.live', said: 'chat:group.botChip.liveSaid' },
});

/** Pure: what a screen reader hears for a chip (the Try it button says Try it). */
export function chipLabel(status: Exclude<BotRequestChip['status'], 'ready'>): string {
  const { words, said } = CHIP_WORDS[status];
  return translate(said || words);
}

export function BotStatusChip({ chip, mine = false, onTry, onProgress }: {
  chip: BotRequestChip;
  mine?: boolean;
  onTry?: (sessionId: number) => void;
  /** The requester's own chip opens their chat with the bot, where the progress is. */
  onProgress?: () => void;
}) {
  const t = useMessages('chat');
  if (chip.status === 'ready') {
    return (
      <button
        type="button"
        className={CHIP_CLASS}
        data-bot-request={chip.status}
        disabled={!chip.sessionId}
        onClick={() => { if (chip.sessionId) onTry?.(chip.sessionId); }}
      >
        <span aria-hidden="true">▶</span>
        <span>{t('chat:group.botChip.tryIt')}</span>
      </button>
    );
  }
  const { glyph, words } = CHIP_WORDS[chip.status];
  const label = chipLabel(chip.status);
  return mine ? (
    <button type="button" className={CHIP_CLASS} data-bot-request={chip.status} aria-label={label} onClick={() => onProgress?.()}>
      <span aria-hidden="true">{glyph}</span>
      <span>{t(words)}</span>
    </button>
  ) : (
    <span className={CHIP_CLASS} data-bot-request={chip.status} aria-label={label}>
      <span aria-hidden="true">{glyph}</span>
      <span>{t(words)}</span>
    </span>
  );
}

// The stages at which a filed request's card still says "Got it": the bot
// has it and has not started building. Its chip names the bot for the room.
const JUST_FILED = new Set(['waiting_first_version', 'reading', 'waiting']);

/**
 * Pure: whether a card says that the room can see the bot has it
 * (chat:group.botCard.shared). The card is theirs alone, but the chip on
 * their message is the room's. 5 October 2026: an idea suggested with
 * Suggest it read as if it had stayed private.
 */
export function sharedNow(card: BotRequestCard): boolean {
  return card.kind === 'filed' && !!card.issueNumber && (!card.state?.stage || JUST_FILED.has(card.state.stage));
}

/**
 * Pure: who a built change still waits on, in the DM's ready card's words
 * (../messages/approval-words.ts, as ../messages/bot-ready.tsx waitingLine
 * says it): "Waiting for approval from you and @jordan." when it needs every
 * one of them, "Needs one more approval from @priya or @mo." when any of
 * them will do, and nobody named once it has the approvals it needs.
 */
export function approvalWords(state?: BotRequestState): string {
  if (state?.missing === 0) return translate('chat:group.botCard.approval.has');
  // The card's own sentences, each with its full stop (`sentence`).
  const words = waitingWords({
    you: !!state?.youApprove, names: state?.waitingOn || [], more: state?.more, missing: state?.missing, needed: state?.needed,
  }, 'sentence');
  return words || translate('chat:group.botCard.approval.waiting');
}

/**
 * Pure: a request the bot builds, where it stands. Every sentence is a whole
 * message; one that names the request has a second wording for a request
 * with no title.
 */
function filedWords(card: BotRequestCard): string {
  const title = card.title;
  const say = (titled: string, untitled: string, values: Record<string, string | number> = {}) => (
    title ? translate(titled, { ...values, title }) : translate(untitled, values)
  );
  switch (card.state?.stage) {
    // What a request held for its project's first version waits for (the DM card's words).
    case 'waiting_first_version': return say('chat:group.botCard.filed.firstVersionWait', 'chat:group.botCard.filed.firstVersionWaitUntitled');
    case 'waiting': return say('chat:group.botCard.filed.waitingBuilder', 'chat:group.botCard.filed.waitingBuilderUntitled');
    case 'building': return say('chat:group.botCard.filed.building', 'chat:group.botCard.filed.buildingUntitled');
    case 'question': return translate('chat:group.botCard.filed.question');
    case 'checking': return say('chat:group.botCard.filed.checking', 'chat:group.botCard.filed.checkingUntitled');
    case 'proposed': return say('chat:group.botCard.filed.proposed', 'chat:group.botCard.filed.proposedUntitled', { approval: approvalWords(card.state) });
    case 'approved': return say('chat:group.botCard.filed.approved', 'chat:group.botCard.filed.approvedUntitled');
    case 'live': return say('chat:group.botCard.filed.live', 'chat:group.botCard.filed.liveUntitled');
    case 'closed': return say('chat:group.botCard.filed.closed', 'chat:group.botCard.filed.closedUntitled');
    case 'person': return translate('chat:group.botCard.filed.person');
    case 'stopped': return translate('chat:group.botCard.filed.stopped');
    default:
      return card.typicalMinutes
        ? say('chat:group.botCard.filed.gotItMinutes', 'chat:group.botCard.filed.gotItMinutesUntitled', { count: Number(card.typicalMinutes) })
        : say('chat:group.botCard.filed.gotIt', 'chat:group.botCard.filed.gotItUntitled');
  }
}

// Every stage filedWords has a sentence of its own for; any other stage
// reads as a request just taken.
const FILED_STAGES = new Set(['waiting_first_version', 'waiting', 'building', 'question', 'checking', 'proposed', 'approved', 'live', 'closed', 'person', 'stopped']);

// The stages of a filed request whose card also says, on a person's first
// request (WP-C), that it stays in the project's requests under their name.
const STAYS_STAGES = new Set(['waiting_first_version', 'waiting', 'building']);

/**
 * A fix sent to one of the bot's changes, where it stands: for each stage,
 * the message that names the change as the first version, by its title, or
 * (with no title) as "that change".
 */
const REVISE_WORDS: Readonly<Record<string, readonly [firstVersion: string, titled: string, untitled: string]>> = Object.freeze({
  checking: ['chat:group.botCard.revise.checking.firstVersion', 'chat:group.botCard.revise.checking.titled', 'chat:group.botCard.revise.checking.untitled'],
  proposed: ['chat:group.botCard.revise.proposed.firstVersion', 'chat:group.botCard.revise.proposed.titled', 'chat:group.botCard.revise.proposed.untitled'],
  asked: ['chat:group.botCard.revise.asked.firstVersion', 'chat:group.botCard.revise.asked.titled', 'chat:group.botCard.revise.asked.untitled'],
  answered: ['chat:group.botCard.revise.answered.firstVersion', 'chat:group.botCard.revise.answered.titled', 'chat:group.botCard.revise.answered.untitled'],
  person: ['chat:group.botCard.revise.person.firstVersion', 'chat:group.botCard.revise.person.titled', 'chat:group.botCard.revise.person.untitled'],
  approved: ['chat:group.botCard.revise.approved.firstVersion', 'chat:group.botCard.revise.approved.titled', 'chat:group.botCard.revise.approved.untitled'],
  live: ['chat:group.botCard.revise.live.firstVersion', 'chat:group.botCard.revise.live.titled', 'chat:group.botCard.revise.live.untitled'],
  closed: ['chat:group.botCard.revise.closed.firstVersion', 'chat:group.botCard.revise.closed.titled', 'chat:group.botCard.revise.closed.untitled'],
  stopped: ['chat:group.botCard.revise.stopped.firstVersion', 'chat:group.botCard.revise.stopped.titled', 'chat:group.botCard.revise.stopped.untitled'],
  taken: ['chat:group.botCard.revise.taken.firstVersion', 'chat:group.botCard.revise.taken.titled', 'chat:group.botCard.revise.taken.untitled'],
  refused: ['chat:group.botCard.revise.refused.firstVersion', 'chat:group.botCard.revise.refused.titled', 'chat:group.botCard.revise.refused.untitled'],
});

/** Pure: one of REVISE_WORDS' sentences, about the change this fix went to. */
function reviseSentence(key: string, card: BotRequestCard, values: Record<string, string> = {}): string {
  const [firstVersion, titled, untitled] = REVISE_WORDS[key];
  if (card.firstVersion) return translate(firstVersion, values);
  return card.title ? translate(titled, { ...values, title: card.title }) : translate(untitled, values);
}

/** Pure: a fix sent to one of the bot's changes, where it stands. */
function reviseWords(card: BotRequestCard): string {
  const stage: string | undefined = card.state?.stage;
  if (stage === 'proposed') return reviseSentence('proposed', card, { approval: approvalWords(card.state) });
  if (stage && stage !== 'taken' && stage !== 'refused' && Object.hasOwn(REVISE_WORDS, stage)) return reviseSentence(stage, card);
  return reviseSentence('taken', card);
}

/** Pure: what a card says. */
export function cardWords(card: BotRequestCard): string {
  // WP-C: under somebody's first request on a project, the card adds that it
  // stays in the project's requests with their name on it.
  const withStays = (words: string) => (card.first ? translate('chat:group.botCard.withStays', { words }) : words);
  switch (card.kind) {
    case 'filed': {
      const stage = card.state?.stage;
      const words = filedWords(card);
      return !stage || STAYS_STAGES.has(stage) || !FILED_STAGES.has(stage) ? withStays(words) : words;
    }
    case 'revise':
      return reviseWords(card);
    case 'revise_refused':
      return reviseSentence('refused', card);
    case 'group':
      return withStays(card.title
        ? translate('chat:group.botCard.group', { title: card.title })
        : translate('chat:group.botCard.groupUntitled'));
    case 'offer':
      return card.title
        ? translate('chat:group.botCard.offer', { title: card.title })
        : translate('chat:group.botCard.offerUntitled');
    case 'unsure':
      return card.title
        ? translate('chat:group.botCard.unsureTitled', { title: card.title })
        : translate('chat:group.botCard.unsure');
    case 'question':
      return translate('chat:group.botCard.question');
    case 'busy':
      return translate('chat:group.botCard.busy');
    default:
      return translate('chat:group.botCard.failed');
  }
}

export interface BotRequestCardActions {
  onProgress?: () => void;
  onRequest?: (issueNumber: number) => void;
  onFile?: () => void;
  onDismiss?: () => void;
  onOpenChat?: () => void;
  /** Its change's preview, once it is built. */
  onTry?: (sessionId: number) => void;
  /** The change a fix went to: its page and its discussion. */
  onChange?: (sessionId: number) => void;
}

// The stages a request's card offers See progress at: it is still going.
const GOING = new Set(['waiting_first_version', 'reading', 'waiting', 'building', 'checking']);

export function BotRequestCardView({ card, actions = {} }: { card: BotRequestCard; actions?: BotRequestCardActions }) {
  const t = useMessages('chat');
  const buttons: Array<{ key: string; label: string; primary?: boolean; act?: () => void }> = [];
  const stage = card.state?.stage;
  const change = card.state?.sessionId || card.sessionId || null;
  const tryIt = { key: 'try', label: t('chat:group.botCard.action.tryIt'), primary: true, act: () => { if (change) actions.onTry?.(change); } };
  const seeChange = { key: 'change', label: t('chat:group.botCard.action.seeChange'), act: () => { if (change) actions.onChange?.(change); } };
  if (card.kind === 'filed') {
    if (stage === 'proposed' && change) buttons.push(tryIt);
    else if (stage === 'question' || stage === 'stopped') buttons.push({ key: 'chat', label: t('chat:group.botCard.action.openChat'), act: actions.onOpenChat });
    else if ((stage === 'closed' || stage === 'person') && card.issueNumber) {
      buttons.push({ key: 'request', label: t('chat:group.botCard.action.seeRequest'), act: () => actions.onRequest?.(card.issueNumber as number) });
    } else if (!stage || GOING.has(stage)) buttons.push({ key: 'progress', label: t('chat:group.botCard.action.seeProgress'), act: actions.onProgress });
  }
  if ((card.kind === 'revise' || card.kind === 'revise_refused') && change && stage !== 'live' && stage !== 'approved') {
    if (stage === 'proposed') buttons.push(tryIt);
    buttons.push(seeChange);
  }
  if (card.kind === 'group' && card.issueNumber) buttons.push({ key: 'request', label: t('chat:group.botCard.action.seeRequest'), act: () => actions.onRequest?.(card.issueNumber as number) });
  if (card.kind === 'unsure') {
    buttons.push({ key: 'file', label: t('chat:group.botCard.action.fileIt'), primary: true, act: actions.onFile });
    buttons.push({ key: 'not-now', label: t('chat:group.botCard.action.notNow'), act: actions.onDismiss });
  }
  if (card.kind === 'offer') {
    buttons.push({ key: 'file', label: t('chat:group.botCard.action.suggestIt'), primary: true, act: actions.onFile });
    buttons.push({ key: 'not-now', label: t('chat:group.botCard.action.notNow'), act: actions.onDismiss });
  }
  if (card.kind === 'question') buttons.push({ key: 'chat', label: t('chat:group.botCard.action.openChat'), act: actions.onOpenChat });
  if (card.kind === 'failed') buttons.push({ key: 'again', label: t('chat:group.botCard.action.tryAgain'), act: actions.onFile });
  return (
    <div
      className="mt-1.5 flex max-w-[480px] flex-col gap-2 rounded-2xl bg-[color:var(--messages-surface)] px-3 py-2.5"
      role="group"
      aria-label={t('chat:group.botCard.label')}
      data-bot-request-card={card.kind}
    >
      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
        <img className="h-4 w-4 rounded" src="/brand/homeroom-mark.png" alt="" aria-hidden="true" />
        <span>{t('chat:group.botCard.onlyYou')}</span>
      </div>
      <p className="text-[0.9375rem] leading-[1.35] text-zinc-900 dark:text-zinc-100">{cardWords(card)}</p>
      {sharedNow(card) ? (
        <p className="text-[0.8125rem] leading-snug text-zinc-500 dark:text-zinc-400" data-bot-request-shared="">{t('chat:group.botCard.shared')}</p>
      ) : null}
      {buttons.length ? (
        <div className="messages-bot-answers" role="group" aria-label={t('chat:group.botCard.choices')}>
          {buttons.map((b) => (
            <button
              key={b.key}
              type="button"
              className={b.primary ? 'messages-bot-primary' : 'messages-bot-secondary'}
              data-bot-request-action={b.key}
              onClick={() => b.act?.()}
            >
              <span>{b.label}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
