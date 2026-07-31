import type { ComponentProps, MouseEvent } from "react"
import { Link, type LinkProps } from "react-router-dom"
import type { VariantProps } from "class-variance-authority"

import { buttonVariants } from "@/components/ui/button"
import { cn } from "@/lib/utils"

type ActionLinkVisualProps = VariantProps<typeof buttonVariants> & {
  disabled?: boolean
}

function guardDisabled(
  disabled: boolean,
  onClick: ((event: MouseEvent<HTMLAnchorElement>) => void) | undefined,
) {
  return (event: MouseEvent<HTMLAnchorElement>) => {
    if (disabled) {
      event.preventDefault()
      return
    }
    onClick?.(event)
  }
}

export type ActionLinkProps = LinkProps & ActionLinkVisualProps

/**
 * A semantic internal Link with the governed action visual treatments.
 * Navigation never needs to borrow Button behavior to look like an action.
 */
export function ActionLink({
  className,
  disabled = false,
  onClick,
  size = "default",
  tabIndex,
  variant = "outline",
  ...props
}: ActionLinkProps) {
  return (
    <Link
      aria-disabled={disabled || undefined}
      className={cn(buttonVariants({ size, variant }), className)}
      data-slot="action-link"
      onClick={guardDisabled(disabled, onClick)}
      tabIndex={disabled ? -1 : tabIndex}
      {...props}
    />
  )
}

export type ActionAnchorProps = ComponentProps<"a"> & ActionLinkVisualProps

/**
 * The external-anchor counterpart to ActionLink. Callers still own target,
 * rel, download, and destination policy.
 */
export function ActionAnchor({
  className,
  disabled = false,
  onClick,
  size = "default",
  tabIndex,
  variant = "outline",
  ...props
}: ActionAnchorProps) {
  return (
    <a
      aria-disabled={disabled || undefined}
      className={cn(buttonVariants({ size, variant }), className)}
      data-slot="action-anchor"
      onClick={guardDisabled(disabled, onClick)}
      tabIndex={disabled ? -1 : tabIndex}
      {...props}
    />
  )
}
