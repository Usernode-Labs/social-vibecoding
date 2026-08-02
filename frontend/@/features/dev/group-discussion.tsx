import { File as FileIcon, FileText, Image as ImageIcon, MessageCircle, MessagesSquare, Paperclip, Pencil, Reply, SendHorizontal, Vote, X } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"
import { useParams } from "react-router-dom"

import { PlatformIcon } from "@/components/platform-icon"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Attachment, AttachmentAction, AttachmentActions, AttachmentContent, AttachmentDescription, AttachmentGroup, AttachmentMedia, AttachmentTitle, AttachmentTrigger } from "@/components/ui/attachment"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { FieldError, FieldGroup } from "@/components/ui/field"
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from "@/components/ui/input-group"
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker"
import { Message, MessageAvatar, MessageContent, MessageFooter, MessageHeader } from "@/components/ui/message"
import { Bubble, BubbleContent, BubbleReactions } from "@/components/ui/bubble"
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller"
import { Skeleton } from "@/components/ui/skeleton"
import { Textarea } from "@/components/ui/textarea"
import { AppTopBar } from "@/features/apps/app-top-bar"
import { getApp, type AppDetail } from "@/lib/apps-api"
import { getCurrentUser } from "@/lib/auth-api"
import { subscribeNotificationEvents } from "@/lib/notification-events"
import { markChatMessageRead } from "@/lib/notifications-api"
import { appDevPath } from "@/lib/routes"
import { isProductionReadOnlyReview } from "@/lib/runtime-mode"
import { getGroupChat, groupChatAttachmentPath, subscribeGroupChat, uploadGroupChatAttachment, type GroupChatAttachment, type GroupChatConnectionState, type GroupChatMessage, type GroupChatReplyTarget } from "@/lib/group-chat-api"

const MAX_GROUP_MESSAGE_LENGTH = 8000
const GROUP_MESSAGE_TIME_FORMATTER = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })

function formatTime(iso: string) {
  const date = new Date(iso)
  return Number.isNaN(date.valueOf()) ? "" : GROUP_MESSAGE_TIME_FORMATTER.format(date)
}

function quoteLabel(message: GroupChatMessage) {
  const quote = message.metadata?.quote
  if (!quote) return null
  const source = quote.source === "pr" ? `PR #${quote.prNumber || ""}`.trim() : quote.author || "Discussion"
  return <blockquote className="rounded-lg border-s-2 bg-muted/40 px-3 py-2 text-xs text-muted-foreground"><span className="block font-medium text-foreground">↩ {source}</span>{quote.snippet ? <span className="mt-1 block line-clamp-2 whitespace-pre-wrap">{quote.snippet}</span> : null}</blockquote>
}

function collapseSnippet(value: string) {
  return value.replace(/\s+/g, " ").trim()
}

function replyTargetFor(message: GroupChatMessage): GroupChatReplyTarget | null {
  const refMsgId = Number(message.id)
  if (!Number.isInteger(refMsgId) || refMsgId <= 0) return null
  if (message.msg_type === "spec_share") {
    return {
      source: "spec",
      refMsgId,
      author: message.metadata?.specShare?.sharedBy?.username || message.username,
      snippet: collapseSnippet(message.metadata?.specShare?.title || message.content || "Shared spec"),
    }
  }
  if (message.msg_type !== "message") {
    return {
      source: "event",
      refMsgId,
      author: null,
      snippet: collapseSnippet(message.content || "Discussion update"),
    }
  }
  const firstAttachment = message.metadata?.attachments?.[0]
  return {
    source: "message",
    refMsgId,
    author: message.username,
    snippet: collapseSnippet(message.content || (firstAttachment ? `📎 ${firstAttachment.filename}` : "Message")),
  }
}

function AttachmentLink({ attachment, slug }: { attachment: GroupChatAttachment; slug: string }) {
  const href = groupChatAttachmentPath(slug, attachment.id)
  const isImage = attachment.kind === "image"
  return <Attachment size="sm">
    <AttachmentMedia variant="icon"><PlatformIcon icon={isImage ? ImageIcon : FileText} /></AttachmentMedia>
    <AttachmentContent><AttachmentTitle>{attachment.filename}</AttachmentTitle></AttachmentContent>
    <AttachmentTrigger render={<a aria-label={`Open attachment ${attachment.filename}`} download={attachment.filename} href={href} />} />
  </Attachment>
}

