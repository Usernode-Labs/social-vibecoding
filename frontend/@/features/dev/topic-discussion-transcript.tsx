import { MessageCircle, Paperclip } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"

import { PlatformIcon } from "@/components/platform-icon"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import {
  GroupDiscussionComposer,
  GroupDiscussionTranscript,
} from "@/features/dev/group-discussion"
import { getApp } from "@/lib/apps-api"
import { getCurrentUser } from "@/lib/auth-api"
import { subscribeNotificationEvents } from "@/lib/notification-events"
import { markChatMessageRead } from "@/lib/notifications-api"
import {
  getTopicDiscussion,
  subscribeGroupChat,
  type GroupChatConnectionState,
  type GroupChatMessage,
  type GroupChatReplyTarget,
  type GroupChatThread,
} from "@/lib/group-chat-api"
import { isProductionReadOnlyReview } from "@/lib/runtime-mode"

type TopicDiscussionContentProps = {
  canLoadEarlier?: boolean
  connectionState?: GroupChatConnectionState
  currentUserId?: number | string | null
  error?: string | null
  loadingEarlier?: boolean
  onCancelReply?: () => void
  messages: GroupChatMessage[] | null
  onEdit?: (messageId: number | string, content: string) => void
  onLoadEarlier?: () => void
  onMarkRead?: (messageId: number | string) => void
  onReact?: (messageId: number | string, emoji: string) => void
  onReply?: (target: GroupChatReplyTarget) => void
  onSend?: (content: string, attachmentIds: string[]) => void
  onTyping?: () => void
  productionReview?: boolean
  replyTarget?: GroupChatReplyTarget | null
  slug: string
  typingUsers?: string[]
  viewOnly?: boolean
  writable?: boolean
}

