import { cn } from "@/lib/utils"

export type StatusDotRole = "positive" | "info" | "warning" | "negative" | "attention" | "neutral"

export type StatusDotPresentation = {
  role: StatusDotRole
  label: string
}

export type StatusDotProps = {
  role: StatusDotRole
  subject: string
  label: string
  detail?: string
  size?: "sm" | "md"
  showLabel?: boolean
  className?: string
}

const sizes = {
  sm: "size-2",
  md: "size-2.5",
} as const

/**
 * A compact, semantic state marker. Callers map domain state to a finite role
 * and supply the human label; raw API strings never select visual colors.
 */
export function StatusDot({ className, detail, label, role, showLabel = true, size = "md", subject }: StatusDotProps) {
  const normalizedSubject = subject.trim()
  const normalizedState = label.trim()
  if (!normalizedSubject || !normalizedState) {
    throw new Error("StatusDot requires non-empty subject and state labels")
  }
  const accessibleState = `${normalizedState.slice(0, 1).toLocaleLowerCase()}${normalizedState.slice(1)}`
  const accessibleName = `${normalizedSubject}, ${accessibleState}`

  return (
    <span className={cn("inline-flex items-center gap-1.5", className)}>
      <span aria-label={accessibleName} className="inline-flex items-center gap-1.5" role="img">
        <span
          aria-hidden="true"
          className={cn("status-dot inline-flex shrink-0 rounded-full border", sizes[size])}
          data-status-role={role}
        />
        {showLabel ? <span aria-hidden="true">{normalizedState}</span> : null}
      </span>
      {detail ? <span className="text-muted-foreground">{detail}</span> : null}
    </span>
  )
}
