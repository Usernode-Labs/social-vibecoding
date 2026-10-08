/**
 * The starting points on "What do you want to make?" (./make.tsx), and the
 * three things the signed-out story (../auth/story.tsx) says groups make.
 * They live here so the two screens say the same three things.
 *
 * Evan, 8 October 2026: the three examples (a running club's tracker, a
 * movie night's poll, a weekend's planner) became sentences to finish. Each
 * one is something a group needs more than once, and each is filled in with
 * a tap or two while leaving the part that makes it theirs to them: what the
 * tier list ranks, what the organizer keeps and, for a game, the idea
 * itself, because the fun of a game is in what you build. The make screen's
 * fourth tile, Your own idea, is the plain description box.
 *
 * A template is a sentence with one blank: `head`, then the chosen choice's
 * `fill` (or the maker's own words), then that choice's `tail` or the
 * template's. A `finish` template (the game) always ends in the maker's own
 * words, typed in a box under the sentence, and its Your own comes first.
 *
 * READY-MADE. Every choice that needs no typing (the tier list's four, the
 * organizer's four) names a `template`: one of Homeroom's ready-made apps
 * (services/app-templates.js), which Make it makes instead of asking
 * Homeroom bot to build a first version, so the project is usable as soon
 * as it runs. Its `emoji` is that app's icon. Your own words, and every
 * game, still go to Homeroom bot.
 */

/** The choice that puts the maker's own words in the blank. */
export const OWN = 'own';

export type Choice = {
  key: string;
  /** On its chip. */
  label: string;
  /** What it puts in the blank: "hikes", or a finishing template's starter, "a board game where". */
  fill: string;
  /** In place of the template's tail. */
  tail?: string;
  /** A finishing template's example of the rest, in its box. */
  example?: string;
  /** Suggested for "What should we call it?". */
  name: string;
  /** The project's one-line description (create-options DESCRIPTION_MAX, 90). */
  description: string;
  /** The ready-made app it makes (services/app-templates.js READY_IDS), with nothing to build. */
  template?: string;
  /** That app's icon (its entry's `icon`), where it is not the template's own emoji. */
  emoji?: string;
};

export type Template = {
  key: string;
  /** On the tile and the story, and the project's tile until its sketch has an emoji. */
  emoji: string;
  /** Drawn in place of the emoji (./marks.tsx): the tier list's mini chart, the game's gamepad, the organizer's checklist. */
  mark?: 'chart' | 'game' | 'organizer';
  /** "A tier list", on the story. */
  title: string;
  /** What it is for, under the title on the story. */
  line: string;
  /** "Tier list", on the make screen's tile. */
  short: string;
  /** The sentence up to its blank. */
  head: string;
  /** The sentence after its blank, unless the choice has its own. */
  tail: string;
  choices: readonly Choice[];
  /**
   * Your own: the example in its blank, the name it suggests (`{words}` is
   * theirs; empty suggests none) and the project's description.
   */
  own: { example: string; name: string; description: string };
  /** Always finished in the maker's own words; Your own comes first and is picked first. */
  finish?: boolean;
  /**
   * Suggested for the invite's note. It is sent while the app is still being
   * made, so it says "I'm making", never "Made us", and it has no "!" (#4042).
   */
  note: string;
};