const QUICK_REACTIONS = ["👍", "❤️", "🎉", "👀"]

function Reactions({ message, onReact, writable }: { message: GroupChatMessage; onReact?: (messageId: number | string, emoji: string) => void; writable?: boolean }) {
  const reactions = message.reactions || []
  if (!reactions.length && !writable) return null
  return <div aria-label="Message reactions" className="flex flex-wrap items-center gap-1.5" role="group">
    {reactions.map((reaction) => writable && onReact
      ? <Button aria-label={`Toggle ${reaction.emoji} reaction`} key={reaction.emoji} onClick={() => onReact(message.id, reaction.emoji)} size="xs" title={reaction.users?.join(", ")} type="button" variant="secondary">{reaction.emoji} {reaction.count}</Button>
      : <Badge key={reaction.emoji} title={reaction.users?.join(", ")} variant="secondary">{reaction.emoji} {reaction.count}</Badge>)}
    {writable && onReact ? <div aria-label="Add a reaction" className="flex flex-wrap gap-1" role="group">{QUICK_REACTIONS.filter((emoji) => !reactions.some((reaction) => reaction.emoji === emoji)).map((emoji) => <Button aria-label={`React with ${emoji}`} key={emoji} onClick={() => onReact(message.id, emoji)} size="icon-xs" title={`React with ${emoji}`} type="button" variant="ghost">{emoji}</Button>)}</div> : null}
  </div>
}

function ReplyButton({ message, onReply }: { message: GroupChatMessage; onReply?: (target: GroupChatReplyTarget) => void }) {
  const target = replyTargetFor(message)
  if (!target || !onReply) return null
  const label = target.author ? `Reply to ${target.author}` : "Reply to discussion update"
  return (
    <Button aria-label={label} onClick={() => onReply(target)} size="xs" type="button" variant="ghost">
      <PlatformIcon data-icon="inline-start" icon={Reply} />
      Reply
    </Button>
  )
}

function SystemMessage({ message, onReact, onReply, writable }: { message: GroupChatMessage; onReact?: (messageId: number | string, emoji: string) => void; onReply?: (target: GroupChatReplyTarget) => void; writable?: boolean }) {
  const icon = message.msg_type === "vote" ? Vote : MessageCircle
  const label = message.msg_type === "spec_share"
    ? message.metadata?.specShare?.title || `Shared spec${message.metadata?.specShare?.version ? ` v${message.metadata.specShare.version}` : ""}`
    : message.content || "Discussion update"
  return <div className="space-y-2"><Marker variant="separator"><MarkerIcon><PlatformIcon icon={icon} /></MarkerIcon><MarkerContent>{label}</MarkerContent></Marker><Reactions message={message} onReact={onReact} writable={writable} />{writable ? <ReplyButton message={message} onReply={onReply} /> : null}</div>
}

function isSameUser(left: number | string | null | undefined, right: number | string | null | undefined) {
  return left != null && right != null && String(left) === String(right)
}

