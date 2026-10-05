import { t as tr } from "../../lib/i18n/runtime";
import { Message, Localized, message as catalogText } from "../../lib/i18n/react";
import type { BotRequestCard, BotRequestChip } from './transcript-store';

/*
 * B9: a request asked of Homeroom bot in a project's chat, on the message
 * that asked it (services/homeroom-bot-chat.js). WP-C: or an idea of a
 * newcomer's, which their card offers to suggest to the group.
 *
 * THE CHIP is what everybody in the room sees, first in the message's
 * reactions row: its status, set by the server alone, never a reaction
 * anybody can add or toggle, in the bot's own periwinkle rather than the
 * accent a reaction of yours wears. An emoji with a word, so it does not read
 * as one. Ready is a Try it chip that opens the change's preview for anyone.
 * When the work stops the chip goes; the requester's card and their chat with
 * the bot say why.
 *
 * THE CARD is under the requester's own message only, "Only you can see
 * this": what was taken from it and how long it usually takes, or the
 * question it asks first. It is read from their own requests, never from the
 * room's messages, so nobody else's transcript can hold it.
 */

const CHIP_CLASS = 'inline-flex items-center gap-1 rounded-full bg-[color:var(--brand-tint)] px-2.5 py-0.5 text-[0.8125rem] font-semibold text-[color:var(--brand-ink)]';

const CHIP_WORDS: Record<Exclude<BotRequestChip['status'], 'ready'>, { glyph: string; word: string }> = {
  reading: { glyph: '👀', get word() { return tr("workshop:reading_463816d0"); } },
  building: { glyph: '🔨', get word() { return tr("workshop:building_87c5912f"); } },
  live: { glyph: '✅', get word() { return tr("workshop:live_b64ac05f"); } },
};

export function BotStatusChip({ chip, mine = false, onTry, onProgress }: {
  chip: BotRequestChip;
  mine?: boolean;
  onTry?: (sessionId: number) => void;
  /** The requester's own chip opens their progress card in the bot's chat. */
  onProgress?: () => void;
}) {
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
        <span><Message id="workshop:try_it_fe695111" /></span>
      </button>
    );
  }
  const { glyph, word } = CHIP_WORDS[chip.status];
  const label = tr("workshop:homeroom_bot_value1_b8398ca4", { value1: word });
  return mine ? (
    <button type="button" className={CHIP_CLASS} data-bot-request={chip.status} aria-label={label} onClick={() => onProgress?.()}>
      <span aria-hidden="true">{glyph}</span>
      <span>{word}</span>
    </button>
  ) : (
    <span className={CHIP_CLASS} data-bot-request={chip.status} aria-label={label}>
      <span aria-hidden="true">{glyph}</span>
      <span>{word}</span>
    </span>
  );
}

/** WP-C: under somebody's first request on a project. */
export const STAYS_LINE = () => tr("workshop:it_stays_in_the_project_s_requests_with_your_nam_ac2529ad");

/** Pure: what a card says. */
export function cardWords(card: BotRequestCard): string {
  const stays = card.first ? ` ${STAYS_LINE()}` : '';
  switch (card.kind) {
    case 'filed':
      return tr("workshop:got_it_value1_value2_value3_9d644a5e", { value1: card.title || tr("workshop:your_request_cf478277"), value2: card.typicalMinutes ? tr("workshop:usually_about_value1_minutes_f676f683", { value1: card.typicalMinutes }) : '', value3: stays });
    case 'group':
      return tr("workshop:filed_as_a_request_for_the_group_value1_value2_f5108811", { value1: card.title || tr("workshop:your_request_cf478277"), value2: stays });
    case 'offer':
      return card.title
        ? tr("workshop:suggest_this_to_the_group_it_goes_in_the_project_2f16c267", { value1: card.title })
        : tr("workshop:suggest_this_to_the_group_it_goes_in_the_project_48781967");
    case 'unsure':
      return tr("workshop:want_me_to_file_this_as_a_request_value1_2c8cdba4", { value1: card.title ? ` ${card.title}` : '' });
    case 'question':
      return tr("workshop:i_answer_questions_in_our_chat_c1983cad");
    case 'busy':
      return tr("workshop:you_ve_asked_me_for_a_lot_in_the_last_hour_try_a_67e92559");
    default:
      return tr("workshop:i_couldn_t_file_it_just_now_try_again_in_a_minut_8369995a");
  }
}

export interface BotRequestCardActions {
  onProgress?: () => void;
  onRequest?: (issueNumber: number) => void;
  onFile?: () => void;
  onDismiss?: () => void;
  onOpenChat?: () => void;
}

export function BotRequestCardView({ card, actions = {} }: { card: BotRequestCard; actions?: BotRequestCardActions }) {
  const buttons: Array<{ key: string; label: string; primary?: boolean; act?: () => void }> = [];
  if (card.kind === 'filed') buttons.push({ key: 'progress', get label() { return tr("workshop:see_progress_d1636c64"); }, act: actions.onProgress });
  if (card.kind === 'group' && card.issueNumber) buttons.push({ key: 'request', get label() { return tr("workshop:see_request_45fd5127"); }, act: () => actions.onRequest?.(card.issueNumber as number) });
  if (card.kind === 'unsure') {
    buttons.push({ key: 'file', get label() { return tr("workshop:file_it_e67de92e"); }, primary: true, act: actions.onFile });
    buttons.push({ key: 'not-now', get label() { return tr("workshop:not_now_a0e63d7c"); }, act: actions.onDismiss });
  }
  if (card.kind === 'offer') {
    buttons.push({ key: 'file', get label() { return tr("workshop:suggest_it_4bbeeba1"); }, primary: true, act: actions.onFile });
    buttons.push({ key: 'not-now', get label() { return tr("workshop:not_now_a0e63d7c"); }, act: actions.onDismiss });
  }
  if (card.kind === 'question') buttons.push({ key: 'chat', get label() { return tr("workshop:open_chat_0600175a"); }, act: actions.onOpenChat });
  if (card.kind === 'failed') buttons.push({ key: 'again', get label() { return tr("workshop:try_again_d8b8392e"); }, act: actions.onFile });
  return (
    <Localized element={<div
      className="mt-1.5 flex max-w-[480px] flex-col gap-2 rounded-2xl bg-[color:var(--messages-surface)] px-3 py-2.5"
      role="group" aria-label={catalogText("workshop:homeroom_bot_only_you_can_see_this_befbba92")}
      data-bot-request-card={card.kind}
    >
      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
        <img className="h-4 w-4 rounded" src="/brand/homeroom-mark.png" alt="" aria-hidden="true" />
        <span><Message id="workshop:only_you_can_see_this_3303eeef" /></span>
      </div>
      <p className="text-[0.9375rem] leading-[1.35] text-zinc-900 dark:text-zinc-100">{cardWords(card)}</p>
      {buttons.length ? (
        <Localized element={<div className="messages-bot-answers" role="group" aria-label={catalogText("workshop:choices_2f75b64a")}>
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
        </div>} messages={{"aria-label":"workshop:choices_2f75b64a"}} />
      ) : null}
    </div>} messages={{"aria-label":"workshop:homeroom_bot_only_you_can_see_this_befbba92"}} />
  );
}
