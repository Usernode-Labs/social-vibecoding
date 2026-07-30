import { ExternalLink, ShieldAlert, UsersRound } from "lucide-react"
import { useEffect, useMemo, useState } from "react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { TopBar } from "@/components/top-bar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Input } from "@/components/ui/input"
import { PlatformIcon } from "@/components/platform-icon"
import { Skeleton } from "@/components/ui/skeleton"
import { AdminAccessError, getAdminUser, getAdminUsers, updateAdminUserDailyLimit, updateAdminUserQuota, type AdminUser, type AdminUserRecord } from "@/lib/admin-api"
import { isProductionReadOnlyReview } from "@/lib/runtime-mode"

type State =
  | { kind: "loading" }
  | { kind: "denied"; message: string }
  | { kind: "error"; message: string }
  | { kind: "ready"; user: AdminUser; users: AdminUserRecord[] }

function role(user: AdminUserRecord) {
  return user.is_admin ? user.admin_readonly ? "View-only admin" : "Admin" : "User"
}

function money(cents?: number | null) {
  return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(Number(cents || 0) / 100)
}

function compactWallet(wallet?: string | null) {
  if (!wallet) return "No wallet linked"
  return wallet.length > 20 ? `${wallet.slice(0, 10)}…${wallet.slice(-8)}` : wallet
}

export function AdminUsersPage() {
  const [state, setState] = useState<State>({ kind: "loading" })
  const [query, setQuery] = useState("")
  const [reloadToken, setReloadToken] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    let cancelled = false
    void (async () => {
      try {
        const [user, users] = await Promise.all([getAdminUser(controller.signal), getAdminUsers(controller.signal)])
        if (!cancelled) setState({ kind: "ready", user, users })
      } catch (cause) {
        if (cancelled || (cause instanceof DOMException && cause.name === "AbortError")) return
        const message = cause instanceof Error ? cause.message : "Unable to load users."
        if (!cancelled) setState(cause instanceof AdminAccessError ? { kind: "denied", message } : { kind: "error", message })
      }
    })()
    return () => { cancelled = true; controller.abort() }
  }, [reloadToken])

  const users = useMemo(() => state.kind === "ready" ? state.users.filter((user) => user.username.toLowerCase().includes(query.trim().toLowerCase())) : [], [query, state])
  const updateUser = (id: number, updates: Partial<AdminUserRecord>) => setState((current) => current.kind === "ready" ? { ...current, users: current.users.map((user) => user.id === id ? { ...user, ...updates } : user) } : current)
  const canWrite = state.kind === "ready" && state.user.canAdminWrite && !isProductionReadOnlyReview
  return <div className="isolate flex w-full flex-1 flex-col" data-testid="admin-users">
    <TopBar action={state.kind === "ready" ? <Button onClick={() => setReloadToken((value) => value + 1)} type="button" variant="outline">Refresh</Button> : undefined} title="Users" /><div className="flex w-full flex-1 flex-col gap-6 px-4 py-4 antialiased sm:px-6">
    {state.kind === "loading" ? <div className="space-y-3"><Skeleton className="h-10 w-full" /><Skeleton className="h-32 w-full" /><Skeleton className="h-32 w-full" /></div> : null}
    {state.kind === "denied" ? <Alert><PlatformIcon icon={ShieldAlert} /><AlertTitle>Admin access required</AlertTitle><AlertDescription>{state.message}</AlertDescription></Alert> : null}
    {state.kind === "error" ? <Alert variant="destructive"><AlertTitle>Users unavailable</AlertTitle><AlertDescription>{state.message}</AlertDescription></Alert> : null}
    {state.kind === "ready" && !state.user.canAdminWrite ? <Alert><PlatformIcon icon={ShieldAlert} /><AlertTitle>View-only administrator</AlertTitle><AlertDescription>You can inspect users, but a write administrator is required to change quotas or spend overrides.</AlertDescription></Alert> : null}
    {state.kind === "ready" && isProductionReadOnlyReview ? <Alert><PlatformIcon icon={ShieldAlert} /><AlertTitle>Changes unavailable</AlertTitle><AlertDescription>Quota and spend changes are disabled.</AlertDescription></Alert> : null}
    {state.kind === "ready" ? <><div className="flex flex-wrap items-center justify-between gap-3"><Input aria-label="Filter users" className="max-w-sm" onChange={(event) => setQuery(event.target.value)} placeholder="Filter users" value={query} /><Button render={<a href="/#admin/users" />} variant="outline">Manage accounts<PlatformIcon data-icon="inline-end" icon={ExternalLink} /></Button></div>{!users.length ? <Empty><EmptyHeader><EmptyMedia variant="icon"><PlatformIcon icon={UsersRound} /></EmptyMedia><EmptyTitle>No matching users</EmptyTitle><EmptyDescription>Try another name, or clear the filter.</EmptyDescription></EmptyHeader></Empty> : <section aria-label="Platform users" className="space-y-3">{users.map((user) => <UserCard canWrite={canWrite} key={user.id} onUpdate={updateUser} user={user} />)}</section>}</> : null}
  </div></div>
}

