import { CircleCheck, ShieldAlert } from "lucide-react"
import { useEffect, useState } from "react"

import { PlatformIcon } from "@/components/platform-icon"
import { TopBar } from "@/components/top-bar"
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "@/components/ui/input-group"
import { Skeleton } from "@/components/ui/skeleton"
import { AdminAccessError, getAdminLimits, getAdminUser, updateAdminLimits, type AdminLimits, type AdminUser } from "@/lib/admin-api"
import { formatUsd, formatUsdInput, parseUsdInput } from "@/lib/currency-input"
import { isProductionReadOnlyReview } from "@/lib/runtime-mode"

type State =
  | { kind: "loading" }
  | { kind: "denied"; message: string }
  | { kind: "error"; message: string }
  | { kind: "ready"; limits: AdminLimits; user: AdminUser }

type SpendLimitKey = "global" | "system" | "user"
type SpendLimitValues = Record<SpendLimitKey, number>

export type SpendLimitsDraft = Record<SpendLimitKey, string>
export type SpendLimitsFieldErrors = Partial<Record<SpendLimitKey, string>>
export type SpendLimitsNotice =
  | { kind: "success"; message: string }
  | { kind: "error"; message: string }

const limitFields: Array<{
  description: string
  key: SpendLimitKey
  label: string
}> = [
  {
    key: "user",
    label: "Default per-user daily cap",
    description: "Default for users without an individual override.",
  },
  {
    key: "global",
    label: "Global daily cap",
    description: "Maximum platform model spend per UTC day.",
  },
  {
    key: "system",
    label: "System tokens daily cap",
    description: "Reserved for platform-run conflict and synchronization work.",
  },
]

function draftFrom(limits: AdminLimits): SpendLimitsDraft {
  return {
    user: formatUsdInput(limits.user_daily_limit_cents ?? 0),
    global: formatUsdInput(limits.global_daily_limit_cents ?? 0),
    system: formatUsdInput(limits.system_tokens_daily_limit_cents ?? 0),
  }
}

function parseDraft(draft: SpendLimitsDraft):
  | { ok: true; values: SpendLimitValues }
  | { ok: false; errors: SpendLimitsFieldErrors } {
  const parsed = {
    user: parseUsdInput(draft.user),
    global: parseUsdInput(draft.global),
    system: parseUsdInput(draft.system),
  }
  const errors: SpendLimitsFieldErrors = {}

  for (const key of ["user", "global", "system"] as const) {
    if (parsed[key] === null) {
      errors[key] = "Enter a non-negative dollar amount with no more than two decimal places."
    }
  }

  if (Object.keys(errors).length) return { ok: false, errors }
  return { ok: true, values: parsed as SpendLimitValues }
}

function fieldForServerError(message: string): SpendLimitKey | null {
  if (/\bglobal\b|global_daily_limit_cents/i.test(message)) return "global"
  if (/\bsystem\b|system_tokens_daily_limit_cents/i.test(message)) return "system"
  if (/\buser\b|user_daily_limit_cents/i.test(message)) return "user"
  return null
}

