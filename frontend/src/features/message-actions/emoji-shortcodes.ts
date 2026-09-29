/**
 * `:shortcodes` for the composers' emoji autocomplete — Discord's and Slack's
 * `:thumbsup:`, over the picker's own emoji (./emoji-data.ts).
 *
 * Every emoji answers to its name slugified (`thumbs up` → `thumbs_up`), and
 * the ones people actually type by heart also answer to the codes they learnt
 * elsewhere (`thumbsup`, `+1`, `tada`, `joy`, `heart`). Those aliases lead
 * each emoji's list, so the row the menu draws shows the code a person
 * recognises rather than the Unicode name.
 *
 * Pure on purpose — no DOM, no React. Both composers call it: the Messages
 * composer (features/messages/composer.tsx) directly, and the app chat's
 * legacy `EmojiAutocomplete` (public/js/group-chat.js) through
 * `window.UsernodeReact.groupChat` (features/group-chat/mount.ts). The token
 * rules live here once, so the two cannot disagree about what `:th` means.
 */

import { ALL_EMOJI } from './emoji-data';

/** A name character: what continues a `:query`. Anything else ends it. */
const NAME_CHAR = 'a-z0-9_+\\-';

/** How many name characters a `:query` needs before the menu opens: `:th`. */
export const SHORTCODE_MIN_QUERY = 2;

/** The longest `:query` worth matching; the longest shortcode is shorter. */
const MAX_QUERY = 48;

/**
 * A `:` only starts a token at the start of the text or after whitespace or
 * an opening bracket — so `10:30`, `https://` and `Note:` never open a menu.
 */
const TOKEN_BOUNDARY = '(^|[\\s([{])';

const OPEN_TOKEN = new RegExp(`${TOKEN_BOUNDARY}:([${NAME_CHAR}]{${SHORTCODE_MIN_QUERY},${MAX_QUERY}})$`, 'i');
const CLOSED_TOKEN = new RegExp(`${TOKEN_BOUNDARY}:([${NAME_CHAR}]{1,${MAX_QUERY}}):$`, 'i');

/**
 * The codes people type from muscle memory, for the emoji this set has.
 * Written against the picker's exact strings (variation selectors included);
 * tests/emoji-shortcodes.test.js fails on a row whose emoji is not in it.
 */
