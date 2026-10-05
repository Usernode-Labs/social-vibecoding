import { useMessages as useUiLanguage } from "../../lib/i18n/react";
import { LocalizedValue, LocalizedDynamic } from "../../lib/i18n/react";
import { t as tr } from "../../lib/i18n/runtime";
import { Message } from "../../lib/i18n/react";
import { useState } from 'react';

import { InfoCircleIcon } from '@/components/ui/icons';

import { answerBotQuestion, scopeKey, setReply, tapBotAction } from './store';
import type { ConversationMessage, HomeroomBotAction, HomeroomBotMeta } from './types';

/*
 * #3624: what hangs under a message from the Homeroom bot.
 *
 * A QUESTION carries its suggested answers as buttons, the bot's default
 * first and marked as such, and a "Something else" that quotes the question
 * in the composer for an answer of one's own. Tapping an answer sends it at
 * once, quoting the question, which is how the server knows which request
 * it answers (services/homeroom-bot-dm.js). Once answered (or closed by
 * newer news on the same request) the buttons go and the answer stays.
 *
 * EVERY ANSWER IS PUBLIC, and the line under an open question says so
 * before anybody taps: the bot posts it on the request's discussion, where
 * the rest of the group reads it. A reply quoting any other message the bot
 * sent about a request is posted there too; the composer's reply bar says
 * that one (./composer.tsx).
 *
 * #3624 stage 2: an OFFER (kind `confirm`) uses the same buttons: File it
 * and Not now under a request the bot offers to file. Nothing is posted
 * anywhere until File it, so it has no public note, no "suggested" and no
 * Something else (anything typed is read by the bot instead). #3770: File
 * it is the act, filled in the accent; Not now is the neutral fill beside
 * it. A question's answers keep one look: none of them is the act.
 * #11 (WP3): an offer to withdraw one of the bot's proposals is the same
 * pair, Withdraw it and Keep it, named by its own question.
 *
 * B3: buttons are real now. A message that carries `actions` draws them
 * (BotActions), and a tap is decided on the server, once, rather than sent
 * as the button's words in the person's name (store.tapBotAction). Then the
 * buttons give way to one quiet line, "You chose File it", on every device.
 * A message from before carries `answers` only and works as it did.
 */

/**
 * B3: the bot's news a reply is posted publicly for (services/homeroom-bot-
 * dm.js MIRRORED_KINDS): a question, and a message that asks for a reply to
 * look again with. A reply to any other news stays in the DM. Older messages
 * say `mirrors` on everything, so the kind decides here too.
 */
export const MIRRORED_KINDS: ReadonlySet<string> = new Set(['question', 'followup_ask', 'blocked', 'person', 'empty']);

/** Whether a reply quoting this bot message is posted on its request. */
export function mirrorsReplies(meta: HomeroomBotMeta | null | undefined): meta is HomeroomBotMeta {
  return !!meta?.mirrors && MIRRORED_KINDS.has(meta.kind);
}

export function botMeta(message: ConversationMessage): HomeroomBotMeta | null {
  if (!message.sender.bot) return null;
  const meta = message.metadata?.homeroomBot;
  return meta && typeof meta === 'object' ? meta : null;
}

/** "Homeroom request #12", the place an answer is posted. */
export function requestPlace(meta: HomeroomBotMeta): string {
  const app = meta.appName || meta.appSlug || tr("community:the_project_059df477");
  return meta.firstVersion ? `${app}’s first-version request` : tr("community:value1_request_value2_10a9ffd4", { value1: app, value2: meta.issueNumber });
}

