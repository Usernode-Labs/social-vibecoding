import { t as tr } from "../../lib/i18n/runtime";
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
    get title() { return tr("auth:a_run_tracker_72fe97be"); },
    get line() { return tr("auth:weekly_miles_for_a_running_club_96ec85b8"); },
    get short() { return tr("auth:run_tracker_f2f76bc5"); },
    get brief() { return tr("auth:a_tracker_for_our_weekly_miles_so_we_can_see_who_19fd9b5d"); },
    get name() { return tr("auth:sunday_run_club_fd6fcdde"); },
    get description() { return tr("auth:a_run_tracker_72fe97be"); },
    get note() { return tr("auth:made_us_a_tracker_come_add_to_it_88326b44"); },
  },
  {
    key: 'poll',
    emoji: '🎬',
    get title() { return tr("auth:a_movie_night_poll_96e321e9"); },
    get line() { return tr("auth:pick_friday_s_film_together_0725f514"); },
    short: 'Movie-night poll',
    get brief() { return tr("auth:a_poll_to_pick_what_we_watch_on_movie_night_from_9726f6c8"); },
    get name() { return tr("auth:friday_film_crew_153fcb55"); },
    get description() { return tr("auth:a_movie_night_poll_96e321e9"); },
    get note() { return tr("auth:made_us_a_movie_poll_add_your_picks_0efb2a95"); },
  },
  {
    key: 'trip',
    emoji: '🏕️',
    get title() { return tr("auth:a_trip_planner_0df0f83c"); },
    get line() { return tr("auth:dates_beds_and_who_brings_what_d806df0f"); },
    get short() { return tr("auth:trip_planner_df3c429a"); },
    get brief() { return tr("auth:a_planner_for_our_lake_house_weekend_the_dates_w_25e5a30c"); },
    get name() { return tr("auth:lake_house_gang_bdcbf0be"); },
    get description() { return tr("auth:a_trip_planner_0df0f83c"); },
    get note() { return tr("auth:made_us_a_planner_for_the_trip_add_what_you_re_b_4ba97697"); },
  },
];