function OrdinaryDiscussionMessage({
  currentUserId,
  message,
  onEdit,
  onMarkRead,
  onReact,
  onReply,
  slug,
  writable,
}: {
  currentUserId?: number | string | null
  message: GroupChatMessage
  onEdit?: (messageId: number | string, content: string) => void
  onMarkRead?: (messageId: number | string) => void
  onReact?: (messageId: number | string, emoji: string) => void
  onReply?: (target: GroupChatReplyTarget) => void
  slug: string
  writable?: boolean
}) {
  const attachments = message.metadata?.attachments || []
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(message.content)
  const [editError, setEditError] = useState<string | null>(null)
  const canEdit = Boolean(writable && onEdit && isSameUser(currentUserId, message.user_id))

  function cancelEdit() {
    setDraft(message.content)
    setEditError(null)
    setEditing(false)
  }

  function submitEdit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const content = draft.trim()
    if (!canEdit || !content || content === message.content.trim()) return
    try {
      onEdit?.(message.id, content)
      setEditError(null)
      setEditing(false)
    } catch (cause) {
      setEditError(cause instanceof Error ? cause.message : "Unable to edit the discussion message.")
    }
  }

  return <Message align="start">
    <MessageAvatar aria-hidden="true"><PlatformIcon icon={MessageCircle} /></MessageAvatar>
    <MessageContent>
      <MessageHeader>{message.username || "Member"}</MessageHeader>
      {message.has_unread_notification ? <span className="sr-only">Unread mention, reply, or reaction</span> : null}
      <Bubble variant="outline">
        <BubbleContent className="flex flex-col gap-3">
          {quoteLabel(message)}
          {editing ? (
            <form aria-label={`Edit message by ${message.username || "Member"}`} className="space-y-2" onSubmit={submitEdit}>
              <Textarea
                aria-label="Edited message"
                autoFocus
                maxLength={MAX_GROUP_MESSAGE_LENGTH}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") cancelEdit()
                }}
                rows={3}
                value={draft}
              />
              <div className="flex flex-wrap items-center justify-end gap-2">
                <Button onClick={cancelEdit} size="sm" type="button" variant="ghost">Cancel</Button>
                <Button disabled={!draft.trim() || draft.trim() === message.content.trim()} size="sm" type="submit">Save changes</Button>
              </div>
              {editError ? <FieldError>{editError}</FieldError> : null}
            </form>
          ) : message.content ? <p className="whitespace-pre-wrap">{message.content}</p> : null}
          {attachments.length ? <AttachmentGroup aria-label="Message attachments">{attachments.map((attachment) => <AttachmentLink attachment={attachment} key={attachment.id} slug={slug} />)}</AttachmentGroup> : null}
        </BubbleContent>
        {message.reactions?.length || writable ? <BubbleReactions><Reactions message={message} onReact={onReact} writable={writable} /></BubbleReactions> : null}
      </Bubble>
      <MessageFooter className="flex flex-wrap items-center gap-2">
        <span>{formatTime(message.created_at)}{message.edited_at ? " · edited" : ""}</span>
        {writable && !editing ? <ReplyButton message={message} onReply={onReply} /> : null}
        {canEdit && !editing ? (
          <Button
            aria-label="Edit your message"
            onClick={() => {
              setDraft(message.content)
              setEditError(null)
              setEditing(true)
            }}
            size="xs"
            type="button"
            variant="ghost"
          >
            <PlatformIcon data-icon="inline-start" icon={Pencil} />
            Edit
          </Button>
        ) : null}
        {message.has_unread_notification && onMarkRead && !editing ? (
          <Button aria-label="Mark message notification as read" onClick={() => onMarkRead(message.id)} size="xs" type="button" variant="ghost">
            <span aria-hidden="true" className="size-2 rounded-full bg-primary" />
            Mark read
          </Button>
        ) : null}
      </MessageFooter>
    </MessageContent>
  </Message>
}

function DiscussionMessage({
  currentUserId,
  message,
  onEdit,
  onMarkRead,
  onReact,
  onReply,
  slug,
  writable,
}: {
  currentUserId?: number | string | null
  message: GroupChatMessage
  onEdit?: (messageId: number | string, content: string) => void
  onMarkRead?: (messageId: number | string) => void
  onReact?: (messageId: number | string, emoji: string) => void
  onReply?: (target: GroupChatReplyTarget) => void
  slug: string
  writable?: boolean
}) {
  if (message.msg_type !== "message") return <SystemMessage message={message} onReact={onReact} onReply={onReply} writable={writable} />
  return <OrdinaryDiscussionMessage currentUserId={currentUserId} message={message} onEdit={onEdit} onMarkRead={onMarkRead} onReact={onReact} onReply={onReply} slug={slug} writable={writable} />
}