export function AdminUsersList({ users }: { users: AdminUserRecord[] }) {
  return <section aria-label="Platform users" className="space-y-3">{users.map((user) => <UserCard key={user.id} user={user} />)}</section>
}

function UserCard({ canWrite = false, onUpdate, user }: { canWrite?: boolean; onUpdate?: (id: number, updates: Partial<AdminUserRecord>) => void; user: AdminUserRecord }) {
  const [quota, setQuota] = useState(String(user.app_quota ?? 0))
  const [dailyLimit, setDailyLimit] = useState(user.daily_limit_cents == null ? "" : String(user.daily_limit_cents))
  const [saving, setSaving] = useState<"quota" | "daily" | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { setQuota(String(user.app_quota ?? 0)); setDailyLimit(user.daily_limit_cents == null ? "" : String(user.daily_limit_cents)) }, [user.app_quota, user.daily_limit_cents])
  const saveQuota = async () => {
    const value = Number(quota)
    if (!Number.isInteger(value) || value < 0) return setError("Quota must be a non-negative whole number.")
    setSaving("quota"); setError(null)
    try { const response = await updateAdminUserQuota(user.id, value); onUpdate?.(user.id, { app_quota: response.app_quota }) } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to update quota.") } finally { setSaving(null) }
  }
  const saveDailyLimit = async () => {
    const value = dailyLimit === "" ? null : Number(dailyLimit)
    if (value !== null && (!Number.isInteger(value) || value < 0)) return setError("Daily cap must be a non-negative whole-cent amount or blank.")
    setSaving("daily"); setError(null)
    try { const response = await updateAdminUserDailyLimit(user.id, value); onUpdate?.(user.id, { daily_limit_cents: response.daily_limit_cents }) } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to update daily cap.") } finally { setSaving(null) }
  }
  return <Card><CardHeader className="grid-cols-[minmax(0,1fr)_auto] gap-3"><div className="min-w-0"><CardTitle className="truncate">{user.username}{user.is_self ? " (you)" : ""}</CardTitle><CardDescription>{compactWallet(user.usernode_pubkey)}</CardDescription></div><Badge variant={user.is_admin ? "secondary" : "outline"}>{role(user)}</Badge></CardHeader><CardContent className="grid gap-3 text-sm sm:grid-cols-3"><dl><dt className="text-muted-foreground">Apps</dt><dd className="mt-1 tabular-nums">{Number(user.apps_created || 0)} / {user.app_quota ?? 0}</dd></dl><dl><dt className="text-muted-foreground">Today’s LLM spend</dt><dd className="mt-1 tabular-nums">{money(user.cost_today_cents)}</dd></dl><dl><dt className="text-muted-foreground">Daily cap</dt><dd className="mt-1 tabular-nums">{user.daily_limit_cents == null ? "Platform default" : money(user.daily_limit_cents)}</dd></dl>{user.activation_code ? <p className="sm:col-span-3 text-muted-foreground">Activation code: <code>{user.activation_code}</code></p> : null}{onUpdate ? <div className="grid gap-3 border-t pt-3 sm:col-span-3 sm:grid-cols-2"><div className="grid gap-1"><span className="text-muted-foreground">App quota</span><div className="flex gap-2"><Input aria-label={`App quota for ${user.username}`} disabled={!canWrite || saving !== null} inputMode="numeric" min="0" onChange={(event) => setQuota(event.target.value)} step="1" type="number" value={quota} /><Button aria-label={`Save app quota for ${user.username}`} disabled={!canWrite || saving !== null} onClick={() => void saveQuota()} size="sm" type="button" variant="outline">Save</Button></div></div><div className="grid gap-1"><span className="text-muted-foreground">Daily cap (cents)</span><div className="flex gap-2"><Input aria-label={`Daily cap for ${user.username}`} disabled={!canWrite || saving !== null} inputMode="numeric" min="0" onChange={(event) => setDailyLimit(event.target.value)} placeholder="Platform default" step="1" type="number" value={dailyLimit} /><Button aria-label={`Save daily cap for ${user.username}`} disabled={!canWrite || saving !== null} onClick={() => void saveDailyLimit()} size="sm" type="button" variant="outline">Save</Button></div></div>{error ? <Alert className="sm:col-span-2" variant="destructive"><AlertTitle>Could not update {user.username}</AlertTitle><AlertDescription>{error}</AlertDescription></Alert> : null}</div> : null}</CardContent></Card>
}
