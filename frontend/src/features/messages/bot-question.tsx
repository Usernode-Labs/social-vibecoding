import { useState } from 'react';

import { InfoCircleIcon } from '@/components/ui/icons';

import { answerBotQuestion, scopeKey, setReply } from './store';
import type { ConversationMessage, HomeroomBotMeta } from './types';

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
 * Something else (anything typed is read by the bot instead).
 */

export function botMeta(message: ConversationMessage): HomeroomBotMeta | null {
  if (!message.sender.bot) return null;
  const meta = message.metadata?.homeroomBot;
  return meta && typeof meta === 'object' ? meta : null;
}

/** "Homeroom request #12", the place an answer is posted. */
export function requestPlace(meta: HomeroomBotMeta): string {
  const app = meta.appName || meta.appSlug || 'the project';
  return meta.firstVersion ? `${app}’s first-version request` : `${app} request #${meta.issueNumber}`;
}

export function BotQuestion({ message, conversationId }: { message: ConversationMessage; conversationId: number }) {
  const meta = botMeta(message);
  // The answer tapped here, until the server's own state comes back.
  const [chosen, setChosen] = useState<string | null>(null);
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
        <div className="messages-bot-answers" role="group" aria-label={offer ? 'File this request?' : 'Suggested answers'}>
          {answers.map((answer, index) => (
            <button key={answer} type="button" data-bot-answer={index === 0 ? 'default' : 'other'} onClick={() => choose(answer)}>
              <span>{answer}</span>
              {index === 0 && !offer ? <span className="messages-bot-default">suggested</span> : null}
            </button>
          ))}
          {offer ? null : <button type="button" className="messages-bot-other" onClick={somethingElse}>Something else</button>}
        </div>
      ) : null}
      {answered ? <p className="messages-bot-answered">{offer ? `You chose: ${answered}` : `You answered: ${answered}`}</p> : null}
      {(open || chosen) && meta.mirrors ? (
        <p className="messages-bot-note">
          <InfoCircleIcon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>{`Your answer is posted on ${requestPlace(meta)}’s public discussion, where the group can see it.`}</span>
        </p>
      ) : null}
      {meta.status === 'closed' && !answered ? <p className="messages-bot-answered">No longer needed.</p> : null}
    </div>
  );
}
