// What the Homeroom bot's reply machines (bot-voice, bot-dm) and the old
// modules that hand them what people write share: where a message was
// written, the instance keys, the settle window and the later tries. Pure:
// the old modules require it at load (homeroom-bot-voice.js,
// homeroom-bot-mayor.js), so it imports nothing but other rules.

export const VOICE = 'bot-voice';
export const DM = 'bot-dm';

// A burst is one turn: a turn starts once the place has been quiet this long
// after a person's message, and never later than SETTLE_CAP_MS after the
// first message it answers (9 Oct 2026, PR #4584: a message and its bare
// "@Homeroom bot" two seconds later were answered twice).
export const SETTLE_MS = 8 * 1000;
export const SETTLE_CAP_MS = 25 * 1000;

// #3772: an answer the model could not give is asked again after these.
export const DEFER_DELAYS_MS: readonly number[] = Object.freeze([60 * 1000, 3 * 60 * 1000, 10 * 60 * 1000]);

export type PlaceType = 'session' | 'issue' | 'chat' | 'category' | 'message';
export interface Place { type: PlaceType; ref: number | null }
const THREAD_TYPES: ReadonlySet<string> = new Set(['session', 'issue', 'category', 'message']);

/**
 * Where a message was written, from its thread (null: a project's main
 * chat), as { type, ref }. Null for a thread the voice has no place in (a
 * governance vote's).
 */
export function placeOf(thread: { type?: unknown; ref?: unknown } | null | undefined): Place | null {
  if (!thread) return { type: 'chat', ref: null };
  const type = String(thread.type || '');
  const ref = Number(thread.ref);
  if (!THREAD_TYPES.has(type) || !Number.isInteger(ref) || ref <= 0) return null;
  return { type: type as PlaceType, ref };
}

/** One place, across processes: the voice's own key (homeroom_bot_voice_turns.place_key). */
export function placeKey(appId: number, place: Place): string {
  return `${Number(appId)}:${place.type}:${place.ref == null ? '' : Number(place.ref)}`;
}

/** The bot-voice instance of a place. */
export function voiceKey(appId: number, place: Place): string {
  return `place:${placeKey(appId, place)}`;
}

/** The bot-dm instance of a person's DM with the bot. */
export function dmKey(userId: number): string {
  return `person:${Number(userId)}`;
}

/** The thread a message in `place` sits in, as chat_messages stores it. */
export function threadOf(place: Place): { type: string; ref: number } | null {
  return place.type === 'chat' ? null : { type: place.type, ref: Number(place.ref) };
}

// The hellos, each said once ever per person (homeroom_bot_hellos).
export const HELLO_KINDS: ReadonlySet<string> = new Set(['maker', 'member', 'joiner', 'tour']);
