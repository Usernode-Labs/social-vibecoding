import { Check, Github, LoaderCircle, Plus } from "lucide-react"
import { useEffect, useState, type FormEvent } from "react"
import { useNavigate } from "react-router-dom"

import { PlatformIcon } from "@/components/platform-icon"
import { TopBar } from "@/components/top-bar"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { getCurrentUser } from "@/lib/auth-api"
import { createApp, verifyRepositoryAccess, type AppVisibility, type VerifyRepoAccess } from "@/lib/apps-api"
import { isProductionReadOnlyReview } from "@/lib/runtime-mode"

export type CreateAppMode = "new" | "import"

function VisibilityChoice({ disabled, label, onChange, value, values }: { disabled: boolean; label: string; onChange: (value: AppVisibility) => void; value: AppVisibility; values: Array<{ description: string; label: string; value: AppVisibility }> }) {
  return <FieldSet>
    <FieldLegend variant="label">{label}</FieldLegend>
    <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label={label}>
      {values.map((option) => <Button aria-checked={value === option.value} disabled={disabled} key={option.value} onClick={() => onChange(option.value)} role="radio" type="button" variant={value === option.value ? "default" : "outline"}>
        {value === option.value ? <PlatformIcon data-icon="inline-start" icon={Check} /> : null}{option.label}
        <span className="sr-only">: {option.description}</span>
      </Button>)}
    </div>
    <FieldDescription>{values.find((option) => option.value === value)?.description}</FieldDescription>
  </FieldSet>
}