/** Reusable transcript presentation; route ownership stays with GroupDiscussion. */
export function GroupDiscussionTranscript({ currentUserId, emptyDescription = "Start the conversation below.", messages, onEdit, onMarkRead, onReact, onReply, slug, writable = false }: { currentUserId?: number | string | null; emptyDescription?: string; messages: GroupChatMessage[]; onEdit?: (messageId: number | string, content: string) => void; onMarkRead?: (messageId: number | string) => void; onReact?: (messageId: number | string, emoji: string) => void; onReply?: (target: GroupChatReplyTarget) => void; slug: string; writable?: boolean }) {
  if (!messages.length) return <Empty><EmptyHeader><EmptyMedia variant="icon"><PlatformIcon icon={MessagesSquare} /></EmptyMedia><EmptyTitle>No discussion yet</EmptyTitle><EmptyDescription>{emptyDescription}</EmptyDescription></EmptyHeader></Empty>
  return <MessageScrollerProvider><MessageScroller aria-label="App discussion messages" className="min-h-80 max-h-[60dvh] rounded-xl border bg-card">
    <MessageScrollerViewport><MessageScrollerContent className="gap-5 p-4 pb-7 sm:p-6 sm:pb-8">
      {messages.map((message) => <MessageScrollerItem key={message.id}><DiscussionMessage currentUserId={currentUserId} message={message} onEdit={onEdit} onMarkRead={onMarkRead} onReact={onReact} onReply={onReply} slug={slug} writable={writable} /></MessageScrollerItem>)}
    </MessageScrollerContent></MessageScrollerViewport>
    <MessageScrollerButton />
  </MessageScroller></MessageScrollerProvider>
}

type PendingGroupChatAttachment = GroupChatAttachment & {
  clientId: string
  previewUrl?: string
  state: "uploading" | "done"
}

