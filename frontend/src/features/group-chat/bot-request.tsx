import { t as tr } from "../../lib/i18n/runtime";
import { Message, Localized, message as catalogText } from "../../lib/i18n/react";
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
 * request is filed it also says that the chip is everybody's (SHARED_LINE).
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
export const CHIP_WORDS: Readonly<Record<Exclude<BotRequestChip['status'], 'ready'>, { glyph: string; words: string; said?: string }>> = Object.freeze({
  reading: { glyph: '👀', get words() { return tr("workshop:homeroom_bot_is_looking_at_this_92cc576b"); } },
  building: { glyph: '🔨', get words() { return tr("workshop:homeroom_bot_is_building_this_024e15bd"); } },
  fixing: { glyph: '🔧', get words() { return tr("workshop:homeroom_bot_is_fixing_this_4a975b64"); } },
  waiting_first_version: {
    glyph: '⏳',
    get words() { return tr("workshop:homeroom_bot_has_this_7e4f1f31"); },
    get said() { return tr("workshop:homeroom_bot_has_this_and_starts_on_it_once_the__e59bc25f"); },
  },
  live: { glyph: '✅', get words() { return tr("workshop:live_955ad329"); }, get said() { return tr("workshop:homeroom_bot_built_this_and_it_s_live_80426eb2"); } },
});

/** Pure: what a screen reader hears for a chip (the Try it button says Try it). */
export function chipLabel(status: Exclude<BotRequestChip['status'], 'ready'>): string {
  const { words, said } = CHIP_WORDS[status];
  return said || words;
}

/** What a request held for its project's first version waits for (the DM card's words). */
export const FIRST_VERSION_WAIT_LINE = () => tr("workshop:waiting_for_the_first_version_to_go_live_i_ll_st_14c3e9a0");

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
  const { glyph, words } = CHIP_WORDS[chip.status];
  const label = chipLabel(chip.status);
  return mine ? (
    <button type="button" className={CHIP_CLASS} data-bot-request={chip.status} aria-label={label} onClick={() => onProgress?.()}>
      <span aria-hidden="true">{glyph}</span>
      <span>{words}</span>
    </button>
  ) : (
    <span className={CHIP_CLASS} data-bot-request={chip.status} aria-label={label}>
      <span aria-hidden="true">{glyph}</span>
      <span>{words}</span>
    </span>
  );
}

/** WP-C: under somebody's first request on a project. */
export const STAYS_LINE = () => tr("workshop:it_stays_in_the_project_s_requests_with_your_nam_ac2529ad");

/**
 * Under a request the bot has just taken (sharedNow): the card is theirs
 * alone, but the chip on their message is the room's. 5 October 2026: an
 * idea suggested with Suggest it read as if it had stayed private.
 */
export const SHARED_LINE = () => tr("workshop:everyone_here_can_see_homeroom_bot_has_it_94cf59e1");

// The stages at which a filed request's card still says "Got it": the bot
// has it and has not started building. Its chip names the bot for the room.
const JUST_FILED = new Set(['waiting_first_version', 'reading', 'waiting']);

/** Pure: whether a card says that the room can see the bot has it (SHARED_LINE). */
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
  if (state?.missing === 0) return tr("workshop:it_has_the_approvals_it_needs_c8f7c942");
  const words = waitingWords({
    you: !!state?.youApprove, names: state?.waitingOn || [], more: state?.more, missing: state?.missing, needed: state?.needed,
  });
  return words ? `${words}.` : tr("workshop:waiting_for_approval_3a172afe");
}

/** Pure: a request the bot builds, where it stands. */
function filedWords(card: BotRequestCard, stays: string): string {
  const title = card.title || tr("workshop:your_request_cf478277");
  switch (card.state?.stage) {
    case 'waiting_first_version': return tr("workshop:got_it_title_first_version_wait_46687664", { title, wait: FIRST_VERSION_WAIT_LINE(), stays });
    case 'waiting': return tr("workshop:got_it_title_waiting_for_a_free_builder_stays_547c3a4f", { title, stays });
    case 'building': return tr("workshop:building_it_now_title_stays_da377e12", { title, stays });
    case 'question': return tr("workshop:i_have_a_question_about_this_it_s_in_our_chat_26948acb");
    case 'checking': return tr("workshop:built_title_testing_it_now_73879d22", { title });
    case 'proposed': return tr("workshop:built_title_approval_12515f6a", { title, approval: approvalWords(card.state) });
    case 'approved': return tr("workshop:approved_title_it_s_going_live_95909b1c", { title });
    case 'live': return tr("workshop:live_title_31f18255", { title });
    case 'closed': return tr("workshop:closed_title_it_won_t_go_live_0e9933dc", { title });
    case 'person': return tr("workshop:i_left_this_for_the_group_to_decide_d42ad251");
    case 'stopped': return tr("workshop:i_couldn_t_finish_this_our_chat_says_why_098af220");
    default:
      return tr("workshop:got_it_value1_value2_value3_9d644a5e", { value1: title, value2: card.typicalMinutes ? tr("workshop:usually_about_value1_minutes_f676f683", { value1: card.typicalMinutes }) : '', value3: stays });
  }
}

