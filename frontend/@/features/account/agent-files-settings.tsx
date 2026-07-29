import { Bot, FileCode2, FileText, RefreshCw, Trash2, Upload } from "lucide-react"
import { useEffect, useRef, useState, type ChangeEvent } from "react"

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
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import {
  deleteAgentFile,
  getAgentFileContent,
  getAgentFiles,
  saveAgentFile,
  type AgentFile,
  type AgentFileKind,
  type AgentFileLimits,
} from "@/lib/settings-api"

type FilesState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; files: AgentFile[]; limits: AgentFileLimits }

type Draft = {
  kind: AgentFileKind
  name: string
  description: string
  content: string
  sourceName: string
}

function messageFrom(cause: unknown, fallback: string) {
  return cause instanceof Error && cause.message ? cause.message : fallback
}

function slugify(raw: string) {
  return raw
    .trim()
    .replace(/\.(md|txt)$/i, "")
    .toLowerCase()
    .replace(/[\s_.]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
}

function fileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

function AgentFileRow({
  file,
  readOnly,
  onDeleted,
}: {
  file: AgentFile
  readOnly: boolean
  onDeleted: (file: AgentFile) => void
}) {
  const [content, setContent] = useState<string | null>(null)
  const [viewing, setViewing] = useState(false)
  const [busy, setBusy] = useState<"view" | "delete" | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [deleteOpen, setDeleteOpen] = useState(false)

  const toggleContent = async () => {
    if (viewing) {
      setViewing(false)
      return
    }
    setViewing(true)
    if (content !== null || busy) return
    setBusy("view")
    setError(null)
    try {
      setContent(await getAgentFileContent(file.kind, file.name))
    } catch (cause) {
      setError(messageFrom(cause, "Could not load this file"))
      setContent(null)
    } finally {
      setBusy(null)
    }
  }

  const remove = async () => {
    if (readOnly || busy) return
    setBusy("delete")
    setError(null)
    try {
      await deleteAgentFile(file.kind, file.name)
      setDeleteOpen(false)
      onDeleted(file)
    } catch (cause) {
      setError(messageFrom(cause, "Could not delete this file"))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border p-3" data-testid={`agent-file-${file.kind}-${file.name}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-mono text-sm font-medium">{file.name}</p>
          {file.description ? <p className="mt-1 text-sm text-muted-foreground">{file.description}</p> : null}
        </div>
        <Badge variant="outline">{fileSize(file.sizeBytes)}</Badge>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => void toggleContent()} size="sm" type="button" variant="outline">
          {busy === "view" ? "Loading…" : viewing ? "Hide file" : "View file"}
        </Button>
        <Button
          disabled={readOnly || busy !== null}
          onClick={() => setDeleteOpen(true)}
          size="sm"
          type="button"
          variant="destructive"
        >
          <PlatformIcon data-icon="inline-start" icon={Trash2} />
          Delete
        </Button>
      </div>
      {viewing ? (
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg border bg-muted p-3 font-mono text-xs">
          {busy === "view" ? "Loading…" : content || "(empty)"}
        </pre>
      ) : null}
      {error ? <FieldError>{error}</FieldError> : null}

      <AlertDialog onOpenChange={(open) => { if (!busy) setDeleteOpen(open) }} open={deleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {file.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Coding agents stop receiving this {file.kind} from your next run. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy === "delete"}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy === "delete"}
              onClick={() => void remove()}
              type="button"
              variant="destructive"
            >
              {busy === "delete" ? "Deleting…" : "Delete file"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function AgentFileList({
  files,
  kind,
  readOnly,
  onDeleted,
}: {
  files: AgentFile[]
  kind: AgentFileKind
  readOnly: boolean
  onDeleted: (file: AgentFile) => void
}) {
  const matching = files.filter((file) => file.kind === kind)
  if (matching.length === 0) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <PlatformIcon icon={kind === "skill" ? FileCode2 : FileText} />
          </EmptyMedia>
          <EmptyTitle>No {kind === "skill" ? "skills" : "instruction files"} yet</EmptyTitle>
          <EmptyDescription>
            {kind === "skill"
              ? "Upload a focused skill that agents may use while building for you."
              : "Upload a markdown file with guidance agents should follow on every run you start."}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }
  return (
    <div className="flex flex-col gap-3">
      {matching.map((file) => (
        <AgentFileRow file={file} key={`${file.kind}:${file.name}`} onDeleted={onDeleted} readOnly={readOnly} />
      ))}
    </div>
  )
}

export function AgentFilesSettings({ readOnly }: { readOnly: boolean }) {
  const [state, setState] = useState<FilesState>({ kind: "loading" })
  const [refreshKey, setRefreshKey] = useState(0)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const uploadKindRef = useRef<AgentFileKind>("instruction")

  useEffect(() => {
    const controller = new AbortController()
    setState({ kind: "loading" })
    void getAgentFiles(controller.signal)
      .then(({ files, limits }) => setState({ kind: "ready", files, limits }))
      .catch((cause) => {
        if (!controller.signal.aborted) {
          setState({ kind: "error", message: messageFrom(cause, "Could not load personal agent files") })
        }
      })
    return () => controller.abort()
  }, [refreshKey])

  const beginUpload = (kind: AgentFileKind) => {
    if (readOnly) return
    uploadKindRef.current = kind
    setError(null)
    setNotice(null)
    if (inputRef.current) {
      inputRef.current.value = ""
      inputRef.current.click()
    }
  }

  const readUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file || state.kind !== "ready") return
    if (file.size > state.limits.maxFileBytes) {
      setError(`${file.name} exceeds the ${fileSize(state.limits.maxFileBytes)} limit.`)
      return
    }
    try {
      setDraft({
        kind: uploadKindRef.current,
        name: slugify(file.name),
        description: "",
        content: await file.text(),
        sourceName: file.name,
      })
    } catch {
      setError(`Could not read ${file.name}.`)
    }
  }

  const save = async () => {
    if (!draft || readOnly || saving) return
    if (!draft.name.trim()) {
      setError("Give the file a name.")
      return
    }
    setSaving(true)
    setError(null)
    setNotice(null)
    try {
      await saveAgentFile({
        kind: draft.kind,
        name: draft.name.trim(),
        description: draft.description.trim(),
        content: draft.content,
      })
      setDraft(null)
      setNotice(`Saved ${draft.name}. It applies from your next run.`)
      setRefreshKey((value) => value + 1)
    } catch (cause) {
      setError(messageFrom(cause, "Could not save this file"))
    } finally {
      setSaving(false)
    }
  }

  const removeFile = (file: AgentFile) => {
    setState((current) => current.kind === "ready"
      ? { ...current, files: current.files.filter((candidate) => candidate.kind !== file.kind || candidate.name !== file.name) }
      : current)
    setNotice(`Deleted ${file.name}.`)
  }

  return (
    <Card data-testid="settings-agent-files">
      <CardHeader>
        <div className="flex items-start gap-2">
          <PlatformIcon icon={Bot} />
          <div>
            <CardTitle>Agent instructions and skills</CardTitle>
            <CardDescription>
              Personal markdown files supplied to coding agents on every build or scout run you start.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <input
          accept=".md,.txt,text/markdown,text/plain"
          aria-label="Upload agent file"
          className="sr-only"
          onChange={(event) => void readUpload(event)}
          ref={inputRef}
          tabIndex={-1}
          type="file"
        />
        <div className="flex flex-wrap gap-2">
          <Button disabled={readOnly || state.kind !== "ready"} onClick={() => beginUpload("instruction")} type="button" variant="outline">
            <PlatformIcon data-icon="inline-start" icon={Upload} />
            Upload instruction
          </Button>
          <Button disabled={readOnly || state.kind !== "ready"} onClick={() => beginUpload("skill")} type="button" variant="outline">
            <PlatformIcon data-icon="inline-start" icon={Upload} />
            Upload skill
          </Button>
        </div>

        {draft ? (
          <div className="flex flex-col gap-4 rounded-lg border p-4" data-testid="agent-file-draft">
            <div>
              <p className="font-medium">Review {draft.sourceName}</p>
              <p className="text-sm text-muted-foreground">The server normalizes the name and validates the content again.</p>
            </div>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="agent-file-name">Name</FieldLabel>
                <Input
                  disabled={saving}
                  id="agent-file-name"
                  onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                  value={draft.name}
                />
                <FieldDescription>Lowercase letters, numbers and hyphens; up to 64 characters.</FieldDescription>
              </Field>
              {draft.kind === "skill" ? (
                <Field>
                  <FieldLabel htmlFor="agent-file-description">Description</FieldLabel>
                  <Input
                    disabled={saving}
                    id="agent-file-description"
                    onChange={(event) => setDraft({ ...draft, description: event.target.value })}
                    value={draft.description}
                  />
                </Field>
              ) : null}
              <Field>
                <FieldLabel htmlFor="agent-file-content">File content</FieldLabel>
                <Textarea
                  className="min-h-48 font-mono text-xs"
                  disabled={saving}
                  id="agent-file-content"
                  onChange={(event) => setDraft({ ...draft, content: event.target.value })}
                  value={draft.content}
                />
              </Field>
            </FieldGroup>
            <div className="flex flex-wrap gap-2">
              <Button disabled={saving || !draft.name.trim()} onClick={() => void save()} type="button">
                {saving ? "Saving…" : "Save file"}
              </Button>
              <Button disabled={saving} onClick={() => setDraft(null)} type="button" variant="outline">Cancel</Button>
            </div>
          </div>
        ) : null}

        {state.kind === "loading" ? (
          <>
            <Skeleton className="h-28 w-full" />
            <Skeleton className="h-28 w-full" />
          </>
        ) : null}
        {state.kind === "error" ? (
          <Alert variant="destructive">
            <AlertTitle>Could not load agent files</AlertTitle>
            <AlertDescription>{state.message}</AlertDescription>
          </Alert>
        ) : null}
        {state.kind === "ready" ? (
          <Tabs defaultValue="instruction">
            <TabsList>
              <TabsTrigger value="instruction">
                Instructions <Badge variant="secondary">{state.files.filter((file) => file.kind === "instruction").length}</Badge>
              </TabsTrigger>
              <TabsTrigger value="skill">
                Skills <Badge variant="secondary">{state.files.filter((file) => file.kind === "skill").length}</Badge>
              </TabsTrigger>
            </TabsList>
            <TabsContent value="instruction">
              <AgentFileList files={state.files} kind="instruction" onDeleted={removeFile} readOnly={readOnly} />
            </TabsContent>
            <TabsContent value="skill">
              <AgentFileList files={state.files} kind="skill" onDeleted={removeFile} readOnly={readOnly} />
            </TabsContent>
            <p className="mt-3 text-sm text-muted-foreground">
              Up to {state.limits.maxFilesPerKind} files of each kind, {fileSize(state.limits.maxFileBytes)} per file.
            </p>
          </Tabs>
        ) : null}
        {error ? <FieldError>{error}</FieldError> : null}
        {notice ? <p className="text-sm text-muted-foreground" role="status">{notice}</p> : null}
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
