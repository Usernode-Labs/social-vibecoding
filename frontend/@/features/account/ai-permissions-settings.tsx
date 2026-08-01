import { Bot, RefreshCw, ShieldX } from "lucide-react"
import { useEffect, useState } from "react"

import { PlatformIcon } from "@/components/platform-icon"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Field, FieldContent, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import {
  getAiGrants,
  revokeAiGrant,
  updateAiGrant,
  type AiGrant,
} from "@/lib/settings-api"

type GrantsState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; grants: AiGrant[] }

function messageFrom(cause: unknown, fallback: string) {
  return cause instanceof Error && cause.message ? cause.message : fallback
}

const usdFormatter = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" })

function currency(cents: number) {
  return usdFormatter.format(cents / 100)
}

function AiGrantRow({
  grant,
  hasApiKey,
  readOnly,
  onChanged,
}: {
  grant: AiGrant
  hasApiKey: boolean
  readOnly: boolean
  onChanged: (grant: AiGrant) => void
}) {
  const [cap, setCap] = useState(() => (grant.dailyCapCents / 100).toFixed(2))
  const [saving, setSaving] = useState<"cap" | "byok" | "revoke" | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [revokeOpen, setRevokeOpen] = useState(false)
  const active = grant.status === "active"
  const spent = grant.spentTodayCents + grant.byokSpentTodayCents

  const saveCap = async () => {
    const dailyCapCents = Math.round(Number(cap) * 100)
    if (!Number.isInteger(dailyCapCents) || dailyCapCents <= 0 || saving || readOnly) {
      if (!readOnly) setError("Enter a daily cap of at least $0.01.")
      return
    }
    setSaving("cap")
    setError(null)
    setNotice(null)
    try {
      await updateAiGrant(grant.appId, { dailyCapCents })
      onChanged({ ...grant, dailyCapCents })
      setCap((dailyCapCents / 100).toFixed(2))
      setNotice("Daily cap updated.")
    } catch (cause) {
      setError(messageFrom(cause, "Could not update the daily cap"))
    } finally {
      setSaving(null)
    }
  }

  const saveByok = async (allowByok: boolean) => {
    if (saving || readOnly) return
    setSaving("byok")
    setError(null)
    setNotice(null)
    try {
      await updateAiGrant(grant.appId, { allowByok })
      onChanged({ ...grant, allowByok })
      setNotice(allowByok ? "Personal-key spillover enabled." : "Personal-key spillover disabled.")
    } catch (cause) {
      setError(messageFrom(cause, "Could not update personal-key spillover"))
    } finally {
      setSaving(null)
    }
  }

  const revoke = async () => {
    if (saving || readOnly) return
    setSaving("revoke")
    setError(null)
    setNotice(null)
    try {
      await revokeAiGrant(grant.appId)
      onChanged({ ...grant, status: "revoked", allowByok: false })
      setRevokeOpen(false)
    } catch (cause) {
      setError(messageFrom(cause, "Could not revoke AI access"))
    } finally {
      setSaving(null)
    }
  }

  return (
    <div className="flex flex-col gap-4 rounded-lg border p-4" data-testid={`ai-grant-${grant.appId}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-medium">{grant.appName}</p>
          {active ? (
            <p className="text-sm text-muted-foreground">
              {currency(spent)} of {currency(grant.dailyCapCents)} used today
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">The app can ask for access again later.</p>
          )}
        </div>
        <Badge variant={active ? "secondary" : "outline"}>{active ? "Active" : "Revoked"}</Badge>
      </div>

      {active ? (
        <FieldGroup>
          <Field orientation="responsive">
            <FieldContent>
              <FieldLabel htmlFor={`ai-grant-cap-${grant.appId}`}>Daily platform budget</FieldLabel>
              <FieldDescription>Maximum shared-budget spend this app may use per day.</FieldDescription>
            </FieldContent>
            <div className="flex items-center gap-2">
              <span aria-hidden="true" className="text-sm text-muted-foreground">$</span>
              <Input
                className="w-24"
                disabled={readOnly || saving !== null}
                id={`ai-grant-cap-${grant.appId}`}
                inputMode="decimal"
                min="0.01"
                onChange={(event) => {
                  setCap(event.target.value)
                  setError(null)
                  setNotice(null)
                }}
                step="0.01"
                type="number"
                value={cap}
              />
              <Button
                disabled={readOnly || saving !== null}
                onClick={() => void saveCap()}
                size="sm"
                type="button"
                variant="outline"
              >
                {saving === "cap" ? "Saving…" : "Save"}
              </Button>
            </div>
          </Field>
          {hasApiKey || grant.allowByok ? (
            <Field data-disabled={readOnly || saving !== null} orientation="responsive">
              <FieldContent>
                <FieldLabel htmlFor={`ai-grant-byok-${grant.appId}`}>Use my key after the platform cap</FieldLabel>
                <FieldDescription>The app remains capped; excess usage is billed through your saved Anthropic key.</FieldDescription>
              </FieldContent>
              <Switch
                checked={grant.allowByok}
                disabled={readOnly || saving !== null}
                id={`ai-grant-byok-${grant.appId}`}
                onCheckedChange={(checked) => void saveByok(checked)}
              />
            </Field>
          ) : null}
          <div>
            <Button
              disabled={readOnly || saving !== null}
              onClick={() => setRevokeOpen(true)}
              size="sm"
              type="button"
              variant="destructive"
            >
              <PlatformIcon data-icon="inline-start" icon={ShieldX} />
              Revoke access
            </Button>
          </div>
        </FieldGroup>
      ) : null}

      {error ? <FieldError>{error}</FieldError> : null}
      {notice ? <p className="text-sm text-muted-foreground" role="status">{notice}</p> : null}

      <AlertDialog onOpenChange={(open) => { if (!saving) setRevokeOpen(open) }} open={revokeOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke AI access for {grant.appName}?</AlertDialogTitle>
            <AlertDialogDescription>
              Its next AI call will fail immediately. The app can request access again later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={saving === "revoke"}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={saving === "revoke"}
              onClick={() => void revoke()}
              type="button"
              variant="destructive"
            >
              {saving === "revoke" ? "Revoking…" : "Revoke access"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

export function AiPermissionsSettings({
  hasApiKey,
  readOnly,
}: {
  hasApiKey: boolean
  readOnly: boolean
}) {
  const [state, setState] = useState<GrantsState>({ kind: "loading" })
  const [refreshKey, setRefreshKey] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    setState({ kind: "loading" })
    void getAiGrants(controller.signal)
      .then((grants) => setState({ kind: "ready", grants }))
      .catch((cause) => {
        if (!controller.signal.aborted) {
          setState({ kind: "error", message: messageFrom(cause, "Could not load app AI permissions") })
        }
      })
    return () => controller.abort()
  }, [refreshKey])

  const updateGrant = (changed: AiGrant) => {
    setState((current) => current.kind === "ready"
      ? { kind: "ready", grants: current.grants.map((grant) => grant.appId === changed.appId ? changed : grant) }
      : current)
  }

  return (
    <Card data-testid="settings-ai-permissions">
      <CardHeader>
        <CardTitle>App AI permissions</CardTitle>
        <CardDescription>Control the budget and personal-key access granted to each hosted app.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {state.kind === "loading" ? (
          <>
            <Skeleton className="h-28 w-full" />
            <Skeleton className="h-28 w-full" />
          </>
        ) : null}
        {state.kind === "error" ? (
          <Alert variant="destructive">
            <AlertTitle>Could not load AI permissions</AlertTitle>
            <AlertDescription>{state.message}</AlertDescription>
          </Alert>
        ) : null}
        {state.kind === "ready" && state.grants.length === 0 ? (
          <Empty className="p-6">
            <EmptyHeader>
              <EmptyMedia variant="icon"><PlatformIcon icon={Bot} /></EmptyMedia>
              <EmptyTitle className="text-base">No app AI permissions yet</EmptyTitle>
              <EmptyDescription>Apps appear here after they ask to use AI on your behalf.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : null}
        {state.kind === "ready"
          ? state.grants.map((grant) => (
              <AiGrantRow
                grant={grant}
                hasApiKey={hasApiKey}
                key={grant.appId}
                onChanged={updateGrant}
                readOnly={readOnly}
              />
            ))
          : null}
      </CardContent>
      {state.kind === "error" ? (
        <CardFooter>
          <Button onClick={() => setRefreshKey((value) => value + 1)} size="sm" type="button" variant="outline">
            <PlatformIcon data-icon="inline-start" icon={RefreshCw} />
            Try again
          </Button>
        </CardFooter>
      ) : null}
    </Card>
  )
}