const ALIASES: ReadonlyArray<readonly [string, string]> = [
  ['😀', 'grinning smiley'],
  ['😁', 'grin'],
  ['😂', 'joy laughing lol face_with_tears_of_joy'],
  ['🤣', 'rofl'],
  ['😊', 'blush smile'],
  ['😇', 'innocent'],
  ['🙂', 'slight_smile'],
  ['😉', 'wink'],
  ['😍', ''],
  ['🥰', 'smiling_face_with_three_hearts'],
  ['😘', 'kissing_heart'],
  ['😋', 'yum'],
  ['😜', 'stuck_out_tongue_winking_eye'],
  ['🤪', 'zany_face'],
  ['😎', 'sunglasses cool_face'],
  ['🤓', 'nerd'],
  ['🥳', 'partying_face'],
  ['🤩', 'star_struck'],
  ['😏', 'smirk'],
  ['😅', 'sweat_smile'],
  ['😬', 'grimacing'],
  ['🙃', 'upside_down'],
  ['😌', 'relieved'],
  ['😴', 'sleeping'],
  ['🤤', 'drooling'],
  ['😪', 'sleepy'],
  ['😮', 'open_mouth wow'],
  ['😲', 'astonished'],
  ['😳', 'flushed'],
  ['🥺', 'pleading_face pleading'],
  ['😢', 'cry'],
  ['😭', 'sob'],
  ['😤', 'triumph'],
  ['😠', 'angry'],
  ['😡', 'rage'],
  ['🤬', 'face_with_symbols_over_mouth cursing_face'],
  ['🤯', 'exploding_head mind_blown'],
  ['🥵', 'hot_face'],
  ['🥶', 'cold_face'],
  ['😱', 'scream'],
  ['😨', 'fearful'],
  ['😰', 'cold_sweat'],
  ['🤗', 'hugs hugging'],
  ['🤔', 'thinking'],
  ['🤭', 'hand_over_mouth'],
  ['🤫', 'shushing_face'],
  ['🙄', 'roll_eyes eye_roll'],
  ['😒', 'unamused'],
  ['😞', 'disappointed'],
  ['😔', 'pensive'],
  ['😟', 'worried'],
  ['😕', 'confused'],
  ['😖', 'confounded'],
  ['😫', ''],
  ['😩', 'weary'],
  ['🤢', ''],
  ['🤮', 'vomiting_face'],
  ['🤧', ''],
  ['😷', 'mask'],
  ['🤒', ''],
  ['🤠', 'cowboy_hat_face cowboy'],
  ['🤑', ''],
  ['😈', 'smiling_imp'],
  ['💩', 'poop hankey'],
  ['👽', 'alien'],
  ['🤖', 'robot'],
  ['🤡', 'clown'],
  ['😺', 'smiley_cat'],
  ['🙈', 'see_no_evil'],
  ['🙉', 'hear_no_evil'],
  ['🙊', 'speak_no_evil'],
  ['😶', 'no_mouth'],
  ['😐', ''],
  ['🥴', 'woozy_face'],
  ['👍', 'thumbsup +1 like'],
  ['👎', 'thumbsdown -1'],
  ['👌', ''],
  ['✌️', 'v victory'],
  ['🤞', 'crossed_fingers fingers_crossed'],
  ['🤟', 'love_you_gesture'],
  ['🤘', 'metal'],
  ['🤙', ''],
  ['👋', 'wave'],
  ['🖐️', 'hand_splayed'],
  ['✋', 'hand'],
  ['👊', 'punch fist_oncoming'],
  ['✊', 'fist fist_raised'],
  ['🤛', ''],
  ['🤜', ''],
  ['👏', 'clap'],
  ['🙌', 'raised_hands hooray'],
  ['🙏', 'pray thanks'],
  ['💪', 'muscle'],
  ['🖕', 'middle_finger'],
  ['☝️', 'point_up'],
  ['👆', 'point_up_2'],
  ['👇', 'point_down'],
  ['👈', 'point_left'],
  ['👉', 'point_right'],
  ['✍️', ''],
  ['🤲', ''],
  ['🗣️', 'speaking_head'],
  ['💁', 'tipping_hand_person'],
  ['🙅', 'no_good'],
  ['🙆', 'ok_woman ok_person'],
  ['🤦', 'facepalm'],
  ['🏃', 'running'],
  ['❤️', 'heart'],
  ['💓', 'heartbeat'],
  ['💗', 'heartpulse'],
  ['💘', 'cupid'],
  ['💝', 'gift_heart'],
  ['❣️', 'heavy_heart_exclamation'],
  ['🐶', 'dog'],
  ['🐱', 'cat'],
  ['🐭', 'mouse'],
  ['🐹', 'hamster'],
  ['🐰', 'rabbit bunny'],
  ['🦊', 'fox'],
  ['🐻', 'bear'],
  ['🐼', 'panda'],
  ['🐯', 'tiger'],
  ['🦁', 'lion'],
  ['🐮', 'cow'],
  ['🐷', 'pig'],
  ['🐸', 'frog'],
  ['🐵', 'monkey'],
  ['🐳', 'whale'],
  ['🐝', 'bee'],
  ['🐞', 'ladybug'],
  ['⭐', 'star'],
  ['🌟', 'star2'],
  ['⚡', 'zap'],
  ['☀️', 'sunny'],
  ['🌧️', 'rain'],
  ['🌊', 'ocean'],
  ['🌍', 'earth_africa'],
  ['🍎', 'apple'],
  ['🌽', 'corn'],
  ['🧀', 'cheese'],
  ['🍔', 'burger'],
  ['🍟', 'fries'],
  ['🍕', 'pizza'],
  ['🌭', 'hotdog'],
  ['🍜', 'ramen'],
  ['🍩', 'donut'],
  ['🎂', 'birthday'],
  ['🍰', 'cake'],
  ['☕', 'coffee'],
  ['🍵', 'tea'],
  ['🍺', 'beer'],
  ['🍻', 'beers'],
  ['🥂', 'cheers'],
  ['🍷', 'wine'],
  ['🍸', 'cocktail'],
  ['⚽', 'soccer'],
  ['🏀', 'basketball'],
  ['🏈', 'football'],
  ['🎾', 'tennis'],
  ['🎱', '8ball'],
  ['🏓', 'ping_pong'],
  ['🏸', 'badminton'],
  ['⛳', 'golf'],
  ['🥇', '1st_place_medal gold_medal'],
  ['🥈', '2nd_place_medal'],
  ['🥉', '3rd_place_medal'],
  ['🏅', 'medal'],
  ['🎲', 'dice'],
  ['🧩', 'jigsaw puzzle'],
  ['♟️', 'chess_pawn'],
  ['🎯', 'dart target bullseye'],
  ['🥁', 'drum'],
  ['🎬', 'clapper'],
  ['🎨', 'art'],
  ['🎟️', 'tickets'],
  ['🚗', 'car'],
  ['🚲', 'bike'],
  ['🏍️', 'motorcycle'],
  ['⛵', 'boat'],
  ['🏠', 'house'],
  ['🏖️', 'beach_umbrella beach'],
  ['🏔️', 'mountain_snow'],
  ['💻', 'computer laptop'],
  ['🖱️', 'computer_mouse'],
  ['📱', 'iphone phone'],
  ['📺', 'tv'],
  ['💡', 'bulb idea'],
  ['🔦', 'flashlight'],
  ['🛠️', 'tools'],
  ['🔓', 'unlock'],
  ['📌', 'pin'],
  ['✂️', 'scissors'],
  ['📖', 'book'],
  ['✏️', 'pencil2'],
  ['🎁', 'gift present'],
  ['🎉', 'tada party'],
  ['🛒', 'shopping_cart'],
  ['💰', 'moneybag'],
  ['💵', 'dollar'],
  ['💎', 'gem'],
  ['✅', 'white_check_mark check done'],
  ['☑️', ''],
  ['❌', 'x'],
  ['❎', ''],
  ['🚫', 'no_entry_sign'],
  ['❗', 'exclamation'],
  ['❓', 'question'],
  ['‼️', 'bangbang'],
  ['⁉️', 'interrobang'],
  ['💯', '100'],
  ['🔥', 'lit'],
  ['💥', 'boom'],
  ['💤', 'zzz'],
  ['🔕', 'no_bell'],
  ['🎶', 'notes'],
  ['➕', 'heavy_plus_sign plus'],
  ['➖', 'heavy_minus_sign minus'],
  ['➗', 'heavy_division_sign'],
  ['♾️', 'infinity'],
  ['💲', 'heavy_dollar_sign'],
  ['™️', 'tm'],
  ['🔴', 'red_circle'],
  ['🟠', 'orange_circle'],
  ['🟡', 'yellow_circle'],
  ['🟢', 'green_circle'],
  ['🔵', 'blue_circle'],
  ['🟣', 'purple_circle'],
  ['⚫', 'black_circle'],
  ['⚪', 'white_circle'],
  ['🔺', 'small_red_triangle'],
  ['🔻', 'small_red_triangle_down'],
  ['🔄', 'arrows_counterclockwise'],
  ['🔁', 'repeat'],
  ['▶️', 'arrow_forward play'],
  ['⏸️', 'pause_button pause'],
  ['⏩', 'fast_forward'],
  ['⏪', 'rewind'],
  ['🆗', 'ok'],
  ['🆒', 'cool'],
  ['🆕', 'new'],
  ['🆓', 'free'],
  ['🔝', 'top'],
  ['🔚', 'end'],
  ['🔜', 'soon'],
  ['🏁', 'checkered_flag'],
  ['🚩', 'red_flag'],
  ['🏳️', 'white_flag'],
  ['🏴', 'black_flag'],
];

