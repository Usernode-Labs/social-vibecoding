import React, { type ReactNode } from "react"

export function ThemeFrame({ children, theme }: { children: ReactNode; theme: "light" | "dark" }) {
  const root = document.documentElement
  root.classList.remove("light", "dark")
  root.classList.add(theme)
  root.dataset.theme = theme
  root.style.colorScheme = theme

  return <div className="min-h-screen bg-background text-foreground">{children}</div>
}
