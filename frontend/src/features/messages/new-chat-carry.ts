/**
 * WHAT A DOOR CARRIES INTO A NEW CHAT (14 Nov 2026). A door that used to put
 * an item in Main Chat's box (Ask for changes on a change, Ask privately on
 * a vote) opens a new chat with Homeroom bot instead, and the item goes with
 * it: a chip in the new chat's box, sent with the first message
 * (./new-thread.tsx). The address that opens the new chat can name a project
 * but not an item (../ai/door.ts botNewAddress), so the item waits here for
 * the chat that address opens, and only for a moment: a door whose address
 * never opened one must not hand its item to a chat started later.
 *
 * Its own module so the store (the door's half) and the panel (the taker)
 * can both import it without importing each other.
 */

import type { StagedObject } from './types';

/** How long a carried item waits for its new chat. */
export const CARRY_MS = 10_000;

let carried: { object: StagedObject; placeholder: string | null; at: number } | null = null;

/** Hand an item to the new chat about to open; null takes back what was waiting. */
export function carryToNewChat(object: StagedObject | null | undefined, placeholder: string | null = null, now: number = Date.now()): void {
  carried = object ? { object, placeholder, at: now } : null;
}

/** The item waiting, once: null when there is none, or it waited too long. */
export function takeCarried(now: number = Date.now()): { object: StagedObject; placeholder: string | null } | null {
  const held = carried;
  carried = null;
  return held && now - held.at < CARRY_MS ? { object: held.object, placeholder: held.placeholder } : null;
}
