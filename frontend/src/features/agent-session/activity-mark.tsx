import { SpinnerArcIcon } from '@/components/ui/icons';

import { ACTIVITY_LABEL, type AgentActivity } from './activity';

/**
 * The mark beside an agent session in a list (./activity.ts): a spinner while
 * it works, a green dot once it has finished something you have not seen.
 * Nothing otherwise. The green is the live-app dot's (#22c55e, `green-500`).
 */
export function AgentActivityMark({ activity, className = '' }: { activity: AgentActivity; className?: string }) {
  if (!activity) return null;
  const label = ACTIVITY_LABEL[activity];
  if (activity === 'working') {
    return (
      <span role="img" aria-label={label} title={label} data-agent-activity="working" className={`inline-flex shrink-0 ${className}`}>
        <SpinnerArcIcon className="h-3.5 w-3.5 animate-spin text-violet-600 dark:text-violet-400" aria-hidden="true" />
      </span>
    );
  }
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      data-agent-activity="done"
      className={`inline-block h-2 w-2 shrink-0 rounded-full bg-green-500 ${className}`}
    />
  );
}

/**
 * The spinner IN PLACE of a row's own icon while its session works (#3028):
 * Recents and the Homeroom menu's Continue rows swap their app tile or glyph
 * for it rather than draw it beside, so a working session reads as one mark,
 * not two. Sized by the slot it takes (`className`), and decoration only:
 * each row says "working" in words (Recents' aria-label, the menu row's and
 * Messages' sr-only text). The finished dot takes the slot too now
 * (AgentDoneIcon below, #3076).
 */
export function AgentWorkingIcon({ className = '' }: { className?: string }) {
  return (
    <SpinnerArcIcon
      className={`animate-spin text-violet-600 dark:text-violet-400 ${className}`}
      aria-hidden="true"
      data-agent-activity="working"
    />
  );
}

/**
 * The finished dot IN PLACE of a row's own icon (#3076), the way the spinner
 * above takes it while the session works: Recents, the Homeroom menu's
 * Continue rows and Messages' Agents list draw one mark where the icon was,
 * never an icon and a mark. The dot keeps its size (the live-app dot's
 * `h-2 w-2`) and is centred in a box the slot sizes (`className`), so the
 * row's name starts where it always does. Decoration only, like the spinner:
 * each row says "Finished" in words.
 */
export function AgentDoneIcon({ className = '' }: { className?: string }) {
  return (
    <span aria-hidden="true" data-agent-activity="done" className={`inline-flex shrink-0 items-center justify-center ${className}`}>
      <span className="h-2 w-2 rounded-full bg-green-500" />
    </span>
  );
}

/** Whichever of the two takes the icon's place, or nothing. */
export function AgentActivityIcon({ activity, className = '' }: { activity: AgentActivity; className?: string }) {
  if (activity === 'working') return <AgentWorkingIcon className={className} />;
  if (activity === 'done') return <AgentDoneIcon className={className} />;
  return null;
}
