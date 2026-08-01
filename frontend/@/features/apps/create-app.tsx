import { Github, LoaderCircle, Plus } from "lucide-react"
import { useEffect, useState, type FormEvent, type ReactNode } from "react"
import { useNavigate } from "react-router-dom"

import { ActionLink } from "@/components/action-link"
import { PlatformIcon } from "@/components/platform-icon"
import { TopBar } from "@/components/top-bar"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { getCurrentUser } from "@/lib/auth-api"
import { createApp, verifyRepositoryAccess, type AppVisibility, type VerifyRepoAccess } from "@/lib/apps-api"
import { isProductionReadOnlyReview } from "@/lib/runtime-mode"

export type CreateAppMode = "new" | "import"

type Choice<T extends string> = {
  description: string
  label: string
  value: T
}

function ChoiceGroup<T extends string>({
  disabled,
  label,
  name,
  onChange,
  value,
  values,
}: {
  disabled: boolean
  label: string
  name: string
  onChange: (value: T) => void
  value: T
  values: Array<Choice<T>>
}) {
  return (
    <FieldSet className="gap-3">
      <FieldLegend variant="label">{label}</FieldLegend>
      <div className="grid overflow-hidden rounded-xl border sm:grid-cols-2 sm:divide-x" data-slot="radio-group">
        {values.map((option) => (
          <label
            className="flex min-h-20 cursor-pointer gap-3 border-b px-4 py-3 last:border-b-0 has-[:checked]:bg-muted/60 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50 sm:border-b-0"
            key={option.value}
          >
            <input
              checked={value === option.value}
              className="mt-1 size-4 shrink-0 accent-primary"
              disabled={disabled}
              name={name}
              onChange={() => onChange(option.value)}
              type="radio"
              value={option.value}
            />
            <span className="min-w-0">
              <span className="block text-sm font-medium">{option.label}</span>
              <span className="mt-0.5 block text-sm leading-snug text-muted-foreground">{option.description}</span>
            </span>
          </label>
        ))}
      </div>
    </FieldSet>
  )
}

function VisibilityChoice({
  disabled,
  label,
  name,
  onChange,
  value,
  values,
}: {
  disabled: boolean
  label: string
  name: string
  onChange: (value: AppVisibility) => void
  value: AppVisibility
  values: Array<Choice<AppVisibility>>
}) {
  return <ChoiceGroup disabled={disabled} label={label} name={name} onChange={onChange} value={value} values={values} />
}

function CreationBlocked({
  description,
  onRetry,
  title,
}: {
  description: string
  onRetry?: () => void
  title: string
}) {
  return (
    <Empty className="min-h-64 rounded-none border-y px-6 py-10" data-testid="create-app-blocked">
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        {onRetry ? (
          <Button onClick={onRetry} type="button" variant="outline">Try again</Button>
        ) : (
          <ActionLink to="/">Back to apps</ActionLink>
        )}
      </EmptyContent>
    </Empty>
  )
}

