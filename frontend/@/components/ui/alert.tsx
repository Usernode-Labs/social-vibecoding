import * as React from "react"
import { cva } from "class-variance-authority"

import { cn } from "@/lib/utils"

const alertVariants = cva(
  "group/alert relative grid w-full border text-left text-sm *:[svg]:text-current *:[svg:not([class*='size-'])]:size-4",
  {
    variants: {
      appearance: {
        default: "bg-card text-card-foreground",
        destructive:
          "bg-card text-destructive *:data-[slot=alert-description]:text-destructive/90 *:[svg]:text-current",
        positive: "status-surface *:data-[slot=alert-description]:text-current/80",
        info: "status-surface *:data-[slot=alert-description]:text-current/80",
        warning: "status-surface *:data-[slot=alert-description]:text-current/80",
        negative: "status-surface *:data-[slot=alert-description]:text-current/80",
      },
      form: {
        default: "gap-0.5 rounded-2xl px-4 py-3 has-data-[slot=alert-action]:relative has-data-[slot=alert-action]:pr-18 has-[>svg]:grid-cols-[auto_1fr] has-[>svg]:gap-x-2.5 *:[svg]:row-span-2 *:[svg]:translate-y-0.5",
        footer: "flex min-h-12 items-center gap-2.5 rounded-xl px-4 py-2.5 *:[svg]:self-center",
      },
    },
    defaultVariants: {
      appearance: "default",
      form: "default",
    },
  }
)

type AlertTone = "positive" | "info" | "warning" | "negative"
type AlertForm = "default" | "footer"
type AlertAppearance =
  | { form?: "default"; tone?: never; variant?: "default" | "destructive" }
  | { form?: "default"; tone: AlertTone; variant?: never }
  | { form: "footer"; tone: AlertTone; variant?: never }
type AlertProps = React.ComponentProps<"div"> & AlertAppearance

function Alert({
  className,
  form = "default",
  role,
  tone,
  variant,
  ...props
}: AlertProps) {
  const appearance = tone ?? variant ?? "default"
  return (
    <div
      data-slot="alert"
      data-status-tone={tone}
      role={role ?? (form === "footer" ? undefined : "alert")}
      className={cn(alertVariants({ appearance, form }), className)}
      {...props}
    />
  )
}

function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-title"
      className={cn(
        "font-medium group-has-[>svg]/alert:col-start-2 [&_a]:underline [&_a]:underline-offset-3 [&_a]:hover:text-foreground",
        className
      )}
      {...props}
    />
  )
}

function AlertDescription({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-description"
      className={cn(
        "text-sm text-balance text-muted-foreground md:text-pretty [&_a]:underline [&_a]:underline-offset-3 [&_a]:hover:text-foreground [&_p:not(:last-child)]:mb-4",
        className
      )}
      {...props}
    />
  )
}

function AlertAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-action"
      className={cn("absolute top-2.5 right-3", className)}
      {...props}
    />
  )
}

function AlertValue({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-value"
      className={cn("ml-auto shrink-0 font-medium tabular-nums", className)}
      {...props}
    />
  )
}

export { Alert, AlertTitle, AlertDescription, AlertAction, AlertValue }
export type { AlertForm, AlertProps, AlertTone }