/**
 * The emoji a chat reaches for most, most first. Within a tier they lead, so
 * `:th` offers 👍 before `thanks` and `thinking`, and `:hea` offers ❤️ and 😍
 * before `heartbeat`. Everything else keeps the shorter-code-first order.
 */
const POPULAR: readonly string[] = [
  '👍', '❤️', '😂', '🎉', '🔥', '🙏', '👀', '✅', '😊', '🤔', '💯', '👏', '🚀',
  '😭', '😍', '🙌', '✨', '😅', '👎', '😢', '😎', '🤣', '👋', '💪', '🥳', '😉',
];
const POPULAR_RANK = new Map(POPULAR.map((emoji, i) => [emoji, i]));

/** `thumbs up` → `thumbs_up`; `see-no-evil monkey` → `see_no_evil_monkey`. */
export function slugifyEmojiName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

interface Indexed {
  emoji: string;
  /** Aliases first, then the slug — the order the display code is picked in. */
  codes: string[];
  /** How many of `codes` are aliases rather than the slug. */
  aliases: number;
  /** The name and search terms as space-separated words, for the last tier. */
  words: string;
  order: number;
}

const INDEX: Indexed[] = [];
const BY_CODE = new Map<string, string>();

(() => {
  const aliasesFor = new Map<string, string[]>();
  for (const [emoji, codes] of ALIASES) aliasesFor.set(emoji, codes.split(' ').filter(Boolean));
  // An alias outranks another emoji's slug (`sleeping` is 😴, as it is on
  // Discord; 💤 is `zzz`), so every alias is claimed before any slug.
  for (const entry of ALL_EMOJI) {
    for (const code of aliasesFor.get(entry.emoji) || []) {
      if (!BY_CODE.has(code)) BY_CODE.set(code, entry.emoji);
    }
  }
  for (const entry of ALL_EMOJI) {
    const slug = slugifyEmojiName(entry.name);
    if (slug && !BY_CODE.has(slug)) BY_CODE.set(slug, entry.emoji);
  }
  ALL_EMOJI.forEach((entry, order) => {
    const candidates = [...(aliasesFor.get(entry.emoji) || []), slugifyEmojiName(entry.name)];
    const codes = [...new Set(candidates)].filter((code) => BY_CODE.get(code) === entry.emoji);
    if (!codes.length) return;
    const slug = slugifyEmojiName(entry.name);
    const aliases = codes.filter((code) => code !== slug).length;
    const words = ` ${`${entry.name} ${entry.terms}`.toLowerCase().replace(/[^a-z0-9+]+/g, ' ').trim()}`;
    INDEX.push({ emoji: entry.emoji, codes, aliases, words, order });
  });
})();