function formatAttachmentSize(bytes?: number | null) {
  const value = Number(bytes) || 0
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`
  if (value >= 1024) return `${Math.round(value / 1024)} KB`
  return `${value} B`
}

function pendingAttachmentIcon(kind: string) {
  if (kind === "image") return ImageIcon
  if (kind === "markdown" || kind === "html" || kind === "text") return FileText
  return FileIcon
}

function typingLabel(usernames: string[]) {
  if (!usernames.length) return ""
  if (usernames.length === 1) return `${usernames[0]} is typing…`
  if (usernames.length === 2) return `${usernames[0]} and ${usernames[1]} are typing…`
  return `${usernames[0]}, ${usernames[1]}, and ${usernames.length - 2} others are typing…`
}

export function GroupDiscussionComposer({ disabled, label = "Post a discussion message", onCancelReply, onSend, onTyping, placeholder = "Share an update with collaborators…", replyTarget, showWhenUnavailable = false, slug, typingUsers = [], writable }: {
  disabled: boolean
  label?: string
  onCancelReply?: () => void
  onSend: (content: string, attachmentIds: string[]) => void
  onTyping?: () => void
  placeholder?: string
  replyTarget?: GroupChatReplyTarget | null
  showWhenUnavailable?: boolean
  slug: string
  typingUsers?: string[]
  writable: boolean
}) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const previewUrls = useRef(new Set<string>())
  const [content, setContent] = useState("")
  const [attachments, setAttachments] = useState<PendingGroupChatAttachment[]>([])
  const [error, setError] = useState<string | null>(null)
  const uploading = attachments.some((attachment) => attachment.state === "uploading")
  const composerDisabled = disabled || !writable
  const canSend = !composerDisabled && !uploading && Boolean(content.trim() || attachments.some((attachment) => attachment.state === "done"))

  useEffect(() => () => {
    previewUrls.current.forEach((url) => URL.revokeObjectURL(url))
  }, [])

  async function addFiles(files: FileList | null) {
    if (!files || composerDisabled || uploading) return
    setError(null)
    const available = 4 - attachments.length
    if (available <= 0) {
      setError("Up to 4 files can be attached to a message.")
      return
    }
    const selected = Array.from(files).slice(0, available)
    if (files.length > available) setError("Up to 4 files can be attached to a message.")
    const pending = selected.map((file) => {
      const clientId = crypto.randomUUID()
      const previewUrl = file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined
      if (previewUrl) previewUrls.current.add(previewUrl)
      return {
        file,
        attachment: {
          id: "",
          clientId,
          kind: file.type.startsWith("image/") ? "image" : "binary",
          filename: file.name,
          contentType: file.type || "application/octet-stream",
          sizeBytes: file.size,
          previewUrl,
          state: "uploading" as const,
        },
      }
    })
    setAttachments((current) => [...current, ...pending.map(({ attachment }) => attachment)])
    const failures: string[] = []
    await Promise.all(pending.map(async ({ attachment, file }) => {
      try {
        const uploaded = await uploadGroupChatAttachment(slug, file)
        setAttachments((current) => current.map((item) => item.clientId === attachment.clientId
          ? { ...uploaded, clientId: item.clientId, previewUrl: item.previewUrl, state: "done" }
          : item))
      } catch (cause) {
        if (attachment.previewUrl) {
          URL.revokeObjectURL(attachment.previewUrl)
          previewUrls.current.delete(attachment.previewUrl)
        }
        setAttachments((current) => current.filter((item) => item.clientId !== attachment.clientId))
        failures.push(cause instanceof Error ? `${file.name}: ${cause.message}` : `${file.name}: upload failed`)
      }
    }))
    if (failures.length) setError(failures.join(" "))
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

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!canSend) return
    try {
      const sentAttachments = attachments.filter((attachment) => attachment.state === "done")
      onSend(content.trim(), sentAttachments.map((attachment) => attachment.id))
      sentAttachments.forEach((attachment) => {
        if (attachment.previewUrl) {
          URL.revokeObjectURL(attachment.previewUrl)
          previewUrls.current.delete(attachment.previewUrl)
        }
      })
      setContent("")
      setAttachments([])
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to send the discussion message.")
    }
  }

  if (!writable && !showWhenUnavailable) return null
  return <form aria-disabled={composerDisabled || undefined} aria-label={label} className="sticky bottom-0 rounded-xl border bg-background p-3 shadow-sm" onSubmit={submit}>
    <FieldGroup className="gap-2">
      {replyTarget ? (
        <div className="flex items-start gap-3 rounded-lg border-s-2 bg-muted/40 px-3 py-2" data-testid="discussion-reply-preview">
          <PlatformIcon className="mt-0.5 shrink-0" icon={Reply} size="sm" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">
              Replying to {replyTarget.author ? `@${replyTarget.author}` : "discussion update"}
            </p>
            <p className="line-clamp-2 text-sm text-muted-foreground sm:text-xs">{replyTarget.snippet}</p>
          </div>
          <Button aria-label="Cancel reply" onClick={onCancelReply} size="icon-xs" type="button" variant="ghost">
            <PlatformIcon data-icon icon={X} />
          </Button>
        </div>
      ) : null}
      {attachments.length ? (
        <AttachmentGroup aria-label="Pending discussion attachments">
          {attachments.map((attachment) => (
            <Attachment key={attachment.clientId} size="sm" state={attachment.state}>
              <AttachmentMedia variant={attachment.kind === "image" && attachment.previewUrl ? "image" : "icon"}>
                {attachment.kind === "image" && attachment.previewUrl
                  ? <img alt="" src={attachment.previewUrl} />
                  : <PlatformIcon icon={pendingAttachmentIcon(attachment.kind)} />}
              </AttachmentMedia>
              <AttachmentContent>
                <AttachmentTitle>{attachment.filename}</AttachmentTitle>
                <AttachmentDescription>{attachment.state === "uploading" ? "Uploading…" : `${attachment.kind} · ${formatAttachmentSize(attachment.sizeBytes)}`}</AttachmentDescription>
              </AttachmentContent>
              <AttachmentActions>
                {attachment.state === "done" ? (
                  <AttachmentAction aria-label={`Remove ${attachment.filename}`} onClick={() => removeAttachment(attachment.clientId)} type="button">
                    <PlatformIcon data-icon icon={X} />
                  </AttachmentAction>
                ) : null}
              </AttachmentActions>
            </Attachment>
          ))}
        </AttachmentGroup>
      ) : null}
      <p aria-live="polite" className="min-h-5 text-xs text-muted-foreground">{typingLabel(typingUsers)}</p>
      <InputGroup data-disabled={composerDisabled || uploading || undefined}>
        <InputGroupTextarea aria-describedby="discussion-composer-help" aria-label="Discussion message" disabled={composerDisabled || uploading} maxLength={MAX_GROUP_MESSAGE_LENGTH} onChange={(event) => { setContent(event.target.value); if (event.target.value.trim()) onTyping?.() }} placeholder={placeholder} rows={3} value={content} />
        <InputGroupAddon align="block-end">
          <InputGroupButton aria-label="Attach files" disabled={composerDisabled || uploading || attachments.length >= 4} onClick={() => fileInputRef.current?.click()} size="icon-xs" title="Attach files" type="button"><PlatformIcon data-icon icon={Paperclip} /></InputGroupButton>
          <input aria-label="Choose discussion attachments" className="sr-only" multiple onChange={(event) => { void addFiles(event.target.files); event.target.value = "" }} ref={fileInputRef} type="file" />
          <span className="text-xs text-muted-foreground" id="discussion-composer-help">{uploading ? "Uploading attachments…" : `${attachments.length}/4 files · ${content.length}/${MAX_GROUP_MESSAGE_LENGTH}`}</span>
          <InputGroupButton aria-label="Post discussion message" disabled={!canSend} size="icon-xs" title="Post discussion message" type="submit"><PlatformIcon data-icon icon={SendHorizontal} /></InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
      {error ? <FieldError>{error}</FieldError> : null}
    </FieldGroup>
  </form>
}

/**
 * General app discussion. React owns text, server-validated replies, author
 * edits, attachments, reactions, scoped typing and per-message unread
 * reconciliation through the established socket and notification contracts.
 */
export function GroupDiscussion() {
  const { slug = "" } = useParams()
  const [messages, setMessages] = useState<GroupChatMessage[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [app, setApp] = useState<AppDetail | null>(null)
  const [connectionState, setConnectionState] = useState<GroupChatConnectionState>("connecting")
  const [reactionError, setReactionError] = useState<string | null>(null)
  const [replyTarget, setReplyTarget] = useState<GroupChatReplyTarget | null>(null)
  const [currentUserId, setCurrentUserId] = useState<number | string | null>(null)
  const [typingUsers, setTypingUsers] = useState<string[]>([])
  const connectionRef = useRef<ReturnType<typeof subscribeGroupChat> | null>(null)

  const loadMessages = useCallback(async (signal?: AbortSignal) => {
    try {
      const { messages: response } = await getGroupChat(slug, signal)
      if (!signal?.aborted) {
        setMessages(response)
        setError(null)
      }
    } catch (cause) {
      if (signal?.aborted || (cause instanceof DOMException && cause.name === "AbortError")) return
      setError(cause instanceof Error ? cause.message : "Unable to load discussion")
    }
  }, [slug])

  useEffect(() => {
    const controller = new AbortController()
    void loadMessages(controller.signal)
    void getApp(slug, controller.signal).then(({ app: response }) => {
      if (!controller.signal.aborted) setApp(response)
    }).catch(() => {
      // Message history remains view-authorized even if the optional
      // capability snapshot is unavailable; leave the composer hidden.
      if (!controller.signal.aborted) setApp(null)
    })
    void getCurrentUser(controller.signal)
      .then((user) => {
        if (!controller.signal.aborted) setCurrentUserId(user.id ?? null)
      })
      .catch(() => {
        if (!controller.signal.aborted) setCurrentUserId(null)
      })
    return () => controller.abort()
  }, [loadMessages, slug])

  const writable = Boolean(app?.can_collaborate) && !isProductionReadOnlyReview
  useEffect(() => {
    if (!writable) {
      setConnectionState(isProductionReadOnlyReview ? "unavailable" : "connecting")
      return
    }
    const connection = subscribeGroupChat(slug, {
      onConnectionStateChange: setConnectionState,
      onMessagesChanged: () => { void loadMessages() },
      onTypingUsersChange: setTypingUsers,
    })
    connectionRef.current = connection
    return () => {
      connection.dispose()
      if (connectionRef.current === connection) connectionRef.current = null
    }
  }, [loadMessages, slug, writable])

  const reactToMessage = useCallback((messageId: number | string, emoji: string) => {
    if (!writable || isProductionReadOnlyReview) return
    try {
      connectionRef.current?.react(messageId, emoji)
      setReactionError(null)
    } catch (cause) {
      setReactionError(cause instanceof Error ? cause.message : "Unable to update the reaction.")
    }
  }, [writable])

  const editMessage = useCallback((messageId: number | string, content: string) => {
    if (!writable || isProductionReadOnlyReview || !connectionRef.current) {
      throw new Error("Discussion is reconnecting. Try again in a moment.")
    }
    connectionRef.current.edit(messageId, content)
  }, [writable])

  const markMessageRead = useCallback(async (messageId: number | string) => {
    const canonicalId = Number(messageId)
    if (!Number.isSafeInteger(canonicalId) || canonicalId <= 0 || isProductionReadOnlyReview) return
    setMessages((current) => current?.map((message) => String(message.id) === String(messageId)
      ? { ...message, has_unread_notification: false }
      : message) || current)
    try {
      await markChatMessageRead(canonicalId)
    } catch {
      void loadMessages()
    }
  }, [loadMessages])

  useEffect(() => subscribeNotificationEvents({
    onNotificationChange: () => { void loadMessages() },
  }), [loadMessages])

  return <div className="isolate flex w-full flex-1 flex-col gap-6 px-4 py-8 antialiased sm:px-6" data-testid="group-discussion">
    <AppTopBar app={app} backTo={appDevPath(slug)} fallbackTitle="Discussion" label="Discussion" mode="nested" />
    {isProductionReadOnlyReview ? <Alert><PlatformIcon icon={Paperclip} /><AlertTitle>Read-only</AlertTitle><AlertDescription>Posting and reactions are unavailable.</AlertDescription></Alert> : null}
    {!isProductionReadOnlyReview && app && !app.can_collaborate ? <Alert><PlatformIcon icon={Paperclip} /><AlertTitle>View-only discussion</AlertTitle><AlertDescription>You can read this app’s discussion, but collaboration access is required to post a message.</AlertDescription></Alert> : null}
    {writable && connectionState !== "connected" ? <Alert><PlatformIcon icon={Paperclip} /><AlertTitle>{connectionState === "unavailable" ? "Discussion unavailable" : connectionState === "reconnecting" ? "Reconnecting to discussion" : "Connecting to discussion"}</AlertTitle>{connectionState === "unavailable" ? <AlertDescription>Refresh the page to reconnect.</AlertDescription> : null}</Alert> : null}
    {reactionError ? <Alert variant="destructive"><AlertTitle>Reaction was not updated</AlertTitle><AlertDescription>{reactionError}</AlertDescription></Alert> : null}
    {error ? <Alert variant="destructive"><AlertTitle>Discussion unavailable</AlertTitle><AlertDescription>{error}</AlertDescription></Alert> : null}
    {messages === null && !error ? <div className="space-y-3"><Skeleton className="h-24 w-full" /><Skeleton className="h-24 w-full" /><Skeleton className="h-24 w-full" /></div> : null}
    {messages !== null ? <GroupDiscussionTranscript currentUserId={currentUserId} messages={messages} onEdit={editMessage} onMarkRead={isProductionReadOnlyReview ? undefined : (messageId) => { void markMessageRead(messageId) }} onReact={reactToMessage} onReply={setReplyTarget} slug={slug} writable={writable && connectionState === "connected"} /> : null}
    <GroupDiscussionComposer
      disabled={connectionState !== "connected" || isProductionReadOnlyReview}
      onCancelReply={() => setReplyTarget(null)}
      onSend={(content, attachmentIds) => {
        if (!connectionRef.current) throw new Error("Discussion is reconnecting. Try again in a moment.")
        connectionRef.current.send(content, replyTarget, attachmentIds)
        setReplyTarget(null)
        void loadMessages()
      }}
      onTyping={() => connectionRef.current?.typing()}
      replyTarget={replyTarget}
      slug={slug}
      typingUsers={typingUsers}
      writable={writable}
    />
  </div>
}
