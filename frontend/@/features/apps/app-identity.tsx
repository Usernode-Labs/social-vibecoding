import { cn } from "@/lib/utils"
import { appIdentitySlot, appMonogram, type AppIdentityApp } from "./app-identity-contract"

const identitySizes = {
  sm: "size-8 text-sm",
  md: "size-12 text-lg",
  lg: "size-16 text-xl",
} as const

export type AppIdentityProps = {
  app: AppIdentityApp
  size?: keyof typeof identitySizes
  decorative?: boolean
}

export function AppIdentity({ app, decorative = true, size = "md" }: AppIdentityProps) {
  const sizeClass = identitySizes[size]
  if (app.icon_url) {
    return <img alt={decorative ? "" : app.name} className={cn("shrink-0 rounded-md object-cover", sizeClass)} src={app.icon_url} />
  }

  return (
    <div
      aria-hidden={decorative ? true : undefined}
      aria-label={decorative ? undefined : app.name}
      className={cn("app-identity flex shrink-0 items-center justify-center rounded-md border font-semibold", sizeClass)}
      data-identity-slot={appIdentitySlot(app)}
      role={decorative ? undefined : "img"}
    >
      {appMonogram(app.name)}
    </div>
  )
}
