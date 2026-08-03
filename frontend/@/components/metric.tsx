import type { ComponentProps, ReactNode } from "react"

import { cn } from "@/lib/utils"

type MetricProps = Omit<ComponentProps<"div">, "children"> & {
  label: ReactNode
  value: ReactNode
  numeric?: boolean
}

export function Metric({ className, label, numeric = false, value, ...props }: MetricProps) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1", className)} {...props}>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn("font-medium", numeric && "tabular-nums")}>{value}</dd>
    </div>
  )
}

export type { MetricProps }
