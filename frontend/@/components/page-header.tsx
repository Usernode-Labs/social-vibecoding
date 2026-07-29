import { useId, type ReactNode } from "react"

import { cn } from "@/lib/utils"

export type HeaderLayoutProps = {
  heading: ReactNode
  description?: ReactNode
  action?: ReactNode
  compact?: boolean
}

/**
 * Shared structure for page and section headings.
 *
 * The owner supplies the semantic heading and landmark. This primitive owns
 * only their responsive layout and internal spacing.
 */
export function HeaderLayout({
  action,
  compact = false,
  description,
  heading,
}: HeaderLayoutProps) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col items-start @sm:flex-row @sm:justify-between",
        compact ? "gap-2" : "gap-4"
      )}
      data-compact={compact || undefined}
      data-slot="header-layout"
    >
      <div
        className={cn(
          "flex min-w-0 flex-1 flex-col",
          compact ? "gap-1" : "gap-2"
        )}
      >
        {heading}
        {description}
      </div>
      {action ? (
        <div className="shrink-0" data-slot="header-layout-action">
          {action}
        </div>
      ) : null}
    </div>
  )
}

export type PageHeaderProps = {
  title: string
  description?: string
  action?: ReactNode
  compact?: boolean
}

/**
 * Props-only route context. PageHeader is the route's sole h1; route chrome,
 * authorization, data loading, and action behavior remain with its caller.
 */
export function PageHeader({
  action,
  compact = false,
  description,
  title,
}: PageHeaderProps) {
  const titleId = useId()
  const descriptionId = useId()

  return (
    <header
      aria-describedby={description ? descriptionId : undefined}
      aria-labelledby={titleId}
      className="@container w-full min-w-0"
      data-slot="page-header"
    >
      <HeaderLayout
        action={action}
        compact={compact}
        description={
          description ? (
            <p
              className="max-w-2xl text-pretty text-base text-muted-foreground"
              id={descriptionId}
            >
              {description}
            </p>
          ) : undefined
        }
        heading={
          <h1
            className="font-heading text-3xl font-medium tracking-tight text-balance"
            id={titleId}
          >
            {title}
          </h1>
        }
      />
    </header>
  )
}
