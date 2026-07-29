import type { CSSProperties } from "react"

import type { AppRecord } from "@/lib/apps-api"

function identityStyle(name: string): CSSProperties {
  let hash = 0
  for (const character of name || "?") {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0
  }
  const hue = hash % 360
  return { backgroundColor: `hsl(${hue} 45% 22%)`, color: `hsl(${hue} 70% 70%)` }
}

export function AppIdentity({ app }: { app: AppRecord }) {
  if (app.icon_url) {
    return <img alt="" className="size-12 shrink-0 rounded-md object-cover" src={app.icon_url} />
  }

  return (
    <div
      aria-hidden="true"
      className="flex size-12 shrink-0 items-center justify-center rounded-md text-lg font-semibold"
      style={identityStyle(app.name)}
    >
      {app.name.slice(0, 1).toUpperCase()}
    </div>
  )
}
