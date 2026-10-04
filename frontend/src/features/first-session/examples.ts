/**
 * The three examples of what groups make, shown on the signed-out story
 * (../auth/story.tsx) and offered as starting points on "What do you want
 * to make?" (./make.tsx), where picking one fills in both fields.
 *
 * Group-shaped and used week after week, as the first-session plan asks
 * (its Q4): a running club's tracker, a movie night's poll, a weekend's
 * planner. Placeholders until they are chosen for real; they live here so
 * the two screens say the same three things.
 */

export type Example = {
  key: string;
  emoji: string;
  /** "A run tracker", on the story. */
  title: string;
  /** What it is for, under the title on the story. */
  line: string;
  /** "Run tracker", on the make screen's tile. */
  short: string;
  /** Filled into "What should it do?". */
  brief: string;
  /** Filled into "What should we call it?". */
  name: string;
  /** The project's one-line description (create-options DESCRIPTION_MAX, 90). */
  description: string;
  /** Suggested for the invite's note. */
  note: string;
};

export const EXAMPLES: readonly Example[] = [
  {
    key: 'run',
    emoji: '🏃',
    title: 'A run tracker',
    line: 'Weekly miles for a running club',
    short: 'Run tracker',
    brief: 'A tracker for our weekly miles, so we can see who\'s keeping up',
    name: 'Sunday Run Club',
    description: 'A run tracker',
    note: 'Made us a tracker. Come add to it!',
  },
  {
    key: 'poll',
    emoji: '🎬',
    title: 'A movie-night poll',
    line: 'Pick Friday\'s film together',
    short: 'Movie-night poll',
    brief: 'A poll to pick what we watch on movie night, from everyone\'s suggestions',
    name: 'Friday Film Crew',
    description: 'A movie-night poll',
    note: 'Made us a movie poll. Add your picks!',
  },
  {
    key: 'trip',
    emoji: '🏕️',
    title: 'A trip planner',
    line: 'Dates, beds and who brings what',
    short: 'Trip planner',
    brief: 'A planner for our lake house weekend: the dates, who sleeps where, and who brings what',
    name: 'Lake House Gang',
    description: 'A trip planner',
    note: 'Made us a planner for the trip. Add what you\'re bringing!',
  },
];