export function SpendLimitsPage() {
  const [state, setState] = useState<State>({ kind: "loading" })
  const [draft, setDraft] = useState<SpendLimitsDraft | null>(null)
  const [fieldErrors, setFieldErrors] = useState<SpendLimitsFieldErrors>({})
  const [notice, setNotice] = useState<SpendLimitsNotice | null>(null)
  const [saving, setSaving] = useState(false)
  const [reloadToken, setReloadToken] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    let cancelled = false
    void (async () => {
      try {
        const user = await getAdminUser(controller.signal)
        const limits = await getAdminLimits(controller.signal)
        if (!cancelled) {
          setState({ kind: "ready", limits, user })
          setDraft(draftFrom(limits))
          setFieldErrors({})
          setNotice(null)
        }
      } catch (cause) {
        if (cancelled || (cause instanceof DOMException && cause.name === "AbortError")) return
        const message = cause instanceof Error ? cause.message : "Unable to load spend limits."
        if (!cancelled) setState(cause instanceof AdminAccessError ? { kind: "denied", message } : { kind: "error", message })
      }
    })()
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [reloadToken])

  const canWrite = state.kind === "ready" && Boolean(state.user.canAdminWrite) && !isProductionReadOnlyReview

  const changeDraft = (key: SpendLimitKey, value: string) => {
    setDraft((current) => current ? { ...current, [key]: value } : current)
    setFieldErrors((current) => {
      if (!current[key]) return current
      const next = { ...current }
      delete next[key]
      return next
    })
    setNotice(null)
  }

  const save = async () => {
    if (!canWrite || !draft || saving) return
    const parsed = parseDraft(draft)
    if (!parsed.ok) {
      setFieldErrors(parsed.errors)
      setNotice(null)
      return
    }

    setSaving(true)
    setFieldErrors({})
    setNotice(null)
    try {
      const limits = await updateAdminLimits(parsed.values)
      setState((current) => current.kind === "ready" ? { ...current, limits } : current)
      setDraft(draftFrom(limits))
      setNotice({ kind: "success", message: "The current limits now match the values confirmed by the server." })
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Unable to save spend limits."
      const field = fieldForServerError(message)
      if (field) {
        setFieldErrors({ [field]: "The server rejected this dollar amount. Check it and try again." })
      } else {
        setNotice({
          kind: "error",
          message: `${message} Your entries remain in the form; the current limits above are still the last confirmed server values.`,
        })
      }
    } finally {
      setSaving(false)
    }
  }

  const retry = () => {
    setState({ kind: "loading" })
    setReloadToken((value) => value + 1)
  }

  return (
    <div className="isolate flex w-full flex-1 flex-col" data-testid="spend-limits">
      <TopBar title="Spend limits" />
      <div className="flex w-full flex-1 flex-col gap-6 px-4 py-4 antialiased sm:px-6">
        {state.kind === "loading" ? (
          <div aria-label="Loading spend limits" className="flex w-full max-w-5xl flex-col gap-6" role="status">
            <div className="grid gap-4 sm:grid-cols-3"><Skeleton className="h-28" /><Skeleton className="h-28" /><Skeleton className="h-28" /></div>
            <Skeleton className="h-96 w-full max-w-3xl" />
          </div>
        ) : null}
        {state.kind === "denied" ? <Alert className="max-w-3xl"><PlatformIcon icon={ShieldAlert} /><AlertTitle>Admin access required</AlertTitle><AlertDescription>{state.message}</AlertDescription></Alert> : null}
        {state.kind === "error" ? (
          <Alert className="max-w-3xl" tone="negative">
            <AlertTitle>Spend limits unavailable</AlertTitle>
            <AlertDescription>{state.message}</AlertDescription>
            <AlertAction><Button onClick={retry} size="sm" type="button" variant="outline">Retry</Button></AlertAction>
          </Alert>
        ) : null}
        {state.kind === "ready" && !state.user.canAdminWrite ? <Alert className="max-w-5xl" tone="info"><PlatformIcon icon={ShieldAlert} /><AlertTitle>View-only administrator</AlertTitle><AlertDescription>You can inspect these limits, but a write administrator is required to change them.</AlertDescription></Alert> : null}
        {state.kind === "ready" && isProductionReadOnlyReview ? <Alert className="max-w-5xl" tone="info"><PlatformIcon icon={ShieldAlert} /><AlertTitle>Changes unavailable</AlertTitle><AlertDescription>Saving is disabled.</AlertDescription></Alert> : null}
        {state.kind === "ready" ? (
          <div className="flex w-full max-w-5xl flex-col gap-6">
            <SpendLimitsSummary limits={state.limits} />
            {draft ? (
              <SpendLimitsForm
                canWrite={canWrite}
                draft={draft}
                fieldErrors={fieldErrors}
                notice={notice}
                onChange={changeDraft}
                onSubmit={() => void save()}
                saving={saving}
              />
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}

export function SpendLimitsForm({
  canWrite,
  draft,
  fieldErrors,
  notice,
  onChange,
  onSubmit,
  saving,
}: {
  canWrite: boolean
  draft: SpendLimitsDraft
  fieldErrors: SpendLimitsFieldErrors
  notice: SpendLimitsNotice | null
  onChange: (key: SpendLimitKey, value: string) => void
  onSubmit: () => void
  saving: boolean
}) {
  return (
    <form aria-label="Adjust spend limits" className="w-full max-w-3xl" onSubmit={(event) => { event.preventDefault(); onSubmit() }}>
      <Card>
        <CardHeader>
          <CardTitle>Set daily caps</CardTitle>
          <CardDescription>Enter United States dollar amounts. All three limits are saved together.</CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            {limitFields.map((field) => {
              const error = fieldErrors[field.key]
              return (
                <Field data-invalid={Boolean(error) || undefined} key={field.key}>
                  <FieldLabel htmlFor={`limit-${field.key}`}>{field.label}</FieldLabel>
                  <InputGroup>
                    <InputGroupAddon><InputGroupText aria-hidden="true">$</InputGroupText></InputGroupAddon>
                    <InputGroupInput
                      aria-describedby={`limit-${field.key}-description`}
                      aria-invalid={Boolean(error) || undefined}
                      autoComplete="off"
                      disabled={!canWrite || saving}
                      id={`limit-${field.key}`}
                      inputMode="decimal"
                      name={field.key}
                      onChange={(event) => onChange(field.key, event.target.value)}
                      required
                      spellCheck={false}
                      value={draft[field.key]}
                    />
                  </InputGroup>
                  <FieldDescription id={`limit-${field.key}-description`}>{field.description}</FieldDescription>
                  {error ? <FieldError>{error}</FieldError> : null}
                </Field>
              )
            })}
            {notice ? (
              <Alert role={notice.kind === "success" ? "status" : undefined} tone={notice.kind === "success" ? "positive" : "negative"}>
                {notice.kind === "success" ? <PlatformIcon icon={CircleCheck} /> : null}
                <AlertTitle>{notice.kind === "success" ? "Limits saved" : "Limits were not saved"}</AlertTitle>
                <AlertDescription>{notice.message}</AlertDescription>
              </Alert>
            ) : null}
          </FieldGroup>
        </CardContent>
        <CardFooter className="justify-end border-t">
          <Button disabled={!canWrite || saving} type="submit">{saving ? "Saving limits…" : "Save limits"}</Button>
        </CardFooter>
      </Card>
    </form>
  )
}

export function SpendLimitsSummary({ limits }: { limits: AdminLimits }) {
  const metrics = [
    { label: "Default per-user daily cap", value: formatUsd(limits.user_daily_limit_cents), description: "For users without an override" },
    { label: "Global daily cap", value: formatUsd(limits.global_daily_limit_cents), description: "Across the platform" },
    { label: "System tokens daily cap", value: formatUsd(limits.system_tokens_daily_limit_cents), description: "For platform-run work" },
  ]
  return (
    <section aria-labelledby="current-spend-limits">
      <div className="mb-3">
        <h2 className="font-medium" id="current-spend-limits">Current limits</h2>
        <p className="text-sm text-muted-foreground">Last confirmed server values</p>
      </div>
      <dl className="grid overflow-hidden rounded-2xl border bg-muted/20 sm:grid-cols-3 sm:divide-x">
        {metrics.map((metric) => (
          <div className="border-b px-4 py-4 last:border-b-0 sm:border-b-0" key={metric.label}>
            <dt className="text-sm text-muted-foreground">{metric.label}</dt>
            <dd className="mt-1 text-2xl font-semibold tracking-tight tabular-nums">{metric.value}</dd>
            <dd className="mt-1 text-sm text-muted-foreground">{metric.description}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}
