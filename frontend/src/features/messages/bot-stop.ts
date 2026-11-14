import type { Typist } from './store';

/*
 * STOP, IN THE CHAT WITH HOMEROOM BOT (task 2148). A tester sent the wrong
 * prompt and could only wait: the send button was only on or off, and an
 * answer can take minutes.
 *
 * While the bot is working on the viewer's message in the place on screen
 * (its main chat, or the thread that is open) and the box holds nothing to
 * send, the send button is Stop. A press asks the server to end that answer
 * (api.stopBotAnswer); until the bot's typing clears there, or
 * STOPPING_MAX_MS pass, the button is a disabled "Stopping". With anything
 * in the box it is Send, as it always was, so the next message can be
 * written while the bot works.
 *
 * What is being answered comes from the bot's typing event (`answering`,
 * services/homeroom-bot-dm.js pushTyping): only an answer that can be
 * stopped names one, so the button never offers a Stop that would do
 * nothing, and the Stop sent names that message, so it can only end the
 * answer the viewer was looking at. Nothing types on a first render (the
 * store starts with nobody typing), so the prerender and the hydration draw
 * Send.
 *
 * The rule is this pure function, so its whole table is tested
 * (tests/messages-bot-stop.test.js).
 */

export type SendMode = 'send' | 'stop' | 'stopping';

export interface SendModeInput {
  /** The open conversation is the viewer's own chat with Homeroom bot. */
  botChat: boolean;
  /** The message the bot is answering in the place on screen (answeringIn), or null. */
  answering: number | null;
  /** Nothing to send: no words, no file attached or on its way up, no item attached, no dictation. */
  empty: boolean;
  /** The message whose answer the viewer pressed Stop for, while that Stop is on its way; else null. */
  stopping: number | null;
}

/** What the button beside the message box is: Send, Stop, or a Stop on its way. */
export function sendMode({ botChat, answering, empty, stopping }: SendModeInput): SendMode {
  if (!botChat || !answering || !empty) return 'send';
  return stopping === answering ? 'stopping' : 'stop';
}

/** The message Homeroom bot is answering in a place, from those typing there: null when it is not, or its answer cannot be stopped. */
export function answeringIn(typing: readonly Typist[]): number | null {
  const bot = typing.find((entry) => entry.bot);
  return bot?.answering && bot.answering > 0 ? bot.answering : null;
}

/** How long a pressed Stop shows "Stopping" when the bot's typing has not cleared. */
export const STOPPING_MAX_MS = 15_000;