export function CreateApp() {
  const navigate = useNavigate()
  const [mode, setMode] = useState<CreateAppMode>("new")
  const [name, setName] = useState("")
  const [repoUrl, setRepoUrl] = useState("")
  const [access, setAccess] = useState<VerifyRepoAccess | null>(null)
  const [repositoryError, setRepositoryError] = useState<string | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [accessCheckError, setAccessCheckError] = useState<string | null>(null)
  const [accessAttempt, setAccessAttempt] = useState(0)
  const [checking, setChecking] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [canCreate, setCanCreate] = useState<boolean | null>(null)
  const [collabVisibility, setCollabVisibility] = useState<AppVisibility>("public")
  const [viewVisibility, setViewVisibility] = useState<AppVisibility>("public")
  const disabled = submitting || checking || isProductionReadOnlyReview || canCreate !== true

  useEffect(() => {
    const controller = new AbortController()
    let cancelled = false
    setCanCreate(null)
    setAccessCheckError(null)
    void getCurrentUser(controller.signal).then((user) => {
      if (!cancelled) setCanCreate(user.canCreateApps === true)
    }).catch((cause: unknown) => {
      if (cancelled || (cause instanceof DOMException && cause.name === "AbortError")) return
      setAccessCheckError(cause instanceof Error ? cause.message : "Unable to confirm app creation access.")
    })
    return () => { cancelled = true; controller.abort() }
  }, [accessAttempt])

  function changeMode(next: CreateAppMode) {
    setMode(next)
    setAccess(null)
    setRepositoryError(null)
    setSubmitError(null)
  }

  function changeCollabVisibility(next: AppVisibility) {
    setCollabVisibility(next)
    if (next === "public") setViewVisibility("public")
  }

  async function checkAccess() {
    if (!repoUrl.trim() || checking || isProductionReadOnlyReview) return
    setChecking(true)
    setRepositoryError(null)
    setAccess(null)
    try {
      const verified = await verifyRepositoryAccess(repoUrl.trim())
      setAccess(verified)
      if (!name.trim() && verified.name) setName(verified.description ? `${verified.name} — ${verified.description}`.slice(0, 80) : verified.name)
    } catch (cause) {
      setRepositoryError(cause instanceof Error ? cause.message : "Unable to check repository access.")
    } finally {
      setChecking(false)
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (disabled || !name.trim()) return
    if (mode === "import" && (!access || !repoUrl.trim())) {
      setRepositoryError("Check repository access before importing an app.")
      return
    }
    setSubmitting(true)
    setSubmitError(null)
    try {
      const app = await createApp({ name: name.trim(), ...(mode === "import" ? { repoUrl: repoUrl.trim() } : {}), collabVisibility, viewVisibility })
      navigate(`/apps/${encodeURIComponent(app.slug)}`, { replace: true })
    } catch (cause) {
      setSubmitError(cause instanceof Error ? cause.message : "Unable to create this app.")
    } finally {
      setSubmitting(false)
    }
  }

  let content: ReactNode
  if (isProductionReadOnlyReview) {
    content = <CreationBlocked description="App creation is disabled while this local workspace reviews production data." title="Production review mode" />
  } else if (accessCheckError) {
    content = <CreationBlocked description={accessCheckError} onRetry={() => setAccessAttempt((attempt) => attempt + 1)} title="Could not confirm app creation access" />
  } else if (canCreate === null) {
    content = <div className="flex min-h-48 items-center justify-center gap-2 text-sm text-muted-foreground" role="status"><PlatformIcon className="animate-spin" icon={LoaderCircle} />Checking app creation access…</div>
  } else if (!canCreate) {
    content = <CreationBlocked description="This account does not have an available app-creation slot. Ask an administrator to enable creation or raise your app limit." title="App creation unavailable" />
  } else {
    content = (
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
        onRepoUrlChange={(value) => {
          setRepoUrl(value)
          setAccess(null)
          setRepositoryError(null)
        }}
        onSubmit={submit}
        onViewVisibilityChange={setViewVisibility}
        repoUrl={repoUrl}
        repositoryError={repositoryError}
        submitError={submitError}
        submitting={submitting}
        viewVisibility={viewVisibility}
      />
    )
  }

  return (
    <div className="isolate flex w-full flex-1 flex-col" data-testid="create-app">
      <TopBar title="Create an app" />
      <main className="flex w-full flex-1 flex-col px-4 py-6 antialiased sm:px-6 sm:py-8">
        <div className="w-full max-w-2xl">
          <p className="mb-8 max-w-xl text-pretty text-base text-muted-foreground">Start with a blank app, or bring a GitHub repository that Usernode can build.</p>
          {content}
        </div>
      </main>
    </div>
  )
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
  repositoryError,
  submitError,
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
  repositoryError: string | null
  submitError: string | null
  submitting: boolean
  viewVisibility: AppVisibility
}) {
  return (
    <form aria-label="Create an app" onSubmit={onSubmit}>
      <FieldGroup className="gap-10">
        <section className="flex flex-col gap-6">
          <ChoiceGroup
            disabled={disabled}
            label="App source"
            name="app-source"
            onChange={onModeChange}
            value={mode}
            values={[
              { value: "new", label: "Create new", description: "Start with a blank repository." },
              { value: "import", label: "Import existing", description: "Use a GitHub repository you already own." },
            ]}
          />
          {mode === "import" ? (
            <Field data-testid="repository-access-field" data-invalid={repositoryError ? true : undefined}>
              <FieldLabel htmlFor="repo-url">GitHub repository URL</FieldLabel>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input
                  aria-describedby="repository-access-status"
                  aria-invalid={repositoryError ? true : undefined}
                  autoComplete="off"
                  disabled={disabled}
                  id="repo-url"
                  onChange={(event) => onRepoUrlChange(event.target.value)}
                  placeholder="https://github.com/owner/repo"
                  spellCheck={false}
                  type="url"
                  value={repoUrl}
                />
                <Button disabled={disabled || !repoUrl.trim()} onClick={onCheckAccess} type="button" variant="outline">
                  <PlatformIcon className={checking ? "animate-spin" : undefined} data-icon="inline-start" icon={checking ? LoaderCircle : Github} />
                  {checking ? "Checking…" : access ? "Check again" : "Check access"}
                </Button>
              </div>
              <div id="repository-access-status">
                {repositoryError ? <FieldError>{repositoryError}</FieldError> : access ? (
                  <p className="text-sm text-primary" role="status">usernode-bot has Write access to {access.fullName || `${access.owner}/${access.repo}`}.</p>
                ) : (
                  <FieldDescription>{checking ? "Checking whether usernode-bot can build this repository…" : <>Invite <code>usernode-bot</code> with Write access, then check the repository.</>}</FieldDescription>
                )}
              </div>
            </Field>
          ) : null}
          <Field>
            <FieldLabel htmlFor="app-name">App name</FieldLabel>
            <Input disabled={disabled || (mode === "import" && !access)} id="app-name" maxLength={80} onChange={(event) => onNameChange(event.target.value)} placeholder="My useful app" required value={name} />
          </Field>
        </section>

        <FieldSet className="gap-7">
          <FieldLegend>Access</FieldLegend>
          <VisibilityChoice
            disabled={disabled}
            label="Who can build it"
            name="collaboration-visibility"
            onChange={onCollabVisibilityChange}
            value={collabVisibility}
            values={[
              { value: "public", label: "Everyone", description: "Anyone on the platform can collaborate." },
              { value: "private", label: "Invite-only", description: "Only invited collaborators can build it." },
            ]}
          />
          <VisibilityChoice
            disabled={disabled || collabVisibility === "public"}
            label="Who can see and use it"
            name="view-visibility"
            onChange={onViewVisibilityChange}
            value={viewVisibility}
            values={[
              { value: "public", label: "Everyone", description: "The app is visible to the community." },
              { value: "private", label: "Members", description: "Only members can open the app." },
            ]}
          />
          <FieldDescription>{collabVisibility === "public" ? "Public collaboration requires public viewing, so Everyone stays selected." : "These access settings take effect when the app is created."}</FieldDescription>
        </FieldSet>

        <div className="flex flex-col gap-4 border-t pt-6 sm:items-end">
          {submitError ? <Alert className="w-full" tone="negative"><AlertTitle>Could not create app</AlertTitle><AlertDescription>{submitError}</AlertDescription></Alert> : null}
          <Button className="w-full sm:w-auto" disabled={disabled || !name.trim() || (mode === "import" && !access)} type="submit">
            <PlatformIcon className={submitting ? "animate-spin" : undefined} data-icon="inline-start" icon={submitting ? LoaderCircle : Plus} />
            {submitting ? "Creating…" : "Create app"}
          </Button>
        </div>
      </FieldGroup>
    </form>
  )
}
