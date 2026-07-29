import { CircleDollarSign } from "lucide-react"
import { useEffect, useState } from "react"

import { PlatformIcon } from "@/components/platform-icon"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { getAiBudget, type AiBudget } from "@/lib/settings-api"

const currency = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" })

function money(cents: number) {
  return currency.format(cents / 100)
}

export function AiSpendSummary({ enabled }: { enabled: boolean }) {
  const [budget, setBudget] = useState<AiBudget | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!enabled) return
    const controller = new AbortController()
    let cancelled = false
    getAiBudget(controller.signal).then((result) => {
      if (!cancelled) setBudget(result)
    }).catch((cause: unknown) => {
      if (cancelled || (cause instanceof DOMException && cause.name === "AbortError")) return
      setError(cause instanceof Error ? cause.message : "Could not load today's spend")
    })
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [enabled])

  if (!enabled) return null
  return (
    <Card data-testid="settings-ai-spend">
      <CardHeader>
        <CardTitle>Today&apos;s AI spend</CardTitle>
        <CardDescription>Platform allowance is consumed first; your saved key takes over after that limit.</CardDescription>
        <CardAction><Badge variant="outline">Resets midnight UTC</Badge></CardAction>
      </CardHeader>
      <CardContent>
        {error ? (
          <Alert variant="destructive">
            <PlatformIcon icon={CircleDollarSign} />
            <AlertTitle>Spend unavailable</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : budget ? (
          <dl className="grid gap-4 sm:grid-cols-2">
            <div>
              <dt className="text-sm text-muted-foreground">Platform daily limit</dt>
              <dd className="mt-1 text-2xl font-semibold tracking-tight">{money(budget.spentCents)} of {money(budget.limitCents)}</dd>
            </div>
            <div>
              <dt className="text-sm text-muted-foreground">Your Anthropic key</dt>
              <dd className="mt-1 text-2xl font-semibold tracking-tight">{money(budget.byokSpentCents)}</dd>
            </div>
          </dl>
        ) : (
          <div aria-label="Loading today's AI spend" className="grid gap-4 sm:grid-cols-2">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        )}
      </CardContent>
    </Card>
  )
}
