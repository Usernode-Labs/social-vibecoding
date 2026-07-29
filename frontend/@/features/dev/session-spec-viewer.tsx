import { ArrowLeft, Check, FileText, Share2, UserRoundPlus } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { Link, useParams } from "react-router-dom"

import { PlatformIcon } from "@/components/platform-icon"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  getSessionSpec,
  getSessionSpecVersion,
  shareSessionSpecToGroup,
  shareSessionSpecToUser,
  type SessionSpecVersion,
  type ShareSessionSpecToUserResponse,
} from "@/lib/dev-chat-api"
import { getMentionSuggestions } from "@/lib/group-chat-api"
import { appDevSessionPath } from "@/lib/routes"
import { isProductionReadOnlyReview } from "@/lib/runtime-mode"

const SPEC_DATE_FORMATTER = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" })

export function splitSpecSections(markdown: string) {
  const lines = markdown.split("\n")
  const user = lines.findIndex((line) => /^#{1,3}\s+user[- ]facing changes?\s*:?\s*$/i.test(line))
  const tech = lines.findIndex((line) => /^#{1,3}\s+technical implementation\s*:?\s*$/i.test(line))
  if (user < 0 || tech < 0) return null
  const first = Math.min(user, tech)
  const half = (at: number, other: number) => lines.slice(at + 1, other > at ? other : undefined).join("\n").trim()
  return {
    preamble: lines.slice(0, first).join("\n").trim(),
    userFacing: half(user, tech),
    technical: half(tech, user),
  }
}

function formatDate(value?: string | null) {
  return value ? SPEC_DATE_FORMATTER.format(new Date(value)) : "Unknown date"
}

type SpecSharingControlsProps = {
  alreadyShared?: boolean
  disabled?: boolean
  mentionSuggestions?: string[]
  onShareGroup: () => Promise<void>
  onShareUser: (username: string) => Promise<ShareSessionSpecToUserResponse>
  version: number
}

const EMPTY_SUGGESTIONS: string[] = []

export function SpecSharingControls({
  alreadyShared = false,
  disabled = false,
  mentionSuggestions = EMPTY_SUGGESTIONS,
  onShareGroup,
  onShareUser,
  version,
}: SpecSharingControlsProps) {
  const [groupOpen, setGroupOpen] = useState(false)
  const [userOpen, setUserOpen] = useState(false)
  const [busy, setBusy] = useState<"group" | "user" | null>(null)
  const [username, setUsername] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const matchingSuggestions = useMemo(() => {
    const query = username.trim().replace(/^@/, "").toLocaleLowerCase()
    return mentionSuggestions
      .filter((candidate) => !query || candidate.toLocaleLowerCase().startsWith(query))
      .slice(0, 6)
  }, [mentionSuggestions, username])

  async function shareGroup() {
    setBusy("group")
    setError(null)
    try {
      await onShareGroup()
      setNotice(`Version ${version} was shared to the app discussion.`)
      setGroupOpen(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The spec could not be shared.")
    } finally {
      setBusy(null)
    }
  }

  async function shareUser() {
    const recipient = username.trim().replace(/^@/, "")
    if (!recipient) {
      setError("Enter a username.")
      return
    }
    setBusy("user")
    setError(null)
    try {
      const result = await onShareUser(recipient)
      setNotice(result.alreadyShared
        ? `Version ${version} was already shared with @${result.recipient.username}.`
        : `Version ${version} was shared with @${result.recipient.username}.`)
      setUsername("")
      setUserOpen(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The spec could not be shared.")
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="flex flex-col gap-3" data-testid="spec-sharing">
      <div className="flex flex-wrap gap-2">
        <AlertDialog open={groupOpen} onOpenChange={(open) => { if (!busy) { setGroupOpen(open); setError(null) } }}>
          <AlertDialogTrigger
            disabled={disabled || alreadyShared}
            render={<Button type="button" variant="outline" />}
          >
            <PlatformIcon data-icon="inline-start" icon={alreadyShared ? Check : Share2} />
            {alreadyShared ? "Shared to group" : "Share to group"}
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Share spec version {version} to the app discussion?</AlertDialogTitle>
              <AlertDialogDescription>
                This posts an immutable spec card that everyone who can view the app discussion can open.
              </AlertDialogDescription>
            </AlertDialogHeader>
            {error ? <FieldError>{error}</FieldError> : null}
            <AlertDialogFooter>
              <AlertDialogCancel disabled={busy === "group"}>Cancel</AlertDialogCancel>
              <Button disabled={busy === "group"} onClick={() => void shareGroup()} type="button">
                {busy === "group" ? "Sharing…" : "Share to group"}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <AlertDialog open={userOpen} onOpenChange={(open) => { if (!busy) { setUserOpen(open); setError(null) } }}>
          <AlertDialogTrigger disabled={disabled} render={<Button type="button" variant="outline" />}>
            <PlatformIcon data-icon="inline-start" icon={UserRoundPlus} />
            Share privately
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Share spec version {version} with one person</AlertDialogTitle>
              <AlertDialogDescription>
                They receive a private notification and access to this immutable version. Private apps still require collaboration access.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <Field>
              <FieldLabel htmlFor="spec-share-username">Username</FieldLabel>
              <Input
                autoComplete="off"
                autoFocus
                id="spec-share-username"
                maxLength={32}
                onChange={(event) => { setUsername(event.target.value); setError(null) }}
                placeholder="username"
                value={username}
              />
              <FieldDescription>Enter an exact username or choose a collaborator below.</FieldDescription>
              {matchingSuggestions.length ? (
                <div aria-label="Suggested recipients" className="flex flex-wrap gap-2">
                  {matchingSuggestions.map((candidate) => (
                    <Button key={candidate} onClick={() => setUsername(candidate)} size="xs" type="button" variant="secondary">
                      @{candidate}
                    </Button>
                  ))}
                </div>
              ) : null}
              {error ? <FieldError>{error}</FieldError> : null}
            </Field>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={busy === "user"}>Cancel</AlertDialogCancel>
              <Button disabled={busy === "user" || !username.trim()} onClick={() => void shareUser()} type="button">
                {busy === "user" ? "Sending…" : "Share privately"}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
      {disabled ? <p className="text-sm text-muted-foreground">Sharing is disabled while this local workspace reviews production data.</p> : null}
      {notice ? <p aria-live="polite" className="text-sm text-muted-foreground">{notice}</p> : null}
    </div>
  )
}

export function SessionSpecViewer() {
  const { slug = "", sessionId = "" } = useParams()
  const [spec, setSpec] = useState<string | null>(null)
  const [latestSpec, setLatestSpec] = useState("")
  const [versions, setVersions] = useState<SessionSpecVersion[]>([])
  const [selected, setSelected] = useState("latest")
  const [mentionSuggestions, setMentionSuggestions] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)

  async function load(signal?: AbortSignal) {
    const data = await getSessionSpec(sessionId, signal)
    if (signal?.aborted) return
    setLatestSpec(data.spec)
    setVersions(data.versions)
    setSpec((current) => selected === "latest" || current === null ? data.spec : current)
  }

  useEffect(() => {
    const controller = new AbortController()
    setSpec(null)
    setError(null)
    setSelected("latest")
    void load(controller.signal).catch((cause) => {
      if (!(cause instanceof DOMException && cause.name === "AbortError")) {
        setError(cause instanceof Error ? cause.message : "Unable to load spec")
      }
    })
    void getMentionSuggestions(slug, controller.signal)
      .then(setMentionSuggestions)
      .catch(() => setMentionSuggestions([]))
    return () => controller.abort()
    // `load` deliberately resets against the route identity only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, slug])

  useEffect(() => {
    if (selected === "latest") {
      setSpec(latestSpec)
      return
    }
    const controller = new AbortController()
    setError(null)
    void getSessionSpecVersion(sessionId, Number(selected), controller.signal)
      .then((data) => setSpec(data.spec.content))
      .catch((cause) => {
        if (!(cause instanceof DOMException && cause.name === "AbortError")) {
          setError(cause instanceof Error ? cause.message : "Unable to load spec version")
        }
      })
    return () => controller.abort()
  }, [latestSpec, selected, sessionId])

  const selectedMeta = selected === "latest"
    ? versions[0]
    : versions.find((item) => String(item.version) === selected)
  const back = appDevSessionPath(slug, sessionId)

  return (
    <div className="isolate mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-4 py-8 antialiased sm:px-6" data-testid="session-spec">
      <Button className="w-fit" render={<Link to={back} />} variant="ghost">
        <PlatformIcon data-icon="inline-start" icon={ArrowLeft} />
        Session
      </Button>
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">Session spec</h1>
        <p className="text-muted-foreground">Inspect and share immutable planning versions produced by this Dev session.</p>
      </header>
      {error ? <Alert variant="destructive"><AlertTitle>Spec unavailable</AlertTitle><AlertDescription>{error}</AlertDescription></Alert> : null}
      {spec === null && !error ? <><Skeleton className="h-10 w-48" /><Skeleton className="h-96 w-full" /></> : null}
      {spec !== null ? (
        <>
          <SpecDocument content={spec} onVersion={setSelected} selected={selected} versions={versions} />
          {selectedMeta && spec.trim() ? (
            <SpecSharingControls
              alreadyShared={Boolean(selectedMeta.shared_to_group_at)}
              disabled={isProductionReadOnlyReview}
              mentionSuggestions={mentionSuggestions}
              onShareGroup={async () => {
                await shareSessionSpecToGroup(sessionId, selectedMeta.version)
                await load()
              }}
              onShareUser={(username) => shareSessionSpecToUser(sessionId, selectedMeta.version, username)}
              version={selectedMeta.version}
            />
          ) : null}
        </>
      ) : null}
    </div>
  )
}

export function SpecDocument({
  content,
  versions,
  selected = "latest",
  onVersion,
}: {
  content: string
  versions: SessionSpecVersion[]
  selected?: string
  onVersion?: (version: string) => void
}) {
  if (!content.trim()) {
    return <Empty><EmptyHeader><EmptyMedia variant="icon"><PlatformIcon icon={FileText} /></EmptyMedia><EmptyTitle>No spec yet</EmptyTitle><EmptyDescription>This session has not produced a planning artifact.</EmptyDescription></EmptyHeader></Empty>
  }
  const split = splitSpecSections(content)
  const selectedMeta = selected === "latest"
    ? versions[0]
    : versions.find((item) => String(item.version) === selected)
  return (
    <Card>
      <CardHeader className="gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <CardTitle className="flex flex-wrap items-center gap-2">
            Specification
            {selectedMeta?.shared_to_group_at ? <Badge variant="secondary">Shared</Badge> : null}
          </CardTitle>
          <CardDescription>{selected === "latest" ? "Latest immutable version" : `Version ${selected}`} {selectedMeta ? `· ${formatDate(selectedMeta.built_at)}` : ""}</CardDescription>
        </div>
        <Select onValueChange={(value) => { if (value) onVersion?.(value) }} value={selected}>
          <SelectTrigger aria-label="Spec version"><SelectValue /></SelectTrigger>
          <SelectContent>
            {versions[0] ? <SelectItem value="latest">v{versions[0].version} · latest</SelectItem> : null}
            {versions.slice(1).map((item) => <SelectItem key={item.version} value={String(item.version)}>v{item.version}{item.pr_number ? ` · PR #${item.pr_number}` : ""}</SelectItem>)}
          </SelectContent>
        </Select>
      </CardHeader>
      <CardContent>
        {split ? (
          <Tabs defaultValue="user">
            <TabsList aria-label="Spec sections"><TabsTrigger value="user">User-facing</TabsTrigger><TabsTrigger value="technical">Technical</TabsTrigger></TabsList>
            {split.preamble ? <p className="mt-4 whitespace-pre-wrap text-sm">{split.preamble}</p> : null}
            <TabsContent value="user"><SpecText content={split.userFacing} /></TabsContent>
            <TabsContent value="technical"><SpecText content={split.technical} /></TabsContent>
          </Tabs>
        ) : <SpecText content={content} />}
      </CardContent>
    </Card>
  )
}

function SpecText({ content }: { content: string }) {
  return <article className="mt-4 max-w-none whitespace-pre-wrap text-sm leading-6">{content || "Nothing in this section."}</article>
}
