import { LocalizedValue, LocalizedDynamic } from "../../lib/i18n/react";
import { t as tr } from "../../lib/i18n/runtime";
/**
 * The general chat's quiet card: what a visitor meets when nobody has posted.
 *
 * The general chat is rarely EMPTY, because the app's own activity notices
 * land in it, so a classic empty state would never fire; and the pane's
 * one-time intro banner (./general-chat.tsx) is gone after the first visit.
 * What that left for a visitor on a quiet app was a wall of notices and a
 * composer, with nothing saying that this is a place for people. This card
 * says so, in the one moment it is true: after the rows, right above the
 * composer, only while no message from a person is among the loaded ones.
 * The first reply makes it go away.
 *
 * Three facts come from public/js/group-chat.js through the transcript lead,
 * because the card cannot know them: whether history has been paged back to
 * the beginning (so "yet" is honest, and "lately" is used otherwise), whether
 * the viewer can post (a read-only viewer is not asked to say hi), and the
 * app's name, which is user content and lands as a text child.
 */

export interface QuietCardProps {
  exhausted: boolean;
  canPost: boolean;
  appName: string;
  /**
   * 'change' is a proposal's own Discussion (topic/conversation.tsx), where
   * the same quiet card asks about this change rather than about the app.
   */
  variant?: 'app' | 'change';
}

export function QuietCard({ exhausted, canPost, appName, variant = 'app' }: QuietCardProps) {
  const change = variant === 'change';
  return (
    <div className="gc-quiet mx-3 my-3 rounded-2xl bg-zinc-100 px-4 py-4 text-center dark:bg-zinc-800" data-quiet-chat={change ? 'change' : ''}>
      <div className="text-[15px] font-semibold leading-snug text-zinc-900 dark:text-zinc-100">
        <LocalizedValue render={() => (change
          ? (exhausted ? tr("workshop:nobody_has_commented_on_this_change_yet_903cd047") : tr("workshop:it_has_been_quiet_on_this_change_lately_9a8db0cf"))
          : (exhausted ? tr("workshop:nobody_has_said_anything_here_yet_6c5358e4") : tr("workshop:it_has_been_quiet_in_here_lately_c6d444c4")))} />
      </div>
      <div className="mt-1 text-[13px] leading-snug text-zinc-500 dark:text-zinc-400">
        <LocalizedValue render={() => (change
          ? (canPost
            ? tr("workshop:ask_a_question_or_say_what_you_think_of_it_6c64b0ff")
            : tr("workshop:comments_from_the_group_will_show_up_here_bceea7a3"))
          : (canPost
            ? tr("workshop:say_hi_ask_a_question_or_share_what_you_would_li_314391d4", { value1: appName })
            : tr("workshop:messages_from_the_people_building_value1_will_sh_11b46885", { value1: appName })))} />
      </div>
    </div>
  );
}
