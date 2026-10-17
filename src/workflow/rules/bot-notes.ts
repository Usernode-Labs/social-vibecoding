// How the machines tell the Homeroom bot's change machine what happened to
// one of its changes (src/workflow/bot-change/): a domain write, in the
// transition that decided it, sending a message when the session is the
// bot's. The message commits with its cause, so it cannot be lost, and the
// senders need no fact of their own: the write reads the owner itself.

import type { DomainWrite, Json, Tx, WriteContext } from '../kernel/index.ts';

export const BOT_CHANGE = 'bot-change';
export const BOT_USERNAME = 'homeroom_bot';
export const botChangeKey = (sessionId: number) => `session:${sessionId}`;

// platform.ts botNote: appends `type` to the change machine from outside a
// transition (the bot's loop, and the one-release shims of the work kinds
// older releases queued to reach the bot, each keyed by its work id).
export type BotNote = (sessionId: number, type: string, payload?: Record<string, unknown>,
  o?: { requestKey?: string }) => Promise<unknown>;

// The line each request's thread says when a change of the bot's for it is
// withdrawn because it was closed (the proposal machine's close, reason
// `request-closed`; homeroom-bot-closed-requests.js).
export function withdrawnNote(title: string | null | undefined): string {
  const what = title ? `“${String(title).slice(0, 120)}”` : 'Homeroom bot\'s change for this request';
  return `${what} was withdrawn: this request is closed.`;
}

// The bot's change machine hears `event` about session `sessionId`.
export const toBotChange = (sessionId: number, event: string, payload: Record<string, Json> = {}): DomainWrite =>
  ({ type: 'botChange', sessionId, event, payload });

export async function writeBotChange(tx: Tx, w: any, ctx: WriteContext): Promise<void> {
  const { rows: [r] } = await tx.query(
    `SELECT cs.app_id FROM chat_sessions cs JOIN users u ON u.id = cs.user_id
      WHERE cs.id = $1 AND u.username = $2 AND u.is_synthetic = TRUE`, [w.sessionId, BOT_USERNAME]);
  if (!r) return;
  ctx.message({
    to: { machine: BOT_CHANGE, key: botChangeKey(Number(w.sessionId)) },
    event: { type: w.event, payload: { sessionId: Number(w.sessionId), ...(w.payload || {}) } },
    appId: r.app_id,
  });
}
