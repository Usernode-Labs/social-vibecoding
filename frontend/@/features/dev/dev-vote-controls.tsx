import { ThumbsDown, ThumbsUp, Vote } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { PlatformIcon } from "@/components/platform-icon"

type ProposalVote = "yes" | "no"
type GovernanceVote = "up" | "down"
type VoteKind = "proposal" | "governance"

export type DevVoteControlsProps = {
  disabled?: boolean
  kind: VoteKind
  noCount: number | string
  onVote: (vote: ProposalVote | GovernanceVote) => void
  pending?: boolean
  required?: number | string | null
  selectedVote?: string | null
  yesCount: number | string
}

function count(value: number | string | null | undefined) {
  return Number(value || 0)
}

/**
 * Shared, server-driven vote controls for promoted PRs and governance
 * proposals. This intentionally has no optimistic tally mutation: both
 * backend routes can change lifecycle state after a vote, so the owning
 * detail route reloads the canonical forum snapshot on success.
 */
export function DevVoteControls({ disabled = false, kind, noCount, onVote, pending = false, required, selectedVote = null, yesCount }: DevVoteControlsProps) {
  const proposal = kind === "proposal"
  const affirmative = proposal ? "yes" : "up"
  const negative = proposal ? "no" : "down"
  const tally = `${count(yesCount)} for${required ? ` / ${count(required)}` : ""}${count(noCount) ? ` · ${count(noCount)} against` : ""}`
  const unavailable = disabled || pending

  return <div className="flex flex-wrap items-center gap-2" aria-label={proposal ? "Vote on this proposal" : "Vote on this governance proposal"} role="group">
    <Badge className="tabular-nums" variant="outline"><PlatformIcon data-icon="inline-start" icon={Vote} />{tally}</Badge>
    <Button aria-pressed={selectedVote === affirmative} disabled={unavailable} onClick={() => onVote(affirmative)} size="sm" type="button" variant={selectedVote === affirmative ? "secondary" : "outline"}>
      <PlatformIcon data-icon="inline-start" icon={ThumbsUp} />Yes <span className="tabular-nums">({count(yesCount)})</span>
    </Button>
    <Button aria-pressed={selectedVote === negative} disabled={unavailable} onClick={() => onVote(negative)} size="sm" type="button" variant={selectedVote === negative ? "secondary" : "outline"}>
      <PlatformIcon data-icon="inline-start" icon={ThumbsDown} />No <span className="tabular-nums">({count(noCount)})</span>
    </Button>
    {pending ? <span className="text-base text-muted-foreground sm:text-sm" role="status">Recording vote…</span> : null}
  </div>
}
