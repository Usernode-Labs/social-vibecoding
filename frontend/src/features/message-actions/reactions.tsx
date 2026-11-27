import { ReactionPill } from '@/components/ui/feed';

import { useMessages } from '../../lib/i18n/react';
import { listText } from '../../lib/i18n/runtime';
import { emojiName } from './emoji-data';

/**
 * THE REACTIONS UNDER A MESSAGE, DRAWN ONCE: one ReactionPill per emoji
 * (@/components/ui/feed), the viewer's own in the accent tint, its people
 * named in the title.
 *
 * Messages drew its own chip (a bare button over `.messages-reactions
 * button` in app.css) and a project's channel drew @/components/ui/feed's
 * pill: the same emoji-and-count in two shapes that had drifted in size and
 * colour. Every message row, notice and shared plan draws this one now; the
 * project Discussion already drew the same pill.
 *
 * A tap toggles the viewer's reaction, through `onToggle`, which goes to the
 * place's own store or socket. A reader who cannot react (signed out, or
 * read-only here) still sees who reacted, but a tap does nothing.
 */
export interface ReactionView {
  emoji: string;
  count: number;
  /** The viewer reacted with it. */
  mine: boolean;
  /** Who reacted, for the title. */
  users?: readonly string[] | null;
}

export function MessageReactions({
  reactions, onToggle, className, id, keepEmpty = false,
}: {
  reactions: readonly ReactionView[];
  onToggle?: ((emoji: string) => void) | null;
  /** The place's own container class (dapp.json's checks select on it). */
  className: string;
  id?: string;
  /** Draw the empty container too: a place whose CSS keys off `:empty`. */
  keepEmpty?: boolean;
}) {
  const t = useMessages('messages');
  if (!reactions.length && !keepEmpty) return null;
  return (
    <div className={className} id={id}>
      {reactions.map((reaction) => (
        <ReactionPill
          key={reaction.emoji}
          emoji={reaction.emoji}
          count={reaction.count}
          tone={reaction.mine ? 'accent' : 'neutral'}
          aria-pressed={reaction.mine}
          aria-label={t('messages:actions.reactionChip', { emoji: emojiName(reaction.emoji), count: reaction.count })}
          title={reaction.users?.length ? listText([...reaction.users]) : undefined}
          data-emoji={reaction.emoji}
          onClick={onToggle ? () => onToggle(reaction.emoji) : undefined}
        />
      ))}
    </div>
  );
}
