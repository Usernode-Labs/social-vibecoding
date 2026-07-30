import { File, FileArchive, FileText, ImageIcon, Paperclip, Save, SendHorizontal, X } from "lucide-react"
import { useEffect, useRef, useState } from "react"

import { PlatformIcon } from "@/components/platform-icon"
import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle,
} from "@/components/ui/attachment"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from "@/components/ui/input-group"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { prepareDevAlerts, readBrowserPreference, requestDevAlertPermission, writeBrowserPreference } from "@/lib/browser-preferences"
import { getDevModels, startDevChat, uploadDevAttachment, type DevAttachment, type DevModel } from "@/lib/dev-chat-api"
import {
  createSavedDevDraft,
  MAX_SAVED_DEV_DRAFTS,
  readDevSessionDraft,
  readSavedDevDrafts,
  saveDevSessionDraft,
  saveSavedDevDrafts,
} from "@/lib/dev-session-draft"
import { DevBudgetStatus } from "@/features/dev/dev-budget-status"
import { DevSavedDraftsView } from "@/features/dev/dev-saved-drafts"

type PendingAttachment = DevAttachment & {
  clientId: string
  previewUrl?: string
  state: "uploading" | "done"
}

type DevComposerProps = {
  disabled?: boolean
  onTurnStarted: () => void
  quickReplies?: string[]
  sessionId: string
  streaming?: boolean
  suggestions?: DevSuggestionGroup[]
}

export type DevSuggestionGroup = {
  question: string
  answers: string[]
}

