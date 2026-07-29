import type { LucideIcon, LucideProps } from "lucide-react"

import { cn } from "@/lib/utils"

const iconSizes = {
  xs: "size-3",
  sm: "size-3.5",
  md: "size-4",
  lg: "size-5",
} as const

type PlatformIconProps = Omit<LucideProps, "size"> & {
  icon: LucideIcon
  size?: keyof typeof iconSizes
}

/**
 * The canonical visual grid for platform UI glyphs.
 *
 * App artwork uses AppIdentity instead: it is deliberately larger and never
 * substitutes for navigation, action, status, or inline-content glyphs.
 */
export function PlatformIcon({ className, icon: Icon, size = "md", ...props }: PlatformIconProps) {
  const label = props["aria-label"]
  return <Icon aria-hidden={label ? undefined : true} data-slot="platform-icon" focusable="false" {...props} className={cn("shrink-0", iconSizes[size], className)} />
}
