import { Bot, CircleAlert, File, FileArchive, FileText, ImageIcon, UserRound } from "lucide-react"

import { PlatformIcon } from "@/components/platform-icon"
import {
  Attachment,
  AttachmentContent,
  AttachmentDescription,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle,
  AttachmentTrigger,
} from "@/components/ui/attachment"
import { Bubble, BubbleContent } from "@/components/ui/bubble"
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker"
import { Message, MessageAvatar, MessageContent, MessageFooter, MessageHeader } from "@/components/ui/message"
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller"
import { devAttachmentUrl, type DevSessionMessage } from "@/lib/dev-chat-api"

export type ConversationMessage = Pick<DevSessionMessage, "id" | "role" | "content" | "created_at" | "metadata" | "model">

type DevConversationProps = {
  messages: ConversationMessage[]
  sessionId?: string
  streamState?: "idle" | "streaming" | "error"
}

type HistoricalAttachment = {
  id: string
  filename: string
  kind: string
  sizeBytes: number
}

function formatTime(iso: string) {
  const date = new Date(iso)
  return Number.isNaN(date.valueOf()) ? "" : new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date)
}

function formatSize(bytes: number) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} B`
}

function attachmentIcon(kind: string) {
  if (kind === "image") return ImageIcon
  if (kind === "text") return FileText
  if (kind === "zip") return FileArchive
  return File
}

function messageAttachments(message: ConversationMessage): HistoricalAttachment[] {
  const candidates = message.metadata?.attachments
  if (!Array.isArray(candidates)) return []
  return candidates.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object") return []
    const row = candidate as Record<string, unknown>
    if (typeof row.id !== "string" || !/^[a-f0-9]{32}$/.test(row.id)) return []
    const filename = typeof row.filename === "string" && row.filename.trim() ? row.filename.trim() : "file"
    const kind = typeof row.kind === "string" ? row.kind : "binary"
    const sizeBytes = typeof row.sizeBytes === "number" && Number.isFinite(row.sizeBytes) ? row.sizeBytes : 0
    return [{ id: row.id, filename, kind, sizeBytes }]
  })
}

function ConversationMessage({ message, sessionId }: { message: ConversationMessage; sessionId?: string }) {
  if (message.role === "system") {
    return <Marker variant="separator"><MarkerIcon><PlatformIcon icon={CircleAlert} /></MarkerIcon><MarkerContent>{message.content || "Session update"}</MarkerContent></Marker>
  }

  const isUser = message.role === "user"
  const attachments = sessionId ? messageAttachments(message) : []
  return <Message align={isUser ? "end" : "start"}>
    <MessageAvatar aria-hidden="true"><PlatformIcon icon={isUser ? UserRound : Bot} size="sm" /></MessageAvatar>
    <MessageContent>
      <MessageHeader>{isUser ? "You" : "Builder"}</MessageHeader>
      <Bubble align={isUser ? "end" : "start"} variant={isUser ? "default" : "secondary"}>
        <BubbleContent className="whitespace-pre-wrap">{message.content || "…"}</BubbleContent>
      </Bubble>
      {attachments.length ? <AttachmentGroup aria-label="Message attachments">
        {attachments.map((attachment) => {
          const url = devAttachmentUrl(sessionId || "", attachment.id)
          const image = attachment.kind === "image"
          return <Attachment key={attachment.id} size="sm">
            <AttachmentMedia variant={image ? "image" : "icon"}>
              {image ? <img alt="" loading="lazy" src={url} /> : <PlatformIcon icon={attachmentIcon(attachment.kind)} size="sm" />}
            </AttachmentMedia>
            <AttachmentContent>
              <AttachmentTitle>{attachment.filename}</AttachmentTitle>
              <AttachmentDescription>{attachment.kind} · {formatSize(attachment.sizeBytes)}</AttachmentDescription>
            </AttachmentContent>
            <AttachmentTrigger
              render={<a aria-label={`${image ? "Open" : "Download"} ${attachment.filename}`} download={image ? undefined : attachment.filename} href={url} rel="noopener" target="_blank" />}
            />
          </Attachment>
        })}
      </AttachmentGroup> : null}
      <MessageFooter>{[message.model, formatTime(message.created_at)].filter(Boolean).join(" · ")}</MessageFooter>
    </MessageContent>
  </Message>
}

/** Presentation only: the official scroller owns anchoring and follow state. */
export function DevConversation({ messages, sessionId, streamState = "idle" }: DevConversationProps) {
  return <MessageScrollerProvider><MessageScroller aria-label="Development session conversation" className="min-h-96" data-slot="dev-conversation">
    <MessageScrollerViewport><MessageScrollerContent className="gap-5 p-4 sm:p-6">
      {messages.map((message, index) => <MessageScrollerItem key={message.id} scrollAnchor={index === messages.length - 1}><ConversationMessage message={message} sessionId={sessionId} /></MessageScrollerItem>)}
      {streamState === "streaming" ? <MessageScrollerItem scrollAnchor><Marker><MarkerIcon><PlatformIcon icon={Bot} /></MarkerIcon><MarkerContent>Builder is responding…</MarkerContent></Marker></MessageScrollerItem> : null}
      {streamState === "error" ? <MessageScrollerItem scrollAnchor><Marker><MarkerIcon><PlatformIcon icon={CircleAlert} /></MarkerIcon><MarkerContent>Builder reported an error.</MarkerContent></Marker></MessageScrollerItem> : null}
    </MessageScrollerContent></MessageScrollerViewport>
    <MessageScrollerButton />
  </MessageScroller></MessageScrollerProvider>
}
