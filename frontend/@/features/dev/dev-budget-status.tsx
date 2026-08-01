import { CircleDollarSign } from "lucide-react"
import { useEffect, useState } from "react"
import { ActionLink } from "@/components/action-link"
import { PlatformIcon } from "@/components/platform-icon"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { getAiBudget, getWebSettings, type AiBudget } from "@/lib/settings-api"

export type DevBudgetStatusState = {
  budget: AiBudget
  hasApiKey: boolean
  keyLast4: string | null
}

const currency = new Intl.NumberFormat(undefined, {
  currency: "USD",
  minimumFractionDigits: 2,
  style: "currency",
})

function money(cents: number) {
  return currency.format(cents / 100)
}

export function DevBudgetStatus() {
  const [state, setState] = useState<DevBudgetStatusState | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    let cancelled = false
    Promise.all([
      getAiBudget(controller.signal),
      getWebSettings(controller.signal),
    ]).then(([budget, settings]) => {
      if (!cancelled) {
        setState({
          budget,
          hasApiKey: settings.hasApiKey,
          keyLast4: settings.keyLast4,
        })
      }
    }).catch(() => {
      // The legacy contract stays quiet when budget/account state cannot be
      // read. The server still enforces billing when a turn is submitted.
    })
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [])

  return state ? <DevBudgetStatusView {...state} /> : null
}

export function DevBudgetStatusView({ budget, hasApiKey, keyLast4 }: DevBudgetStatusState) {
  const userOut = budget.limitCents > 0 && budget.spentCents >= budget.limitCents
  const globalOut = budget.globalLimitCents > 0 && budget.globalSpentCents >= budget.globalLimitCents
  const exhausted = !hasApiKey && (userOut || globalOut)

  if (exhausted || !budget.aiEnabled) {
    return (
      <Alert data-testid="dev-budget-exhausted" variant="destructive">
        <PlatformIcon icon={CircleDollarSign} />
        <AlertTitle>
          {!budget.aiEnabled
            ? "Builder is unavailable"
            : userOut
              ? "Today’s free AI credits are used up"
              : "The shared AI budget is used up"}
        </AlertTitle>
        <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
          <span>
            {!budget.aiEnabled
              ? "No platform or personal AI provider is available."
              : "The shared allowance resets at midnight UTC. You can add your own Anthropic API key to continue sooner."}
          </span>
          <ActionLink size="sm" to="/settings" variant="outline">
            Open settings
          </ActionLink>
        </AlertDescription>
      </Alert>
    )
  }

  return (
    <div
      aria-label="Today’s AI budget"
      className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
      data-testid="dev-budget-status"
    >
      <span>Today</span>
      <Badge variant="outline">
        {money(budget.spentCents)} / {money(budget.limitCents)}
      </Badge>
      {hasApiKey ? (
        <Badge title={keyLast4 ? `Anthropic key ending in ${keyLast4}` : "Your Anthropic key"} variant="secondary">
          Your key{budget.byokSpentCents > 0 ? ` ${money(budget.byokSpentCents)}` : ""}
        </Badge>
      ) : null}
      <span>Resets midnight UTC</span>
    </div>
  )
}