export function BotQuestion({ message, conversationId }: { message: ConversationMessage; conversationId: number }) {
  useUiLanguage();
  const meta = botMeta(message);
  // The answer tapped here, until the server's own state comes back.
  const [chosen, setChosen] = useState<string | null>(null);
  if (meta?.actions?.length) return <BotActions message={message} meta={meta} />;
  if (!meta || !meta.question) return null;
  const answers = (meta.answers || []).filter((a) => typeof a === 'string' && a.trim());
  const open = meta.status === 'open' && !chosen && !message.deleted;
  const answered = meta.status === 'answered' ? (meta.answer || chosen) : chosen;
  const offer = meta.kind === 'confirm';

  function choose(answer: string) {
    setChosen(answer);
    void answerBotQuestion(message, answer).catch(() => setChosen(null));
  }

  function somethingElse() {
    setReply(scopeKey(conversationId, null), message);
    // The reply bar puts the caret in the composer where there is a
    // keyboard; a phone gets it too, since this is a request to type.
    window.requestAnimationFrame(() => {
      document.querySelector<HTMLTextAreaElement>('.messages-composer-input')?.focus({ preventScroll: true });
    });
  }

  return (
    <div className="messages-bot-question" data-bot-question={meta.status || 'open'}>
      {open ? (
        <LocalizedDynamic element={<div className="messages-bot-answers" role="group" aria-label={offer ? (meta.question || tr("community:file_this_request_3157f534")) : tr("community:suggested_answers_c9be94c6")}>
          {answers.map((answer, index) => (
            <button
              key={answer}
              type="button"
              className={offer ? (index === 0 ? 'messages-bot-primary' : 'messages-bot-secondary') : undefined}
              data-bot-answer={index === 0 ? 'default' : 'other'}
              onClick={() => choose(answer)}
            >
              <span>{answer}</span>
              {index === 0 && !offer ? <span className="messages-bot-default"><Message id="community:suggested_8ad70375" /></span> : null}
            </button>
          ))}
          {offer ? null : <button type="button" className="messages-bot-other" onClick={somethingElse}><Message id="community:something_else_cc728431" /></button>}
        </div>} resolve={() => ({ "aria-label": offer ? (meta.question || tr("community:file_this_request_3157f534")) : tr("community:suggested_answers_c9be94c6") })} />
      ) : null}
      {answered ? <p className="messages-bot-answered"><LocalizedValue render={() => (offer ? tr("community:you_chose_value1_1aaffd87", { value1: answered }) : tr("community:you_answered_value1_196bdd5e", { value1: answered }))} /></p> : null}
      {(open || chosen) && mirrorsReplies(meta) ? (
        <p className="messages-bot-note">
          <InfoCircleIcon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span><LocalizedValue render={() => (tr("community:your_answer_is_posted_on_value1_s_public_discuss_422f4666", { value1: requestPlace(meta) }))} /></span>
        </p>
      ) : null}
      {meta.status === 'closed' && !answered ? <p className="messages-bot-answered"><Message id="community:no_longer_needed_ace70031" /></p> : null}
    </div>
  );
}

/**
 * B3: a bot message's buttons (types.ts HomeroomBotAction). The act is
 * filled in the accent, the rest beside it in the neutral fill. A `server`
 * button is pressed once: the buttons go at once, the line says what was
 * chosen, and the message's own update (decided here or on another device)
 * keeps it that way. A refused press (decided already elsewhere) brings
 * nothing back: that device's choice arrives with the update.
 */
function BotActions({ message, meta }: { message: ConversationMessage; meta: HomeroomBotMeta }) {
  useUiLanguage();
  // The button pressed here, until the server's own state comes back.
  const [pressed, setPressed] = useState<HomeroomBotAction | null>(null);
  const actions = meta.actions || [];
  const settled = meta.status === 'answered' || meta.status === 'closed';
  const open = !settled && !pressed && !message.deleted;
  const chosen = meta.status === 'answered' ? (meta.answer || null) : (pressed ? pressed.label : null);
  // B5: a question offered to tap reads back as asked, a choice as chosen.
  const chosenAction = actions.find((action) => action.id === meta.chosen) || pressed;
  const prompts = actions.length > 0 && actions.every((action) => action.type === 'prompt');

  function press(action: HomeroomBotAction) {
    if (action.type === 'open') {
      void tapBotAction(message, action).catch(() => {});
      return;
    }
    // A prompt is their own message; the buttons give way at once, and the
    // server settles them on every device when it lands.
    setPressed(action);
    void tapBotAction(message, action).catch(() => setPressed(null));
  }

  return (
    <div className="messages-bot-question" data-bot-question={meta.status || 'open'}>
      {open ? (
        <LocalizedDynamic element={<div className="messages-bot-answers" role="group" aria-label={meta.question || (prompts ? tr("community:questions_you_can_ask_f9678b43") : tr("community:choices_2f75b64a"))}>
          {actions.map((action, index) => (
            <button
              key={action.id}
              type="button"
              // B5: a prompt keeps the suggestion pill's look; a choice is filled.
              className={action.type === 'prompt' ? undefined : action.style === 'primary' ? 'messages-bot-primary' : 'messages-bot-secondary'}
              data-bot-answer={index === 0 ? 'default' : 'other'}
              data-bot-prompt={action.type === 'prompt' ? '' : undefined}
              onClick={() => press(action)}
            >
              <span>{action.label}</span>
            </button>
          ))}
        </div>} resolve={() => ({ "aria-label": meta.question || (prompts ? tr("community:questions_you_can_ask_f9678b43") : tr("community:choices_2f75b64a")) })} />
      ) : null}
      {chosen ? <p className="messages-bot-answered"><LocalizedValue render={() => (chosenAction?.type === 'prompt' ? tr("community:you_asked_value1_a9b97b24", { value1: chosen }) : tr("community:you_chose_value1_e2fdede6", { value1: chosen }))} /></p> : null}
      {meta.status === 'closed' && !chosen ? <p className="messages-bot-answered"><Message id="community:no_longer_needed_ace70031" /></p> : null}
    </div>
  );
}