/** Pure: the change a fix went to: "the first version", or its name. */
function changeName(card: BotRequestCard): string {
  if (card.firstVersion) return tr("workshop:the_first_version_f71838e0");
  return card.title ? tr("workshop:quoted_title_01f82e13", { title: card.title }) : tr("workshop:that_change_d76328a0");
}

/** Pure: a fix sent to one of the bot's changes, where it stands. */
function reviseWords(card: BotRequestCard): string {
  const it = changeName(card);
  const It = it.charAt(0).toUpperCase() + it.slice(1);
  switch (card.state?.stage) {
    case 'checking': return tr("workshop:updated_change_testing_it_now_552f5519", { change: it });
    case 'proposed': return tr("workshop:updated_change_approval_a515bef8", { change: it, approval: approvalWords(card.state) });
    case 'asked': return tr("workshop:i_have_a_question_about_your_fix_it_s_in_the_dis_f0018276", { change: it });
    case 'answered': return tr("workshop:i_answered_you_in_the_discussion_of_change_b1966324", { change: it });
    case 'person': return tr("workshop:i_left_your_fix_to_change_for_the_group_to_decid_fbd7c990", { change: it });
    case 'approved': return tr("workshop:change_was_approved_62a75168", { change: It });
    case 'live': return tr("workshop:change_is_live_5a610e58", { change: It });
    case 'closed': return tr("workshop:change_was_closed_eaab8ee5", { change: It });
    case 'stopped': return tr("workshop:i_couldn_t_finish_fixing_change_87fae57a", { change: it });
    default: return tr("workshop:got_it_i_ll_fix_that_in_change_before_it_goes_li_fbee19c8", { change: it });
  }
}

/** Pure: what a card says. */
export function cardWords(card: BotRequestCard): string {
  const stays = card.first ? ` ${STAYS_LINE()}` : '';
  switch (card.kind) {
    case 'filed':
      return filedWords(card, stays);
    case 'revise':
      return reviseWords(card);
    case 'revise_refused':
      return tr("workshop:i_couldn_t_change_change_just_now_you_can_say_wh_3a5f3aa0", { change: changeName(card) });
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
  /** Its change's preview, once it is built. */
  onTry?: (sessionId: number) => void;
  /** The change a fix went to: its page and its discussion. */
  onChange?: (sessionId: number) => void;
}

// The stages a request's card offers See progress at: it is still going.
const GOING = new Set(['waiting_first_version', 'reading', 'waiting', 'building', 'checking']);

export function BotRequestCardView({ card, actions = {} }: { card: BotRequestCard; actions?: BotRequestCardActions }) {
  const buttons: Array<{ key: string; label: string; primary?: boolean; act?: () => void }> = [];
  const stage = card.state?.stage;
  const change = card.state?.sessionId || card.sessionId || null;
  const tryIt = { key: 'try', get label() { return tr("workshop:try_it_fe695111"); }, primary: true, act: () => { if (change) actions.onTry?.(change); } };
  const seeChange = { key: 'change', get label() { return tr("workshop:see_change_69870418"); }, act: () => { if (change) actions.onChange?.(change); } };
  if (card.kind === 'filed') {
    if (stage === 'proposed' && change) buttons.push(tryIt);
    else if (stage === 'question' || stage === 'stopped') buttons.push({ key: 'chat', get label() { return tr("workshop:open_chat_0600175a"); }, act: actions.onOpenChat });
    else if ((stage === 'closed' || stage === 'person') && card.issueNumber) {
      buttons.push({ key: 'request', get label() { return tr("workshop:see_request_45fd5127"); }, act: () => actions.onRequest?.(card.issueNumber as number) });
    } else if (!stage || GOING.has(stage)) buttons.push({ key: 'progress', get label() { return tr("workshop:see_progress_d1636c64"); }, act: actions.onProgress });
  }
  if ((card.kind === 'revise' || card.kind === 'revise_refused') && change && stage !== 'live' && stage !== 'approved') {
    if (stage === 'proposed') buttons.push(tryIt);
    buttons.push(seeChange);
  }
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
      {sharedNow(card) ? (
        <p className="text-[0.8125rem] leading-snug text-zinc-500 dark:text-zinc-400" data-bot-request-shared="">{SHARED_LINE()}</p>
      ) : null}
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
