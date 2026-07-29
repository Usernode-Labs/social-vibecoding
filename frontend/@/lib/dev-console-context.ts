import { createContext, useContext } from "react"

import type { DevConsoleEntry, DevConsoleFilter } from "@/components/dev-console-panel"
import type { DevConsoleMode } from "@/lib/browser-preferences"

export type DevConsoleContextValue = {
  entries: DevConsoleEntry[]
  filter: DevConsoleFilter
  mode: DevConsoleMode
  open: boolean
  unseenErrors: number
  visible: boolean
  clear: () => void
  registerFrame: (slug: string, frame: Window) => () => void
  setFilter: (filter: DevConsoleFilter) => void
  setOpen: (open: boolean) => void
}

export const DevConsoleContext = createContext<DevConsoleContextValue | null>(null)

export function useDevConsoleContext() {
  const context = useContext(DevConsoleContext)
  if (!context) throw new Error("Dev console components must be rendered inside DevConsoleProvider")
  return context
}
