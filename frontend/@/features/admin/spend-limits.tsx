import { ShieldAlert } from "lucide-react"
import { useEffect, useState } from "react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { PlatformIcon } from "@/components/platform-icon"
import { Skeleton } from "@/components/ui/skeleton"
import { AdminAccessError, getAdminLimits, getAdminUser, updateAdminLimits, type AdminLimits, type AdminUser } from "@/lib/admin-api"
import { isProductionReadOnlyReview } from "@/lib/runtime-mode"

type State = { kind: "loading" } | { kind: "denied"; message: string } | { kind: "error"; message: string } | { kind: "ready"; limits: AdminLimits; user: AdminUser }

type Draft = { global: string; system: string; user: string }

function dollars(cents?: number) {
  return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(Number(cents || 0) / 100)
}

function draftFrom(limits: AdminLimits): Draft {
  return {
    user: String(limits.user_daily_limit_cents ?? 0),
    global: String(limits.global_daily_limit_cents ?? 0),
    system: String(limits.system_tokens_daily_limit_cents ?? 0),
  }
}

function parseDraft(draft: Draft): { global: number; system: number; user: number } | null {
  const values = Object.values(draft).map((value) => Number(value))
  if (values.some((value) => !Number.isInteger(value) || value < 0)) return null
  return { user: values[0], global: values[1], system: values[2] }
}

export function SpendLimitsPage() {
  const [state, setState] = useState<State>({ kind: "loading" })
  const [reloadToken, setReloadToken] = useState(0)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  useEffect(() => {
    const controller = new AbortController(); let cancelled = false
    void (async () => {
      try {
        const user = await getAdminUser(controller.signal)
        const limits = await getAdminLimits(controller.signal)
        if (!cancelled) {
          setState({ kind: "ready", limits, user })
          setDraft(draftFrom(limits))
        }
      } catch (cause) {
        if (cancelled || (cause instanceof DOMException && cause.name === "AbortError")) return
        const message = cause instanceof Error ? cause.message : "Unable to load spend limits."
        if (!cancelled) setState(cause instanceof AdminAccessError ? { kind: "denied", message } : { kind: "error", message })
      }
    })()
    return () => { cancelled = true; controller.abort() }
  }, [reloadToken])
  const canWrite = state.kind === "ready" && state.user.canAdminWrite && !isProductionReadOnlyReview
  const save = async () => {
    if (!canWrite || !draft || saving) return
    const next = parseDraft(draft)
    if (!next) {
      setSaveError("Enter whole, non-negative cent amounts for every limit.")
      return
    }
    setSaving(true)
    setSaveError(null)
    try {
      const limits = await updateAdminLimits(next)
      setState((current) => current.kind === "ready" ? { ...current, limits } : current)
      setDraft(draftFrom(limits))
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : "Unable to save spend limits.")
    } finally {
      setSaving(false)
    }
  }
  return <div className="isolate mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-4 py-8 antialiased sm:px-6" data-testid="spend-limits">
    <header className="flex flex-wrap items-start justify-between gap-4"><div className="space-y-2"><h1 className="text-balance text-3xl font-semibold tracking-tight">Spend limits</h1><p className="text-base text-muted-foreground text-pretty">Platform-wide LLM budgets.</p></div>{state.kind === "ready" ? <Button onClick={() => setReloadToken((value) => value + 1)} type="button" variant="outline">Refresh</Button> : null}</header>
    {state.kind === "loading" ? <div className="grid gap-4 sm:grid-cols-3"><Skeleton className="h-36" /><Skeleton className="h-36" /><Skeleton className="h-36" /></div> : null}
    {state.kind === "denied" ? <Alert><PlatformIcon icon={ShieldAlert} /><AlertTitle>Admin access required</AlertTitle><AlertDescription>{state.message}</AlertDescription></Alert> : null}
    {state.kind === "error" ? <Alert variant="destructive"><AlertTitle>Spend limits unavailable</AlertTitle><AlertDescription>{state.message}</AlertDescription></Alert> : null}
    {state.kind === "ready" && !state.user.canAdminWrite ? <Alert><PlatformIcon icon={ShieldAlert} /><AlertTitle>View-only administrator</AlertTitle><AlertDescription>You can inspect these limits, but a write administrator is required to change them.</AlertDescription></Alert> : null}
    {state.kind === "ready" && isProductionReadOnlyReview ? <Alert><PlatformIcon icon={ShieldAlert} /><AlertTitle>Changes unavailable</AlertTitle><AlertDescription>Saving is disabled.</AlertDescription></Alert> : null}
    {state.kind === "ready" ? <><SpendLimitsCards limits={state.limits} />{draft ? <form className="max-w-2xl" onSubmit={(event) => { event.preventDefault(); void save() }}><Card><CardHeader><CardTitle>Adjust limits</CardTitle></CardHeader><CardContent><FieldGroup>{(["user", "global", "system"] as const).map((key) => <Field key={key}><FieldLabel htmlFor={`limit-${key}`}>{key === "user" ? "Default per-user daily cap" : key === "global" ? "Global daily cap" : "System tokens daily cap"}</FieldLabel><Input disabled={!canWrite || saving} id={`limit-${key}`} inputMode="numeric" min="0" name={key} onChange={(event) => setDraft((current) => current ? { ...current, [key]: event.target.value } : current)} required step="1" type="number" value={draft[key]} /><p className="text-sm text-muted-foreground">Whole cents.</p></Field>)}{saveError ? <Field data-invalid><FieldError>{saveError}</FieldError></Field> : null}<Button disabled={!canWrite || saving} type="submit">{saving ? "Saving…" : "Save limits"}</Button></FieldGroup></CardContent></Card></form> : null}</> : null}
  </div>
}

export function SpendLimitsCards({ limits }: { limits: AdminLimits }) {
  const cards = [
    { label: "Default per-user daily cap", value: dollars(limits.user_daily_limit_cents), description: "Default applied unless a user has an override." },
    { label: "Global daily cap", value: dollars(limits.global_daily_limit_cents), description: "Platform-wide maximum LLM spend per UTC day." },
    { label: "System tokens daily cap", value: dollars(limits.system_tokens_daily_limit_cents), description: "Platform-driven conflict and synchronization work." },
  ]
  return <section aria-label="Platform spend limits" className="grid gap-4 sm:grid-cols-3">{cards.map((card) => <Card key={card.label}><CardHeader><CardDescription>{card.label}</CardDescription><CardTitle className="text-3xl tabular-nums">{card.value}</CardTitle></CardHeader><CardContent className="text-sm text-muted-foreground">{card.description}</CardContent></Card>)}</section>
}
