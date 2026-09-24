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