function formatSize(bytes: number) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} B`
}

function attachmentIcon(kind: PendingAttachment["kind"]) {
  if (kind === "image") return ImageIcon
  if (kind === "text") return FileText
  if (kind === "zip") return FileArchive
  return File
}

const MODEL_STORAGE_KEY = "usernode:dc:model"
const FALLBACK_MODEL = "claude-opus-5"

function storedModel() {
  return readBrowserPreference(MODEL_STORAGE_KEY)?.trim() || FALLBACK_MODEL
}

/**
 * The first write-enabled Dev surface. Attachments are uploaded before the
 * message, exactly as the existing session route requires; the server remains
 * authoritative for classification, limits, ownership, and billing.
 */
export function DevComposer({
  disabled = false,
  onTurnStarted,
  quickReplies = [],
  sessionId,
  streaming = false,
  suggestions = [],
}: DevComposerProps) {
  const fileInput = useRef<HTMLInputElement>(null)
  const messageInput = useRef<HTMLTextAreaElement>(null)
  const previewUrls = useRef(new Set<string>())
  const [message, setMessage] = useState(() => readDevSessionDraft(sessionId))
  const [attachments, setAttachments] = useState<PendingAttachment[]>([])
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [models, setModels] = useState<DevModel[]>([])
  const [modelError, setModelError] = useState<string | null>(null)
  const [selectedModel, setSelectedModel] = useState(storedModel)
  const [selectedAnswers, setSelectedAnswers] = useState<Record<number, number>>({})
  const [savedDrafts, setSavedDrafts] = useState(() => readSavedDevDrafts(sessionId))
  const suggestionsFingerprint = suggestions.map((group) => `${group.question}\u0000${group.answers.join("\u0001")}`).join("\u0002")

  useEffect(() => () => {
    previewUrls.current.forEach((url) => URL.revokeObjectURL(url))
  }, [])

  useEffect(() => {
    setMessage(readDevSessionDraft(sessionId))
    setSelectedAnswers({})
    setSavedDrafts(readSavedDevDrafts(sessionId))
  }, [sessionId])

  useEffect(() => {
    setSelectedAnswers({})
  }, [suggestionsFingerprint])

  useEffect(() => {
    saveDevSessionDraft(sessionId, message)
  }, [message, sessionId])

  useEffect(() => {
    const controller = new AbortController()
    let cancelled = false
    getDevModels(controller.signal).then(({ defaultModel, models: availableModels }) => {
      if (cancelled) return
      setModels(availableModels)
      setSelectedModel((current) => availableModels.some((model) => model.id === current) ? current : defaultModel)
      setModelError(null)
    }).catch((cause: unknown) => {
      if (cancelled || (cause instanceof DOMException && cause.name === "AbortError")) return
      setModelError(cause instanceof Error ? cause.message : "Model selection is unavailable.")
    })
    return () => { cancelled = true; controller.abort() }
  }, [])

  const busy = disabled || submitting || attachments.some((attachment) => attachment.state === "uploading")
  const canSend = !busy && !streaming && (message.trim().length > 0 || attachments.some((attachment) => attachment.state === "done"))

  function storeSavedDrafts(next: typeof savedDrafts) {
    setSavedDrafts(next)
    saveSavedDevDrafts(sessionId, next)
  }

  function saveCurrentMessageForLater() {
    const text = message.trim()
    if (!streaming || !text || disabled || submitting) return
    if (savedDrafts.length >= MAX_SAVED_DEV_DRAFTS) {
      setError(`Up to ${MAX_SAVED_DEV_DRAFTS} drafts can be saved. Send or delete one first.`)
      return
    }
    storeSavedDrafts([...savedDrafts, createSavedDevDraft(text)])
    setMessage("")
    saveDevSessionDraft(sessionId, "")
    setError(null)
    if (window.matchMedia?.("(pointer: fine)").matches) {
      requestAnimationFrame(() => messageInput.current?.focus())
    }
  }

  async function sendSavedDraft(id: string) {
    if (busy || streaming) return
    const draft = savedDrafts.find((candidate) => candidate.id === id)
    if (!draft) return
    prepareDevAlerts()
    requestDevAlertPermission()
    setSubmitting(true)
    setError(null)
    const next = savedDrafts.filter((candidate) => candidate.id !== id)
    storeSavedDrafts(next)
    try {
      await startDevChat(sessionId, { message: draft.text, attachmentIds: [], model: selectedModel })
      onTurnStarted()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to send the saved draft")
    } finally {
      setSubmitting(false)
    }
  }

  function editSavedDraft(id: string) {
    if (busy) return
    const draft = savedDrafts.find((candidate) => candidate.id === id)
    if (!draft) return
    const currentMessage = message.trim()
    const remaining = savedDrafts.filter((candidate) => candidate.id !== id)
    const next = currentMessage
      ? [...remaining, createSavedDevDraft(currentMessage)]
      : remaining
    storeSavedDrafts(next)
    setMessage(draft.text)
    saveDevSessionDraft(sessionId, draft.text)
    setError(null)
    if (window.matchMedia?.("(pointer: fine)").matches) {
      requestAnimationFrame(() => {
        messageInput.current?.focus()
        messageInput.current?.setSelectionRange(draft.text.length, draft.text.length)
      })
    }
  }

  function deleteSavedDraft(id: string) {
    if (busy) return
    storeSavedDrafts(savedDrafts.filter((candidate) => candidate.id !== id))
    setError(null)
  }

  function selectModel(nextModel: string | null) {
    if (!nextModel) return
    setSelectedModel(nextModel)
    writeBrowserPreference(MODEL_STORAGE_KEY, nextModel)
  }

  function applyQuickReply(reply: string) {
    if (busy) return
    setMessage(reply)
    let coarsePointer = false
    try {
      coarsePointer = window.matchMedia("(pointer: coarse)").matches
    } catch {
      coarsePointer = navigator.maxTouchPoints > 0
    }
    if (coarsePointer) return
    requestAnimationFrame(() => {
      messageInput.current?.focus()
      messageInput.current?.setSelectionRange(reply.length, reply.length)
    })
  }

  async function addFiles(files: FileList | null) {
    if (!files || busy) return
    setError(null)
    const available = 4 - attachments.length
    if (available <= 0) {
      setError("Up to 4 files can be attached to a message.")
      return
    }
    const selected = Array.from(files).slice(0, available)
    if (files.length > available) setError("Up to 4 files can be attached to a message.")

    for (const file of selected) {
      const clientId = crypto.randomUUID()
      const previewUrl = file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined
      if (previewUrl) previewUrls.current.add(previewUrl)
      const pending: PendingAttachment = {
        id: "",
        clientId,
        kind: file.type.startsWith("image/") ? "image" : "binary",
        filename: file.name,
        contentType: file.type || "application/octet-stream",
        sizeBytes: file.size,
        meta: null,
        previewUrl,
        state: "uploading",
      }
      setAttachments((current) => [...current, pending])
      try {
        const uploaded = await uploadDevAttachment(sessionId, file)
        setAttachments((current) => current.map((attachment) => attachment.clientId === clientId
          ? { ...uploaded, clientId, previewUrl, state: "done" }
          : attachment))
      } catch (cause) {
        if (previewUrl) {
          URL.revokeObjectURL(previewUrl)
          previewUrls.current.delete(previewUrl)
        }
        setAttachments((current) => current.filter((attachment) => attachment.clientId !== clientId))
        setError(cause instanceof Error ? cause.message : "Upload failed")
      }
    }
  }

  function removeAttachment(clientId: string) {
    setAttachments((current) => {
      const target = current.find((attachment) => attachment.clientId === clientId)
      if (target?.previewUrl) {
        URL.revokeObjectURL(target.previewUrl)
        previewUrls.current.delete(target.previewUrl)
      }
      return current.filter((attachment) => attachment.clientId !== clientId)
    })
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!canSend) return
    prepareDevAlerts()
    requestDevAlertPermission()
    setSubmitting(true)
    setError(null)
    const sentAttachments = attachments.filter((attachment) => attachment.state === "done")
    try {
      await startDevChat(sessionId, { message: message.trim(), attachmentIds: sentAttachments.map((attachment) => attachment.id), model: selectedModel })
      attachments.forEach((attachment) => {
        if (attachment.previewUrl) {
          URL.revokeObjectURL(attachment.previewUrl)
          previewUrls.current.delete(attachment.previewUrl)
        }
      })
      setMessage("")
      saveDevSessionDraft(sessionId, "")
      setAttachments([])
      onTurnStarted()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to start the Dev turn")
    } finally {
      setSubmitting(false)
    }
  }

  async function sendSuggestedAnswer(text: string) {
    if (busy || message.trim() || attachments.length) return
    prepareDevAlerts()
    requestDevAlertPermission()
    setSubmitting(true)
    setError(null)
    try {
      await startDevChat(sessionId, { message: text, attachmentIds: [], model: selectedModel })
      setSelectedAnswers({})
      onTurnStarted()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to send the suggested answer")
    } finally {
      setSubmitting(false)
    }
  }

  const selectedReply = suggestions.map((group, index) => {
    const answerIndex = selectedAnswers[index]
    return answerIndex === undefined ? null : `${index + 1}. ${group.answers[answerIndex]}`
  }).filter((answer): answer is string => Boolean(answer)).join("\n")
  const defaultReply = suggestions.map((group, index) => `${index + 1}. ${group.answers[0]}`).join("\n")
  const suggestionsDisabled = busy || streaming || Boolean(message.trim()) || attachments.length > 0

  return <form aria-label="Send a message to Builder" className="sticky bottom-0 border-t bg-background py-4" onSubmit={submit}>
    <FieldGroup className="gap-3">
      <DevSavedDraftsView
        busy={busy}
        drafts={savedDrafts}
        onDelete={deleteSavedDraft}
        onEdit={editSavedDraft}
        onSend={(id) => void sendSavedDraft(id)}
        streaming={streaming}
      />
      {suggestions.length ? <section aria-labelledby="builder-questions-heading" className="flex flex-col gap-3 rounded-xl border bg-card p-3">
        <div>
          <h3 className="text-sm font-medium" id="builder-questions-heading">Builder needs your input</h3>
          <p className="text-xs text-muted-foreground">
            {suggestionsDisabled && !busy ? "Send or clear the current draft and attachments before using a suggested answer." : "Choose an answer or keep typing your own response."}
          </p>
        </div>
        {suggestions.map((group, groupIndex) => <fieldset className="flex flex-col gap-2" key={`${group.question}:${groupIndex}`}>
          {suggestions.length > 1 ? <legend className="text-sm font-medium">{group.question || `Question ${groupIndex + 1}`}</legend> : null}
          <div className="flex flex-wrap gap-2">
            {group.answers.map((answer, answerIndex) => <Button
              aria-pressed={suggestions.length > 1 ? selectedAnswers[groupIndex] === answerIndex : undefined}
              disabled={suggestionsDisabled}
              key={answer}
              onClick={() => {
                if (suggestions.length === 1) {
                  void sendSuggestedAnswer(answer)
                  return
                }
                setSelectedAnswers((current) => ({ ...current, [groupIndex]: answerIndex }))
              }}
              size="sm"
              type="button"
              variant={selectedAnswers[groupIndex] === answerIndex ? "secondary" : "outline"}
            >
              {answer}
              {answerIndex === 0 ? <Badge variant="secondary">Suggested</Badge> : null}
            </Button>)}
          </div>
        </fieldset>)}
        {suggestions.length > 1 ? <div className="flex flex-wrap gap-2">
          <Button disabled={suggestionsDisabled || !selectedReply} onClick={() => void sendSuggestedAnswer(selectedReply)} size="sm" type="button">
            Send answers
          </Button>
          <Button disabled={suggestionsDisabled} onClick={() => void sendSuggestedAnswer(defaultReply)} size="sm" type="button" variant="outline">
            Use suggested defaults
          </Button>
        </div> : null}
      </section> : null}
      {quickReplies.length && !disabled ? <div aria-label="Suggested replies" className="flex flex-wrap gap-2">
        {quickReplies.map((reply) => <Button
          key={reply}
          onClick={() => applyQuickReply(reply)}
          size="sm"
          type="button"
          variant="outline"
        >
          {reply}
        </Button>)}
      </div> : null}
      {attachments.length ? <AttachmentGroup aria-label="Pending attachments">
        {attachments.map((attachment) => <Attachment key={attachment.clientId} size="sm" state={attachment.state}>
          <AttachmentMedia variant={attachment.kind === "image" && attachment.previewUrl ? "image" : "icon"}>
            {attachment.kind === "image" && attachment.previewUrl ? <img alt="" src={attachment.previewUrl} /> : <PlatformIcon icon={attachmentIcon(attachment.kind)} size="sm" />}
          </AttachmentMedia>
          <AttachmentContent><AttachmentTitle>{attachment.filename}</AttachmentTitle><AttachmentDescription>{attachment.state === "uploading" ? "Uploading…" : `${attachment.kind} · ${formatSize(attachment.sizeBytes)}`}</AttachmentDescription></AttachmentContent>
          <AttachmentActions>{attachment.state === "done" ? <AttachmentAction aria-label={`Remove ${attachment.filename}`} onClick={() => removeAttachment(attachment.clientId)} type="button"><PlatformIcon data-icon icon={X} /></AttachmentAction> : null}</AttachmentActions>
        </Attachment>)}
      </AttachmentGroup> : null}
      <Field data-disabled={busy || undefined}>
        <FieldLabel htmlFor="dev-model">Model for this turn</FieldLabel>
        <Select
          disabled={busy || models.length === 0}
          items={models.map((model) => ({
            label: `${model.label}${model.changeSize?.short ? ` — ${model.changeSize.short}` : ""}`,
            value: model.id,
          }))}
          onValueChange={selectModel}
          value={selectedModel}
        >
          <SelectTrigger id="dev-model" size="default"><SelectValue placeholder={modelError ? "Server default" : "Loading models…"} /></SelectTrigger>
          <SelectContent><SelectGroup>{models.map((model) => <SelectItem key={model.id} value={model.id}>{model.label}{model.changeSize?.short ? ` — ${model.changeSize.short}` : ""}</SelectItem>)}</SelectGroup></SelectContent>
        </Select>
        {models.length && !modelError ? <FieldDescription id="dev-model-guidance">{models.find((model) => model.id === selectedModel)?.changeSize?.long || "Choose the model for this Dev turn."}</FieldDescription> : null}
        {modelError ? <FieldDescription id="dev-model-guidance">{modelError} The server will use its default model for this turn.</FieldDescription> : null}
      </Field>
      <DevBudgetStatus />
      <Field data-disabled={busy || undefined}>
        <FieldLabel className="sr-only" htmlFor="dev-message">Message for Builder</FieldLabel>
        <InputGroup className="has-disabled:opacity-100" data-disabled={busy || undefined}>
          <InputGroupTextarea disabled={busy} id="dev-message" onChange={(event) => setMessage(event.target.value)} placeholder="Describe what to build or improve…" ref={messageInput} rows={3} value={message} />
          <InputGroupAddon align="block-end">
            <InputGroupButton aria-label="Attach files" disabled={busy} onClick={() => fileInput.current?.click()} size="icon-xs" title="Attach files"><PlatformIcon data-icon icon={Paperclip} /></InputGroupButton>
            <input aria-label="Attach files" className="sr-only" multiple onChange={(event) => { void addFiles(event.target.files); event.target.value = "" }} ref={fileInput} type="file" />
            <span className="text-xs text-foreground">Up to 4 files</span>
            {streaming ? (
              <InputGroupButton
                aria-label="Save message as a draft"
                disabled={busy || !message.trim()}
                onClick={saveCurrentMessageForLater}
                size="icon-xs"
                title={message.trim() ? "Save this message for later" : "Type something first"}
                type="button"
              >
                <PlatformIcon data-icon icon={Save} />
              </InputGroupButton>
            ) : null}
            <InputGroupButton aria-label="Send message" disabled={!canSend} size="icon-xs" title="Send message" type="submit" variant="default"><PlatformIcon data-icon icon={SendHorizontal} /></InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
        {error ? <FieldError>{error}</FieldError> : null}
      </Field>
    </FieldGroup>
  </form>
}