export function CreateApp() {
  const navigate = useNavigate()
  const [mode, setMode] = useState<CreateAppMode>("new")
  const [name, setName] = useState("")
  const [repoUrl, setRepoUrl] = useState("")
  const [access, setAccess] = useState<VerifyRepoAccess | null>(null)
  const [checking, setChecking] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [canCreate, setCanCreate] = useState<boolean | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [collabVisibility, setCollabVisibility] = useState<AppVisibility>("public")
  const [viewVisibility, setViewVisibility] = useState<AppVisibility>("public")
  const disabled = submitting || checking || isProductionReadOnlyReview || canCreate !== true

  useEffect(() => {
    const controller = new AbortController()
    let cancelled = false
    void getCurrentUser(controller.signal).then((user) => { if (!cancelled) setCanCreate(user.canCreateApps === true) }).catch((cause: unknown) => {
      if (cancelled || (cause instanceof DOMException && cause.name === "AbortError")) return
      setCanCreate(false)
      setError(cause instanceof Error ? cause.message : "Unable to confirm app creation access.")
    })
    return () => { cancelled = true; controller.abort() }
  }, [])

  function changeMode(next: CreateAppMode) {
    setMode(next); setAccess(null); setError(null)
  }

  function changeCollabVisibility(next: AppVisibility) {
    setCollabVisibility(next)
    if (next === "public") setViewVisibility("public")
  }

  async function checkAccess() {
    if (!repoUrl.trim() || checking || isProductionReadOnlyReview) return
    setChecking(true); setError(null); setAccess(null)
    try {
      const verified = await verifyRepositoryAccess(repoUrl.trim())
      setAccess(verified)
      if (!name.trim() && verified.name) setName(verified.description ? `${verified.name} — ${verified.description}`.slice(0, 80) : verified.name)
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to check repository access.") } finally { setChecking(false) }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (disabled || !name.trim()) return
    if (mode === "import" && (!access || !repoUrl.trim())) {
      setError("Check repository access before importing an app.")
      return
    }
    setSubmitting(true); setError(null)
    try {
      const app = await createApp({ name: name.trim(), ...(mode === "import" ? { repoUrl: repoUrl.trim() } : {}), collabVisibility, viewVisibility })
      navigate(`/apps/${encodeURIComponent(app.slug)}`, { replace: true })
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to create this app.") } finally { setSubmitting(false) }
  }

  return <div className="isolate flex w-full flex-1 flex-col" data-testid="create-app">
    <TopBar title="Create an app" />
    <p className="max-w-2xl text-pretty text-base text-muted-foreground sm:text-sm">Start a new app, or import a GitHub repository that the platform bot can build.</p><div className="flex w-full flex-1 flex-col gap-6 px-4 py-4 antialiased sm:px-6">
    {isProductionReadOnlyReview ? <Alert><AlertTitle>Production review mode</AlertTitle><AlertDescription>App creation is disabled while this local React workspace reviews production data.</AlertDescription></Alert> : null}
    {canCreate === false && !isProductionReadOnlyReview ? <Alert><AlertTitle>App creation unavailable</AlertTitle><AlertDescription>Sign in with an account that has an available app-creation slot.</AlertDescription></Alert> : null}
    {error ? <Alert variant="destructive"><AlertTitle>Could not create app</AlertTitle><AlertDescription>{error}</AlertDescription></Alert> : null}
    <Card className="w-full max-w-2xl"><CardHeader><CardTitle>App source</CardTitle><CardDescription>The server remains authoritative for quotas, visibility, repository access, and creation.</CardDescription></CardHeader><CardContent>
      <CreateAppForm
        access={access}
        checking={checking}
        collabVisibility={collabVisibility}
        disabled={disabled}
        mode={mode}
        name={name}
        onCheckAccess={() => void checkAccess()}
        onCollabVisibilityChange={changeCollabVisibility}
        onModeChange={changeMode}
        onNameChange={setName}
        onRepoUrlChange={(value) => { setRepoUrl(value); setAccess(null) }}
        onSubmit={submit}
        onViewVisibilityChange={setViewVisibility}
        repoUrl={repoUrl}
        submitting={submitting}
        viewVisibility={viewVisibility}
      />
    </CardContent></Card>
  </div></div>
}

export function CreateAppForm({
  access,
  checking,
  collabVisibility,
  disabled,
  mode,
  name,
  onCheckAccess,
  onCollabVisibilityChange,
  onModeChange,
  onNameChange,
  onRepoUrlChange,
  onSubmit,
  onViewVisibilityChange,
  repoUrl,
  submitting,
  viewVisibility,
}: {
  access: VerifyRepoAccess | null
  checking: boolean
  collabVisibility: AppVisibility
  disabled: boolean
  mode: CreateAppMode
  name: string
  onCheckAccess: () => void
  onCollabVisibilityChange: (value: AppVisibility) => void
  onModeChange: (mode: CreateAppMode) => void
  onNameChange: (name: string) => void
  onRepoUrlChange: (url: string) => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
  onViewVisibilityChange: (value: AppVisibility) => void
  repoUrl: string
  submitting: boolean
  viewVisibility: AppVisibility
}) {
  return <form aria-label="Create an app" onSubmit={onSubmit}><FieldGroup>
    <div className="grid grid-cols-2 gap-2" role="tablist" aria-label="App source">
      <Button aria-selected={mode === "new"} onClick={() => onModeChange("new")} role="tab" type="button" variant={mode === "new" ? "default" : "outline"}>Create new</Button>
      <Button aria-selected={mode === "import"} onClick={() => onModeChange("import")} role="tab" type="button" variant={mode === "import" ? "default" : "outline"}>Import existing</Button>
    </div>
    {mode === "import" ? <Field><FieldLabel htmlFor="repo-url">GitHub repository URL</FieldLabel><div className="flex flex-col gap-2 sm:flex-row"><Input autoComplete="off" disabled={disabled} id="repo-url" onChange={(event) => onRepoUrlChange(event.target.value)} placeholder="https://github.com/owner/repo" spellCheck={false} type="url" value={repoUrl} /><Button disabled={disabled || !repoUrl.trim()} onClick={onCheckAccess} type="button" variant="outline"><PlatformIcon data-icon="inline-start" icon={checking ? LoaderCircle : Github} className={checking ? "animate-spin" : undefined} />{checking ? "Checking…" : access ? "Check again" : "Check access"}</Button></div><FieldDescription>Invite <code>usernode-bot</code> to the repository with Write access, then check it here.</FieldDescription>{access ? <p className="text-sm text-primary" role="status">usernode-bot has Write access to {access.fullName || `${access.owner}/${access.repo}`}.</p> : null}</Field> : null}
    <Field><FieldLabel htmlFor="app-name">App name</FieldLabel><Input disabled={disabled || (mode === "import" && !access)} id="app-name" maxLength={80} onChange={(event) => onNameChange(event.target.value)} placeholder="My useful app" required value={name} /></Field>
    <VisibilityChoice disabled={disabled} label="Who can build it" onChange={onCollabVisibilityChange} value={collabVisibility} values={[{ value: "public", label: "Everyone", description: "Anyone on the platform can collaborate." }, { value: "private", label: "Invite-only", description: "Only invited collaborators can build it." }]} />
    <VisibilityChoice disabled={disabled || collabVisibility === "public"} label="Who can see and use it" onChange={onViewVisibilityChange} value={viewVisibility} values={[{ value: "public", label: "Everyone", description: "The app is visible to the community." }, { value: "private", label: "Members", description: "Only members can open the app." }]} />
    <FieldDescription>{collabVisibility === "public" ? "Public collaboration requires public viewing, so the second choice is fixed to Everyone." : "Visibility is applied by the server when the app is created."}</FieldDescription>
    <Button disabled={disabled || !name.trim() || (mode === "import" && !access)} type="submit"><PlatformIcon data-icon="inline-start" icon={submitting ? LoaderCircle : Plus} className={submitting ? "animate-spin" : undefined} />{submitting ? "Creating…" : mode === "import" ? "Import app" : "Create app"}</Button>
  </FieldGroup></form>
}
