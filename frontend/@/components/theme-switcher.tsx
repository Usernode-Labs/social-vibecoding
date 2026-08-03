import { Monitor, Moon, Sun } from "lucide-react"
import { useEffect, useState } from "react"

import { PlatformIcon } from "@/components/platform-icon"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { getThemeMode, getThemePreference, applyThemeMode, setThemePreference, subscribeThemeMode, subscribeThemePreference, type ThemeMode, type ThemePreference } from "@/lib/theme"
import { cn } from "@/lib/utils"

type ThemeSwitcherViewProps = {
  className?: string
  preference: ThemePreference
  effectiveMode: ThemeMode
  onPreferenceChange: (preference: ThemePreference) => void
}

export function ThemeSwitcherView({ className, effectiveMode, onPreferenceChange, preference }: ThemeSwitcherViewProps) {
  return (
    <ToggleGroup
      aria-label="Color mode"
      className={cn("w-fit rounded-3xl", className)}
      onValueChange={(values) => {
        const next = values[0]
        if (next === "light" || next === "dark" || next === "system") onPreferenceChange(next)
      }}
      size="sm"
      selectionVariant="elevated"
      spacing={1}
      value={[preference]}
    >
      <ToggleGroupItem aria-label="Use light mode" value="light">
        <PlatformIcon data-icon="inline-start" icon={Sun} />
        Light
      </ToggleGroupItem>
      <ToggleGroupItem aria-label="Use dark mode" value="dark">
        <PlatformIcon data-icon="inline-start" icon={Moon} />
        Dark
      </ToggleGroupItem>
      <ToggleGroupItem aria-label={`Use system mode, currently ${effectiveMode}`} value="system">
        <PlatformIcon data-icon="inline-start" icon={Monitor} />
        System
      </ToggleGroupItem>
    </ToggleGroup>
  )
}

export function ThemeSwitcher({ className }: { className?: string }) {
  const [preference, setPreference] = useState<ThemePreference>(() => getThemePreference())
  const [effectiveMode, setEffectiveMode] = useState<ThemeMode>(() => getThemeMode())

  useEffect(() => {
    applyThemeMode(effectiveMode)
    return subscribeThemeMode(setEffectiveMode)
  }, [effectiveMode])

  useEffect(() => subscribeThemePreference(setPreference), [])

  return (
    <ThemeSwitcherView
      className={className}
      effectiveMode={effectiveMode}
      preference={preference}
      onPreferenceChange={(nextPreference) => {
        setPreference(nextPreference)
        setThemePreference(nextPreference)
        setEffectiveMode(nextPreference === "system" ? getThemeMode() : nextPreference)
      }}
    />
  )
}
