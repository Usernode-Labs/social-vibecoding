import { ExternalLink, KeyRound, ShieldAlert } from "lucide-react"
import { useEffect, useMemo, useState } from "react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { TopBar } from "@/components/top-bar"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { PlatformIcon } from "@/components/platform-icon"
import { Skeleton } from "@/components/ui/skeleton"
import { AdminAccessError, createActivationCode, getActivationCodes, getAdminUser, revokeActivationCode, type ActivationCode, type AdminUser } from "@/lib/admin-api"
import { isProductionReadOnlyReview } from "@/lib/runtime-mode"

type State = { kind: "loading" } | { kind: "denied"; message: string } | { kind: "error"; message: string } | { kind: "ready"; codes: ActivationCode[]; user: AdminUser }

function date(value?: string | null) {
  if (!value) return "Date unavailable"
  const parsed = new Date(value)
  return Number.isNaN(parsed.valueOf()) ? "Date unavailable" : parsed.toLocaleDateString()
}

export function ActivationCodesPage() {
  const [state, setState] = useState<State>({ kind: "loading" })
  const [creating, setCreating] = useState(false)
  const [creationError, setCreationError] = useState<string | null>(null)
  const [revocationTarget, setRevocationTarget] = useState<ActivationCode | null>(null)
  const [revoking, setRevoking] = useState(false)
  const [revocationError, setRevocationError] = useState<string | null>(null)
  const [copiedCodeId, setCopiedCodeId] = useState<number | null>(null)
  const [copyError, setCopyError] = useState<string | null>(null)
  const [reloadToken, setReloadToken] = useState(0)
  useEffect(() => {
    const controller = new AbortController(); let cancelled = false
    void (async () => {
      try {
        const user = await getAdminUser(controller.signal)
        const codes = await getActivationCodes(controller.signal)
        if (!cancelled) setState({ kind: "ready", codes, user })
      } catch (cause) {
        if (cancelled || (cause instanceof DOMException && cause.name === "AbortError")) return
        const message = cause instanceof Error ? cause.message : "Unable to load activation codes."
        if (!cancelled) setState(cause instanceof AdminAccessError ? { kind: "denied", message } : { kind: "error", message })
      }
    })()
    return () => { cancelled = true; controller.abort() }
  }, [reloadToken])
  const codes = useMemo(() => state.kind === "ready" ? state.codes : [], [state])
  const canCreate = state.kind === "ready" && state.user.canAdminWrite && !isProductionReadOnlyReview
  const canRevoke = canCreate
  const create = async () => {
    if (!canCreate || creating) return
    setCreating(true)
    setCreationError(null)
    try {
      const code = await createActivationCode()
      setState((current) => current.kind === "ready" ? { ...current, codes: [code, ...current.codes] } : current)
    } catch (cause) {
      setCreationError(cause instanceof Error ? cause.message : "Unable to create an activation code.")
    } finally { setCreating(false) }
  }
  const revoke = async () => {
    if (!revocationTarget || !canRevoke || revoking) return
    setRevoking(true)
    setRevocationError(null)
    try {
      await revokeActivationCode(revocationTarget.id)
      setState((current) => current.kind === "ready" ? { ...current, codes: current.codes.filter((code) => code.id !== revocationTarget.id) } : current)
      setRevocationTarget(null)
    } catch (cause) {
      setRevocationError(cause instanceof Error ? cause.message : "Unable to revoke this activation code.")
    } finally { setRevoking(false) }
  }
  const copy = async (code: ActivationCode) => {
    setCopyError(null)
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(code.code)
      } else {
        const input = document.createElement("textarea")
        input.value = code.code
        input.setAttribute("readonly", "")
        input.style.position = "fixed"
        input.style.opacity = "0"
        document.body.appendChild(input)
        input.select()
        const copied = document.execCommand("copy")
        input.remove()
        if (!copied) throw new Error("Your browser did not allow copying this code.")
      }
      setCopiedCodeId(code.id)
      window.setTimeout(() => setCopiedCodeId((current) => current === code.id ? null : current), 1800)
    } catch (cause) {
      setCopyError(cause instanceof Error ? cause.message : "Could not copy this activation code.")
    }
  }
  return <div className="isolate flex w-full flex-1 flex-col" data-testid="activation-codes">
    <TopBar action={state.kind === "ready" ? <div className="flex flex-wrap gap-2"><Button disabled={!canCreate || creating} onClick={() => void create()} type="button">{creating ? "Generating…" : "Generate code"}</Button><Button onClick={() => setReloadToken((value) => value + 1)} type="button" variant="outline">Refresh</Button></div> : undefined} title="Activation codes" /><div className="flex w-full flex-1 flex-col gap-6 px-4 py-4 antialiased sm:px-6">
    {state.kind === "loading" ? <><Skeleton className="h-28 w-full" /><Skeleton className="h-28 w-full" /></> : null}
    {state.kind === "denied" ? <Alert><PlatformIcon icon={ShieldAlert} /><AlertTitle>Admin access required</AlertTitle><AlertDescription>{state.message}</AlertDescription></Alert> : null}
    {state.kind === "error" ? <Alert variant="destructive"><AlertTitle>Activation codes unavailable</AlertTitle><AlertDescription>{state.message}</AlertDescription></Alert> : null}
    {state.kind === "ready" && !state.user.canAdminWrite ? <Alert><PlatformIcon icon={ShieldAlert} /><AlertTitle>View-only administrator</AlertTitle><AlertDescription>You can inspect activation codes, but only a write administrator can generate or revoke one.</AlertDescription></Alert> : null}
    {isProductionReadOnlyReview && state.kind === "ready" ? <Alert><PlatformIcon icon={ShieldAlert} /><AlertTitle>Changes unavailable</AlertTitle><AlertDescription>Generating and revoking codes are disabled.</AlertDescription></Alert> : null}
    {creationError ? <Alert variant="destructive"><AlertTitle>Could not generate activation code</AlertTitle><AlertDescription>{creationError}</AlertDescription></Alert> : null}
    {copyError ? <Alert variant="destructive"><AlertTitle>Could not copy activation code</AlertTitle><AlertDescription>{copyError}</AlertDescription></Alert> : null}
    {revocationError ? <Alert variant="destructive"><AlertTitle>Could not revoke activation code</AlertTitle><AlertDescription>{revocationError}</AlertDescription></Alert> : null}
    {state.kind === "ready" ? <><div className="flex justify-end"><Button render={<a href="/#admin/codes" />} variant="outline">Manage codes<PlatformIcon data-icon="inline-end" icon={ExternalLink} /></Button></div><ActivationCodesList canRevoke={canRevoke} codes={codes} copiedCodeId={copiedCodeId} onCopy={(code) => void copy(code)} onRevoke={setRevocationTarget} />
      <AlertDialog onOpenChange={(open) => { if (!open && !revoking) setRevocationTarget(null) }} open={Boolean(revocationTarget)}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Revoke activation code?</AlertDialogTitle><AlertDialogDescription>This invalidates <code>{revocationTarget?.code}</code>. It cannot be used to register and this action cannot be undone.</AlertDialogDescription></AlertDialogHeader>{revocationError ? <Alert variant="destructive"><AlertTitle>Could not revoke activation code</AlertTitle><AlertDescription>{revocationError}</AlertDescription></Alert> : null}<AlertDialogFooter><AlertDialogCancel disabled={revoking}>Cancel</AlertDialogCancel><AlertDialogAction disabled={revoking} onClick={() => void revoke()} type="button" variant="destructive">{revoking ? "Revoking…" : "Revoke code"}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
    </> : null}
  </div></div>
}