/** The emoji a complete shortcode names — `tada` → 🎉 — or null. */
export function emojiForShortcode(code: string): string | null {
  return BY_CODE.get(String(code || '').toLowerCase()) || null;
}

/** Every code an emoji answers to, the one the menu shows first. */
export function shortcodesFor(emoji: string): string[] {
  return INDEX.find((item) => item.emoji === emoji)?.codes.slice() || [];
}

export interface ShortcodeMatch {
  emoji: string;
  /** The code to draw beside it, without colons: `thumbsup`. */
  shortcode: string;
}

/**
 * Up to `limit` emoji for a `:query` (without the colon), best first:
 *
 *   1. a shortcode that IS the query          `:tada`  → 🎉
 *   2. shortcodes that start with it          `:thu`   → 👍 👎
 *   3. shortcodes that contain it             `:check` → ☑️ (ballot_box_with_check)
 *   4. a name or search word that starts with it  `:lol` → 😂
 *
 * Within a tier the popular emoji lead when a code people type matched
 * (POPULAR: `:th` offers 👍 `thumbsup` first), then
 * the shorter code (`:hea`… ❤️ `heart` before 💓 `heartbeat`), then the
 * picker's order. The code shown is the emoji's first
 * code that matched — aliases lead, so `:thu` shows `thumbsup`, while
 * `:thumbs_` shows `thumbs_up` because that is the one being typed.
 */
