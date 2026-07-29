import { Moon, Sun } from "lucide-react"
import { useEffect, useState } from "react"

import { PlatformIcon } from "@/components/platform-icon"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { getThemeMode, applyThemeMode, setThemeMode, subscribeThemeMode, type ThemeMode } from "@/lib/theme"
import { cn } from "@/lib/utils"

type ThemeSwitcherViewProps = {
  className?: string
  mode: ThemeMode
  onModeChange: (mode: ThemeMode) => void
}

export function ThemeSwitcherView({ className, mode, onModeChange }: ThemeSwitcherViewProps) {
  return (
    <ToggleGroup
      aria-label="Color mode"
      className={cn("w-full", className)}
      onValueChange={(values) => {
        const next = values[0]
        if (next === "light" || next === "dark") onModeChange(next)
      }}
      spacing={0}
      value={[mode]}
      variant="outline"
    >
      <ToggleGroupItem aria-label="Use light mode" className="flex-1" value="light">
        <PlatformIcon data-icon="inline-start" icon={Sun} />
        Light
      </ToggleGroupItem>
      <ToggleGroupItem aria-label="Use dark mode" className="flex-1" value="dark">
        <PlatformIcon data-icon="inline-start" icon={Moon} />
        Dark
      </ToggleGroupItem>
    </ToggleGroup>
  )
}

export function ThemeSwitcher({ className }: { className?: string }) {
  const [mode, setMode] = useState<ThemeMode>(() => getThemeMode())

  useEffect(() => {
    applyThemeMode(mode)
    return subscribeThemeMode(setMode)
  }, [mode])

  return (
    <ThemeSwitcherView
      className={className}
      mode={mode}
      onModeChange={(nextMode) => {
        setMode(nextMode)
        setThemeMode(nextMode)
      }}
    />
  )
}
