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

import { useMessages } from '../../lib/i18n/react';

export interface QuietCardProps {
  exhausted: boolean;
  canPost: boolean;
  appName: string;
  /**
   * 'change' is a thread in the chat language about one change, where the
   * same quiet card asks about this change rather than about the app. (A
   * change's own page draws its stream as a thread since #4455.)
   */
  variant?: 'app' | 'change';
}

export function QuietCard({ exhausted, canPost, appName, variant = 'app' }: QuietCardProps) {
  const t = useMessages('chat');
  const change = variant === 'change';
  return (
    <div className="gc-quiet mx-3 my-3 rounded-2xl bg-zinc-100 px-4 py-4 text-center dark:bg-zinc-800" data-quiet-chat={change ? 'change' : ''}>
      <div className="text-[15px] font-semibold leading-snug text-zinc-900 dark:text-zinc-100">
        {change
          ? (exhausted ? t('chat:group.quiet.change.nobody') : t('chat:group.quiet.change.lately'))
          : (exhausted ? t('chat:group.quiet.app.nobody') : t('chat:group.quiet.app.lately'))}
      </div>
      <div className="mt-1 text-[13px] leading-snug text-zinc-500 dark:text-zinc-400">
        {change
          ? (canPost
            ? t('chat:group.quiet.change.invite')
            : t('chat:group.quiet.change.readOnly'))
          : (canPost
            ? (appName ? t('chat:group.quiet.app.invite', { app: appName }) : t('chat:group.quiet.app.inviteUnnamed'))
            : (appName ? t('chat:group.quiet.app.readOnly', { app: appName }) : t('chat:group.quiet.app.readOnlyUnnamed')))}
      </div>
    </div>
  );
}