export function TopicDiscussionContent({
  canLoadEarlier = false,
  connectionState = "connected",
  currentUserId,
  error,
  loadingEarlier = false,
  messages,
  onCancelReply,
  onEdit,
  onLoadEarlier,
  onMarkRead,
  onReact,
  onReply,
  onSend,
  onTyping,
  productionReview = false,
  replyTarget,
  slug,
  typingUsers = [],
  viewOnly = false,
  writable = false,
}: TopicDiscussionContentProps) {
  const connected = connectionState === "connected"
  return (
    <Card data-testid="topic-discussion">
      <CardHeader>
        <div className="flex items-start gap-2">
          <PlatformIcon icon={MessageCircle} />
          <div>
            <CardTitle>Discussion</CardTitle>
            <CardDescription>
              Conversation scoped to this topic. Messages do not appear in the app’s general discussion.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {productionReview ? (
          <Alert>
            <PlatformIcon icon={Paperclip} />
            <AlertTitle>Read-only</AlertTitle>
            <AlertDescription>Posting and reactions are unavailable.</AlertDescription>
          </Alert>
        ) : null}
        {!productionReview && viewOnly ? (
          <Alert>
            <PlatformIcon icon={Paperclip} />
            <AlertTitle>View-only discussion</AlertTitle>
            <AlertDescription>Collaboration access is required to post or react in this topic.</AlertDescription>
          </Alert>
        ) : null}
        {writable && !connected ? (
          <Alert>
            <PlatformIcon icon={Paperclip} />
            <AlertTitle>{connectionState === "unavailable" ? "Discussion unavailable" : connectionState === "reconnecting" ? "Reconnecting to discussion" : "Connecting to discussion"}</AlertTitle>
            {connectionState === "unavailable" ? <AlertDescription>Refresh the page to reconnect.</AlertDescription> : null}
          </Alert>
        ) : null}
        {error ? (
          <Alert variant="destructive">
            <AlertTitle>Discussion unavailable</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        {messages === null && !error ? (
          <div className="flex flex-col gap-3" data-testid="topic-discussion-loading">
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : null}
        {messages !== null ? (
          <GroupDiscussionTranscript
            currentUserId={currentUserId}
            messages={messages}
            onEdit={onEdit}
            onMarkRead={onMarkRead}
            onReact={onReact}
            onReply={onReply}
            slug={slug}
            writable={writable && connected}
          />
        ) : null}
        {canLoadEarlier && onLoadEarlier ? (
          <Button
            className="self-start"
            disabled={loadingEarlier}
            onClick={onLoadEarlier}
            type="button"
            variant="outline"
          >
            {loadingEarlier ? "Loading…" : "Load earlier"}
          </Button>
        ) : null}
        <GroupDiscussionComposer
          disabled={!connected || productionReview}
          label="Post a topic discussion message"
          onCancelReply={onCancelReply}
          onSend={(content, attachmentIds) => onSend?.(content, attachmentIds)}
          onTyping={onTyping}
          placeholder="Reply in this topic…"
          replyTarget={replyTarget}
          slug={slug}
          typingUsers={typingUsers}
          writable={writable}
        />
      </CardContent>
    </Card>
  )
}

export function TopicDiscussionTranscript({
  slug,
  threadRef,
  threadType,
}: {
  slug: string
  threadRef: number
  threadType: GroupChatThread["type"]
}) {
  const [messages, setMessages] = useState<GroupChatMessage[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  const [canCollaborate, setCanCollaborate] = useState<boolean | null>(null)
  const [connectionState, setConnectionState] = useState<GroupChatConnectionState>("connecting")
  const [reactionError, setReactionError] = useState<string | null>(null)
  const [replyTarget, setReplyTarget] = useState<GroupChatReplyTarget | null>(null)
  const [currentUserId, setCurrentUserId] = useState<number | string | null>(null)
  const [typingUsers, setTypingUsers] = useState<string[]>([])
  const connectionRef = useRef<ReturnType<typeof subscribeGroupChat> | null>(null)
  const load = useCallback(async (before?: string | number, signal?: AbortSignal) => {
    if (before !== undefined) setLoadingEarlier(true)
    setError(null)
    try {
      const page = await getTopicDiscussion(slug, threadType, threadRef, before, signal)
      setMessages((current) => before !== undefined
        ? [...page.messages, ...(current || [])]
        : page.messages)
    } catch (cause) {
      if (signal?.aborted || (cause instanceof DOMException && cause.name === "AbortError")) return
      setError(cause instanceof Error ? cause.message : "Discussion unavailable")
    } finally {
      if (before !== undefined) setLoadingEarlier(false)
    }
  }, [slug, threadRef, threadType])

  useEffect(() => {
    const controller = new AbortController()
    setMessages(null)
    setError(null)
    setCanCollaborate(null)
    void load(undefined, controller.signal)
    void getApp(slug, controller.signal)
      .then(({ app }) => {
        if (!controller.signal.aborted) setCanCollaborate(Boolean(app.can_collaborate))
      })
      .catch(() => {
        if (!controller.signal.aborted) setCanCollaborate(false)
      })
    void getCurrentUser(controller.signal)
      .then((user) => {
        if (!controller.signal.aborted) setCurrentUserId(user.id ?? null)
      })
      .catch(() => {
        if (!controller.signal.aborted) setCurrentUserId(null)
      })
    return () => controller.abort()
  }, [load, slug])

  const writable = canCollaborate === true && !isProductionReadOnlyReview
  useEffect(() => {
    if (!writable) {
      setConnectionState(isProductionReadOnlyReview ? "unavailable" : "connecting")
      return
    }
    const connection = subscribeGroupChat(slug, {
      onConnectionStateChange: setConnectionState,
      onMessagesChanged: () => { void load() },
      onTypingUsersChange: setTypingUsers,
    }, { type: threadType, ref: threadRef })
    connectionRef.current = connection
    return () => {
      connection.dispose()
      if (connectionRef.current === connection) connectionRef.current = null
    }
  }, [load, slug, threadRef, threadType, writable])

  const reactToMessage = useCallback((messageId: number | string, emoji: string) => {
    if (!writable) return
    try {
      connectionRef.current?.react(messageId, emoji)
      setReactionError(null)
    } catch (cause) {
      setReactionError(cause instanceof Error ? cause.message : "Unable to update the reaction.")
    }
  }, [writable])

  const editMessage = useCallback((messageId: number | string, content: string) => {
    if (!writable || !connectionRef.current) {
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
      void load()
    }
  }, [load])

  useEffect(() => subscribeNotificationEvents({
    onNotificationChange: () => { void load() },
  }), [load])

  return (
    <div className="flex flex-col gap-3">
      {reactionError ? (
        <Alert variant="destructive">
          <AlertTitle>Reaction was not updated</AlertTitle>
          <AlertDescription>{reactionError}</AlertDescription>
        </Alert>
      ) : null}
      <TopicDiscussionContent
        canLoadEarlier={messages?.length === 50}
        connectionState={connectionState}
        currentUserId={currentUserId}
        error={error}
        loadingEarlier={loadingEarlier}
        messages={messages}
        onCancelReply={() => setReplyTarget(null)}
        onEdit={editMessage}
        onLoadEarlier={() => void load(messages?.[0]?.id)}
        onMarkRead={isProductionReadOnlyReview ? undefined : (messageId) => { void markMessageRead(messageId) }}
        onReact={reactToMessage}
        onReply={setReplyTarget}
        onSend={(content, attachmentIds) => {
          if (!connectionRef.current) throw new Error("Discussion is reconnecting. Try again in a moment.")
          connectionRef.current.send(content, replyTarget, attachmentIds)
          setReplyTarget(null)
          void load()
        }}
        onTyping={() => connectionRef.current?.typing()}
        productionReview={isProductionReadOnlyReview}
        replyTarget={replyTarget}
        slug={slug}
        typingUsers={typingUsers}
        viewOnly={canCollaborate === false}
        writable={writable}
      />
    </div>
  )
}