export const TEMPLATES: readonly Template[] = [
  {
    key: 'tier',
    emoji: '📊',
    mark: 'chart',
    title: 'A tier list',
    line: 'Rank your favorite spots, games, anything',
    short: 'Tier list',
    head: 'A tier list for our favorite ',
    tail: '. Anyone can add items, everyone sorts them, and we can see where they land.',
    choices: [
      { key: 'restaurants', label: 'Restaurants', fill: 'restaurants', name: 'Restaurant Tier List', description: 'A restaurant tier list', template: 'tier-list-restaurants' },
      { key: 'hikes', label: 'Hikes', fill: 'hikes', name: 'Hiking Tier List', description: 'A hiking tier list', template: 'tier-list-hikes' },
      { key: 'cities', label: 'Cities', fill: 'cities', name: 'City Tier List', description: 'A city tier list', template: 'tier-list-cities' },
      { key: 'games', label: 'Games', fill: 'games', name: 'Game Tier List', description: 'A game tier list', template: 'tier-list-games' },
    ],
    own: { example: 'taco spots', name: '{words} Tier List', description: 'A tier list' },
    note: 'I\'m making us a tier list. Join and tell me what it needs.',
  },
  {
    key: 'game',
    emoji: '🎮',
    mark: 'game',
    title: 'A game',
    line: 'A new one, built and played together',
    short: 'A game',
    head: 'A new game we build together. For the first version, ',
    tail: '',
    finish: true,
    choices: [
      { key: 'board', label: 'Board game', fill: 'a board game where', example: 'we roll dice and race each other around the board', name: 'Board Game Night', description: 'A board game' },
      { key: 'shooter', label: 'Space shooter', fill: 'an arcade space shooter where', example: 'we fly together against waves of asteroids', name: 'Space Shooter', description: 'An arcade space shooter' },
      { key: 'blocks', label: '3D blocks', fill: 'a 3D block game where', example: 'we build whatever we want together', name: 'Block World', description: 'A 3D block game' },
      { key: 'trivia', label: 'Trivia', fill: 'a trivia game where', example: 'every question is about one of us', name: 'Trivia Night', description: 'A trivia game' },
    ],
    own: { example: 'a drawing game where one of us draws and everyone guesses', name: '', description: 'A game' },
    note: 'I\'m making us a game. Join and tell me what it needs.',
  },
  {
    key: 'organizer',
    emoji: '📋',
    mark: 'organizer',
    title: 'An organizer',
    line: 'Groceries, chores, a shared library',
    short: 'Organizer',
    head: 'An app to organize our ',
    tail: ', so everyone can see what\'s where and who\'s on it.',
    choices: [
      { key: 'groceries', label: 'Groceries', fill: 'groceries', tail: ': one shared list, and whoever\'s at the store checks things off.', name: 'Grocery List', description: 'A grocery list', template: 'grocery-list', emoji: '🛒' },
      { key: 'chores', label: 'Chores', fill: 'chores', tail: ': who\'s on what this week, and whose turn it is next.', name: 'Chore List', description: 'A chore list', template: 'chore-list', emoji: '🧹' },
      { key: 'library', label: 'Shared library', fill: 'shared library', tail: ': what we can borrow, who has it now, and who\'s asking for it next.', name: 'Lending Library', description: 'A lending library', template: 'lending-library', emoji: '📚' },
      { key: 'potlucks', label: 'Potlucks', fill: 'potlucks', tail: ': who\'s bringing what, so we don\'t end up with six salads.', name: 'Potluck Planner', description: 'A potluck planner', template: 'potluck-planner', emoji: '🍲' },
    ],
    own: { example: 'camping gear', name: '{words} List', description: 'An organizer' },
    note: 'I\'m making us an organizer. Join and tell me what it needs.',
  },
];

/** The choice a tap on the template's tile picks: its first, or Your own for a game. */
export function firstChoice(t: Template): string {
  return t.finish ? OWN : t.choices[0].key;
}

function choiceOf(t: Template, key: string): Choice | null {
  return t.choices.find((c) => c.key === key) || null;
}

/** The maker's own words, one space apart. */
function tidy(words: string): string {
  return words.trim().replace(/\s+/g, ' ');
}

export type Sentence = {
  head: string;
  /** What stands in the blank: the choice's words, or theirs. */
  fill: string;
  tail: string;
  /** The whole description, as Make it sends it. */
  text: string;
  /** Their words are still missing where the template needs them. */
  blank: boolean;
};

/**
 * The description a template, a choice and the maker's own words make. A
 * finishing template is its head, the choice's starter and their words,
 * with a full stop if they left one off.
 */
export function sentence(t: Template, key: string, words: string): Sentence {
  const c = key === OWN ? null : choiceOf(t, key);
  const own = tidy(words);
  if (t.finish) {
    const end = own && !/[.!?]$/.test(own) ? '.' : '';
    return { head: t.head, fill: c ? c.fill : '', tail: '', text: `${t.head}${c ? `${c.fill} ` : ''}${own}${end}`, blank: !own };
  }
  const fill = c ? c.fill : own;
  const tail = (c && c.tail) || t.tail;
  return { head: t.head, fill, tail, text: `${t.head}${fill}${tail}`, blank: !fill };
}

/** The name a choice suggests: "Hiking Tier List", or theirs in the template's pattern. */
export function suggestedName(t: Template, key: string, words: string): string {
  if (key !== OWN) return choiceOf(t, key)?.name || '';
  const own = tidy(words).split(' ').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  return own && t.own.name ? t.own.name.replace('{words}', own) : '';
}

/**
 * The ready-made app a choice makes, and its icon, or null: for Your own
 * words, a game, or a choice that has none.
 */
export function readyMadeOf(t: Template, key: string): { template: string; emoji: string } | null {
  const c = key === OWN ? null : choiceOf(t, key);
  return c && c.template ? { template: c.template, emoji: c.emoji || t.emoji } : null;
}

/** The project's one-line description for a choice. */
export function descriptionOf(t: Template, key: string): string {
  return (key !== OWN && choiceOf(t, key)?.description) || t.own.description;
}