export function ActivationCodesList({ canRevoke = false, codes, copiedCodeId, onCopy, onRevoke }: { canRevoke?: boolean; codes: ActivationCode[]; copiedCodeId?: number | null; onCopy?: (code: ActivationCode) => void; onRevoke?: (code: ActivationCode) => void }) {
  if (!codes.length) return <Empty><EmptyHeader><EmptyMedia variant="icon"><PlatformIcon icon={KeyRound} /></EmptyMedia><EmptyTitle>No activation codes</EmptyTitle><EmptyDescription>Generate a code to invite someone to register.</EmptyDescription></EmptyHeader></Empty>
  return <section aria-label="Activation codes" className="space-y-3">{codes.map((code) => <Card key={code.id}><CardHeader className="grid-cols-[minmax(0,1fr)_auto] gap-3"><div className="min-w-0"><CardTitle><code className="break-all">{code.code}</code></CardTitle><CardDescription>Created {date(code.created_at)}</CardDescription></div><Badge variant={code.used_by_username ? "outline" : "secondary"}>{code.used_by_username ? "Used" : "Available"}</Badge></CardHeader><CardContent className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground"><span>{code.used_by_username ? `Used by ${code.used_by_username} on ${date(code.used_at)}` : "Not yet used"}</span><div className="flex flex-wrap gap-2">{onCopy ? <Button aria-label={`Copy activation code ${code.code}`} onClick={() => onCopy(code)} size="sm" type="button" variant="outline">{copiedCodeId === code.id ? "Copied" : "Copy"}</Button> : null}{!code.used_by_username && onRevoke ? <Button aria-label={`Revoke activation code ${code.code}`} disabled={!canRevoke} onClick={() => onRevoke(code)} size="sm" type="button" variant="destructive">Revoke</Button> : null}</div></CardContent></Card>)}</section>
}
