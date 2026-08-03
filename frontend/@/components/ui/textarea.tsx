import * as React from "react"

import { cn } from "@/lib/utils"

function Textarea({ className, surface = "container", ...props }: React.ComponentProps<"textarea"> & { surface?: "container" | "none" }) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-16 w-full rounded-2xl border border-border bg-container px-3 py-3 text-base text-foreground transition-[color,box-shadow,background-color] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:text-fg-secondary disabled:placeholder:text-fg-tertiary aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
        className,
        surface === "container" ? "bg-container" : "bg-transparent"
      )}
      {...props}
      data-surface={surface === "container" ? "container" : undefined}
    />
  )
}

export { Textarea }