export function matchShortcodes(query: string, limit = 8): ShortcodeMatch[] {
  const q = String(query || '').toLowerCase();
  if (!q || limit <= 0) return [];
  // `thumbs_up` / `see-no` read as words; a leading sign stays (`-1`).
  const words = ` ${q.replace(/(?!^)[_-]+/g, ' ').trim()}`;
  const hits: { tier: number; code: string; rank: number; order: number; emoji: string }[] = [];
  for (const item of INDEX) {
    let tier = -1;
    let code = '';
    let typed = false;
    for (let i = 0; i < item.codes.length; i++) {
      const candidate = item.codes[i];
      const t = candidate === q ? 0 : candidate.startsWith(q) ? 1 : candidate.includes(q) ? 2 : -1;
      if (t < 0 || (tier >= 0 && t >= tier)) continue;
      tier = t;
      code = candidate;
      // A code people type: an alias, or a slug of one or two words.
      typed = i < item.aliases || candidate.split('_').length <= 2;
    }
    if (tier < 0 && words.trim() && item.words.includes(words)) {
      tier = 3;
      code = item.codes[0];
    }
    if (tier < 0) continue;
    // Popularity only lifts a row matched through a code people type: 😅
    // reached by `:smi` through its long Unicode slug is not what `:smi` is
    // reaching for.
    const rank = typed ? POPULAR_RANK.get(item.emoji) ?? POPULAR.length : POPULAR.length;
    hits.push({ tier, code, rank, order: item.order, emoji: item.emoji });
  }
  hits.sort((a, b) => a.tier - b.tier
    || a.rank - b.rank
    || a.code.length - b.code.length
    || a.order - b.order);
  return hits.slice(0, limit).map(({ emoji, code }) => ({ emoji, shortcode: code }));
}

export interface ShortcodeToken {
  /** Index of the `:` in the text. */
  start: number;
  /** The name characters typed after it, lower-cased: `th`. */
  query: string;
}

/**
 * The open `:query` ending at the caret — what the menu is for — or null.
 * Needs SHORTCODE_MIN_QUERY name characters, a token boundary before the
 * `:`, and a collapsed caret (pass `selectionEnd` to rule out a range).
 */
export function findShortcodeToken(text: string, caret: number, selectionEnd: number = caret): ShortcodeToken | null {
  if (caret == null || caret !== selectionEnd || caret < 0) return null;
  const before = String(text || '').slice(0, caret);
  const m = before.match(OPEN_TOKEN);
  if (!m || m.index === undefined) return null;
  return { start: m.index + m[1].length, query: m[2].toLowerCase() };
}

export interface ShortcodeCompletion {
  /** Index of the opening `:`. */
  start: number;
  /** Index just past the closing `:` (the caret). */
  end: number;
  emoji: string;
}

/**
 * A complete, known `:code:` ending at the caret — `:tada:` — which the
 * composer swaps for its emoji the moment the closing colon is typed. An
 * unknown code (`:nope:`) is left as typed.
 */
export function completedShortcodeAt(text: string, caret: number): ShortcodeCompletion | null {
  if (caret == null || caret < 2) return null;
  const before = String(text || '').slice(0, caret);
  const m = before.match(CLOSED_TOKEN);
  if (!m || m.index === undefined) return null;
  const emoji = emojiForShortcode(m[2]);
  if (!emoji) return null;
  return { start: m.index + m[1].length, end: caret, emoji };
}

/**
 * Put `emoji` (and `suffix`) where the token from `start` to `caret` was.
 * Returns the new text and where the caret goes.
 */
export function replaceShortcodeToken(
  text: string,
  start: number,
  caret: number,
  emoji: string,
  suffix = ' ',
): { value: string; caret: number } {
  const head = text.slice(0, start) + emoji + suffix;
  return { value: head + text.slice(caret), caret: head.length };
}
