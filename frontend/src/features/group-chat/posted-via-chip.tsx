/**
 * "via agent" — the small chip a message wears beside its author's name when a
 * coding agent posted it on that person's behalf through the Homeroom MCP
 * connector (#2236).
 *
 * The fact comes from the server (`posted_via` on a loaded row, `postedVia`
 * on a live one), which derives it from the connector credential the write
 * arrived with and from nothing the client sent. So the chip is a claim the
 * reader can trust: without it the note reads exactly like something the
 * person typed, and a collaborator answering "you" would be answering a tool.
 *
 * One component for both surfaces that draw a human reply — the topic page's
 * transcript row (transcript.tsx) and the Activity feed's bubble
 * (dev-board/card/feed-thread.tsx) — so the chip cannot drift between them.
 * The row itself carries `data-posted-via` so a check (and a stylesheet) can
 * address the whole message, not only the chip.
 */

import { SparklesIcon } from '@/components/ui/icons';

/** The values the server may write; anything else draws nothing. */
export type PostedVia = 'agent';

export function postedViaOf(value: unknown): PostedVia | null {
  return value === 'agent' ? 'agent' : null;
}

export function PostedViaChip({ via, className }: {
  via: PostedVia | null | undefined;
  /** The transcript's name span has no gap of its own; the feed head does. */
  className?: string;
}) {
  if (via !== 'agent') return null;
  return (
    <span
      className={`gc-posted-via inline-flex shrink-0 items-center gap-0.5 rounded-full border border-violet-200 bg-violet-50 px-1.5 align-middle text-[11px] font-medium leading-4 text-violet-700 dark:border-violet-500/30 dark:bg-violet-500/15 dark:text-violet-300${className ? ` ${className}` : ''}`}
      title="Posted by a coding agent on this person's behalf"
    >
      <SparklesIcon className="h-3 w-3" strokeWidth="1.75" aria-hidden="true" />
      via agent
    </span>
  );
}
