import { ExternalLink, Eye, EyeOff, KeyRound, ShieldAlert } from "lucide-react"
import { useEffect, useMemo, useState } from "react"

import { ActionAnchor } from "@/components/action-link"
import { TopBar } from "@/components/top-bar"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { PlatformIcon } from "@/components/platform-icon"
import { Skeleton } from "@/components/ui/skeleton"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
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
    {state.kind === "loading" ? <Skeleton className="h-56 w-full" /> : null}
    {state.kind === "denied" ? <Alert><PlatformIcon icon={ShieldAlert} /><AlertTitle>Admin access required</AlertTitle><AlertDescription>{state.message}</AlertDescription></Alert> : null}
    {state.kind === "error" ? <Alert variant="destructive"><AlertTitle>Activation codes unavailable</AlertTitle><AlertDescription>{state.message}</AlertDescription></Alert> : null}
    {state.kind === "ready" && !state.user.canAdminWrite ? <Alert><PlatformIcon icon={ShieldAlert} /><AlertTitle>View-only administrator</AlertTitle><AlertDescription>You can inspect activation codes, but only a write administrator can generate or revoke one.</AlertDescription></Alert> : null}
    {isProductionReadOnlyReview && state.kind === "ready" ? <Alert><PlatformIcon icon={ShieldAlert} /><AlertTitle>Changes unavailable</AlertTitle><AlertDescription>Generating and revoking codes are disabled.</AlertDescription></Alert> : null}
    {creationError ? <Alert variant="destructive"><AlertTitle>Could not generate activation code</AlertTitle><AlertDescription>{creationError}</AlertDescription></Alert> : null}
    {copyError ? <Alert variant="destructive"><AlertTitle>Could not copy activation code</AlertTitle><AlertDescription>{copyError}</AlertDescription></Alert> : null}
    {revocationError ? <Alert variant="destructive"><AlertTitle>Could not revoke activation code</AlertTitle><AlertDescription>{revocationError}</AlertDescription></Alert> : null}
    {state.kind === "ready" ? <><div className="flex justify-end"><ActionAnchor href="/#admin/codes">Manage codes<PlatformIcon data-icon="inline-end" icon={ExternalLink} /></ActionAnchor></div><ActivationCodesList canRevoke={canRevoke} codes={codes} copiedCodeId={copiedCodeId} onCopy={(code) => void copy(code)} onRevoke={setRevocationTarget} />
      <AlertDialog onOpenChange={(open) => { if (!open && !revoking) setRevocationTarget(null) }} open={Boolean(revocationTarget)}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Revoke activation code?</AlertDialogTitle><AlertDialogDescription>This invalidates <code>{revocationTarget?.code}</code>. It cannot be used to register and this action cannot be undone.</AlertDialogDescription></AlertDialogHeader>{revocationError ? <Alert variant="destructive"><AlertTitle>Could not revoke activation code</AlertTitle><AlertDescription>{revocationError}</AlertDescription></Alert> : null}<AlertDialogFooter><AlertDialogCancel disabled={revoking}>Cancel</AlertDialogCancel><AlertDialogAction disabled={revoking} onClick={() => void revoke()} type="button" variant="destructive">{revoking ? "Revoking…" : "Revoke code"}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
    </> : null}
  </div></div>
}

export function ActivationCodesList({ canRevoke = false, codes, copiedCodeId, defaultShowUsedProvenance = true, onCopy, onRevoke }: { canRevoke?: boolean; codes: ActivationCode[]; copiedCodeId?: number | null; defaultShowUsedProvenance?: boolean; onCopy?: (code: ActivationCode) => void; onRevoke?: (code: ActivationCode) => void }) {
  const [showUsedProvenance, setShowUsedProvenance] = useState(defaultShowUsedProvenance)
  if (!codes.length) return <Empty><EmptyHeader><EmptyMedia variant="icon"><PlatformIcon icon={KeyRound} /></EmptyMedia><EmptyTitle>No activation codes</EmptyTitle><EmptyDescription>Generate a code to invite someone to register.</EmptyDescription></EmptyHeader></Empty>
  const usedCount = codes.filter((code) => Boolean(code.used_by_username)).length
  const availableCount = codes.length - usedCount
  const provenanceAction = showUsedProvenance ? "Hide used code details" : "Show used code details"
  return <section aria-label="Activation codes"><Card className="gap-0 py-0"><div className="flex min-h-14 items-center justify-between gap-4 border-b px-4 sm:px-6"><p className="text-sm text-muted-foreground">{availableCount} available, {usedCount} used</p>{usedCount ? <Tooltip><TooltipTrigger render={<Button aria-label={provenanceAction} aria-pressed={showUsedProvenance} className="relative after:absolute after:top-1/2 after:left-1/2 after:size-13 after:-translate-1/2 after:content-[''] after:pointer-fine:hidden" onClick={() => setShowUsedProvenance((visible) => !visible)} size="icon-sm" title={provenanceAction} type="button" variant="ghost" />}><PlatformIcon icon={showUsedProvenance ? EyeOff : Eye} /></TooltipTrigger><TooltipContent>{provenanceAction}</TooltipContent></Tooltip> : null}</div><ul className="divide-y">{codes.map((code) => {
    const used = Boolean(code.used_by_username)
    const detailsVisible = !used || showUsedProvenance
    return <li className="grid gap-3 px-4 py-4 sm:flex sm:items-center sm:justify-between sm:px-6" key={code.id}><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><code className="break-all font-medium">{detailsVisible ? code.code : "••••••••••••"}</code><Badge variant="secondary">{used ? "Used" : "Available"}</Badge></div><p className="mt-1 text-sm text-muted-foreground">Created {date(code.created_at)}</p>{used ? <p className="mt-1 text-sm text-muted-foreground">{showUsedProvenance ? `Used by ${code.used_by_username} on ${date(code.used_at)}` : "Used details hidden"}</p> : null}</div><div className="flex flex-wrap justify-end gap-2">{onCopy && detailsVisible ? <Button aria-label={`Copy activation code ${code.code}`} onClick={() => onCopy(code)} size="sm" type="button" variant="outline">{copiedCodeId === code.id ? "Copied" : "Copy"}</Button> : null}{!used && onRevoke ? <Button aria-label={`Revoke activation code ${code.code}`} disabled={!canRevoke} onClick={() => onRevoke(code)} size="sm" type="button" variant="outline">Revoke</Button> : null}</div></li>
  })}</ul></Card></section>
}
