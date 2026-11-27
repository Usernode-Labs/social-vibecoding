import { memo, useEffect, useRef, useState } from 'react';

import { useSearchMark } from '../ai/search-mark';
import { useMessages } from '../../lib/i18n/react';
import { openReport } from '../dialogs/report';
import {
  deleteMessage, discardFailed, edit, markUnread, messageAddress, openThread, react, retrySend, scopeKey, setReply,
  setUserBlocked, toggleSaved,
} from './store';
import type { ConversationKind, ConversationMessage, DiscussionMessage } from './types';
import { fileSize, fullTime, MessageMarkdown, ObjectCard, UserAvatar, senderName } from './format';
import { issueRefHref } from './channels';
import { isActivityMessage } from './bot-activity';
import { BotCardOrTrack, filedNextLine } from './bot-track';
import { BotQuestion, botMeta } from './bot-question';
import { BotPlanCard, BotTwoQuestions, isPlanMessage, isTwoQuestions } from './bot-plan';
import { BotThanksCard, isThanksMessage } from './bot-thanks-card';
import { BotReadyCard, isReadyMessage } from './bot-ready';
import { threadsAllowed } from './bot-shared';
import { BotHeadWords, botHead, draftPreviewOf, isHeadCard } from './bot-head-card';
import { DesignVersionCard, designArtifactOf, designVersionOf } from './design-card';
import { BotRichCard, botCardOf } from './bot-cards';
import { BotLookedLine } from './bot-looked';
import { BotHtmlReply, botReplyHtml } from './bot-html';
import { BotLiveCard, isLiveCardObject, liveWorkOf } from './bot-live-card';
import { LinkEmbeds } from './link-cards';
import { plainText } from './plain-text';
import { useAutoGrow } from '../../lib/use-auto-grow';
import { enterSends } from '../../lib/enter-sends';
import { messageStamp, timeOfDay } from '../../lib/timestamp';
import { useMessageControls } from '../message-actions/controls';
import { MessageReactions } from '../message-actions/reactions';
import { messageActions } from '../message-actions/rules';
import { ImageViewer, openInViewer } from '../image-viewer/image-viewer';
import { useCanSaveImage } from '../image-viewer/save-image';
import { ThreadSummaryChip } from '../message-actions/thread-summary';
import { TranslateNote, observeAutoTranslate, useTranslate, worthAsking } from './translate';
import { MessageRowView, barPlacement } from './message-row-view';

/*
 * A CONVERSATION HAS SIDES (#5680). A direct message and a group chat — the
 * two-or-more-people conversations, the bot's chat among them — draw each
 * message on its sender's side: yours on the right in the accent tint and
 * without your face, everyone else's on the left in the plain surface with
 * their avatar, name and time, each in a bubble. The side says who is
 * speaking, so the transcript is read rather than decoded.
 *
 * A CHANNEL KEEPS ITS NAMED ROWS (#2783). #general and every project and
 * topic channel is not a conversation between a few people but a room, so a
 * row there stays the flat named row — square avatar, bold name, muted time —
 * whoever said it. So do the bot's cards, plans, questions and step lines
 * wherever they land: they are not something a person said, and a bubble
 * would clip them.
 *
 * CONSECUTIVE MESSAGES GROUP. A message from the same person, close behind
 * their previous one (`groupsWithPrevious`, @/components/ui/chat.tsx — the app
 * chat uses the same rule), drops its avatar and name and becomes a
 * continuation line, with its time in the gutter where the avatar would be.
 *
 * THE CONTROLS ARE ONE BAR (#2387): ../message-actions/action-bar.tsx — the
 * three recent reactions, the picker, Reply, Save and ⋯ — on hover with a
 * pointer, and the same acts in a sheet on a long press on a phone. ⋯ holds
 * the rarer ones: the thread, edit, copy, the link, mark unread, delete,
 * report and block. Report message opens the shared reporting dialog
 * (../dialogs/report.tsx), which feeds the platform's one moderation queue
 * rather than an inline form of its own (issue #2721).
 */

/**
 * A picture in a conversation (#6862): above its bubble, on its own, at its
 * own shape — no filename or size under it, since the picture already says
 * what it is. The name stays in the alt and in the viewer.
 */
function ImageAttachment({ attachment }: { attachment: ConversationMessage['attachments'][number] }) {
  // #3286: a plain tap opens the picture in the app's own viewer, which has
  // a way out (../image-viewer/image-viewer.tsx).
  const [viewing, setViewing] = useState(false);
  const src = attachment.viewUrl || attachment.url;
  return (
    <>
      <a className="messages-message-image" href={attachment.url} target="_blank" rel="noopener noreferrer" data-image-open="" onClick={(event) => openInViewer(event, () => setViewing(true))}><img src={src} alt={attachment.name} loading="lazy" /></a>
      {viewing ? <ImageViewer src={src} alt={attachment.name} onClose={() => setViewing(false)} /> : null}
    </>
  );
}

/** A file that is not a picture: the card under the bubble, as it was. */
function Attachment({ attachment }: { attachment: ConversationMessage['attachments'][number] }) {
  const t = useMessages('messages');
  const html = attachment.contentType === 'text/html' || /\.html?$/i.test(attachment.name);
  return (
    <div className="messages-attachment">
      <span className="messages-file-icon" aria-hidden="true">{html ? '</>' : '↓'}</span>
      <div className="min-w-0 flex-1"><a className="font-medium truncate block" href={attachment.url} download>{attachment.name}</a><span>{fileSize(attachment.size)}</span></div>
      {html && attachment.viewUrl ? <a className="messages-attachment-view" href={attachment.viewUrl} target="_blank" rel="noopener noreferrer">{t('messages:row.attachmentPreview')}</a> : null}
    </div>
  );
}

/**
 * How long a send may be on its way before its row says "Sending…" (offline
 * test, 2 Nov 2026, finding 1). #2907 took the word away because it came and
 * went on every send and moved the transcript twice; a send that answers in
 * a second or two still shows nothing but the fade. One that does not, on a
 * slow or silent network, said nothing at all and looked sent, so past this
 * it says so, on the line where "Not sent" or "Will send when you're back
 * online" takes its place if it comes to that.
 */
export const SLOW_SEND_MS = 2000;

/** Whether a row still on its way (`pending`, drawn at `since`) has been out longer than SLOW_SEND_MS. */
function useSlowSend(pending: boolean, since: string): boolean {
  const started = Date.parse(since);
  const [slow, setSlow] = useState(() => pending && Date.now() - started >= SLOW_SEND_MS);
  useEffect(() => {
    if (!pending) { setSlow(false); return undefined; }
    const wait = Number.isFinite(started) ? SLOW_SEND_MS - (Date.now() - started) : SLOW_SEND_MS;
    if (wait <= 0) { setSlow(true); return undefined; }
    setSlow(false);
    const timer = window.setTimeout(() => setSlow(true), wait);
    return () => window.clearTimeout(timer);
  }, [pending, started]);
  return pending && slow;
}

/*
 * #5680: which rows have a side. A DM and a group do; a channel does not
 * (#2783), and neither does a row that is not something a person said: the
 * bot's cards and plans, its step lines and a platform notice. `head` is
 * the bot's line naming a request or a change, drawn as that thing's card
 * (./bot-head-card.tsx); `question`/`actions` is its card with taps on it
 * (./bot-question.tsx).
 *
 * #6863: every row of a private thread with the bot, alone in its tab's
 * column, is the named row a channel draws: the thread is drawn as a
 * public thread's one sheet (`flat`).
 * 18 Nov 2026: in the chat with Homeroom bot every message of the bot's is
 * the flat named row its answers are, a notice as much as a reply with
 * buttons: the same speaker no longer changes style message by message.
 * People's own messages keep their bubble.
 */
function rowSided({ message, kind, flat, botChat, step }: {
  message: ConversationMessage; kind: ConversationKind; flat: boolean; botChat: boolean; step: boolean;
}): boolean {
  const head = botHead(message.content, botMeta(message));
  const isCardMessage = isThanksMessage(message) || isActivityMessage(message) || isPlanMessage(message)
    || isTwoQuestions(message) || isReadyMessage(message) || !!head
    || (!!message.sender.bot && (message.metadata?.homeroomBot?.question || message.metadata?.homeroomBot?.actions?.length)
      && !isTwoQuestions(message) && !isReadyMessage(message));
  const botRow = botChat && !!message.sender.bot;
  return !flat && kind !== 'channel' && !step && !message.system && !isCardMessage && !botRow;
}

/*
 * MEMOIZED. The Messages store publishes one snapshot for everything, so any
 * publish — the inbox reloading, someone else's typing ping — re-rendered the
 * open transcript and every row in it. A row's inputs are its props: the
 * message objects keep their identity across publishes that do not touch the
 * transcript, and the channel set is shared (store.ts `handleSetFor`), so a
 * row whose message did not change skips the render.
 */
export const MessageRow = memo(function MessageRow({
  message,
  conversationId,
  grouped = false,
  channels,
  kind = 'group',
  inThread = false,
  threadOpen = false,
  focused = false,
  planCardId = null,
  hidePrompts = false,
  botChat = false,
  flat = false,
}: {
  message: ConversationMessage;
  conversationId: number;
  /** A continuation of the same person's previous message. */
  grouped?: boolean;
  /** The viewer's channel handles, so `#name` in the body links (#2783). */
  channels?: ReadonlySet<string>;
  /** The conversation's kind: a DM has no threads (#2387), but for the chat with Homeroom bot (`botChat`). */
  kind?: ConversationKind;
  /** Drawn inside a reply thread — no thread of its own, no "mark unread". */
  inThread?: boolean;
  /** The thread that hangs off this message is the one open beside it. */
  threadOpen?: boolean;
  /** The message a link pointed at — flashed once (#2387). */
  focused?: boolean;
  /** #4046: a plan's request's activity card, whose step the plan carries (./bot-plan.tsx planLayout). */
  planCardId?: number | null;
  /** #4046: a plan or a question offers its own answers, so questions to tap give way. */
  hidePrompts?: boolean;
  /**
   * The row is in the viewer's chat with Homeroom bot, the one direct chat
   * with threads (./bot-shared.ts threadsAllowed). Every conversation there
   * is a thread, so such a row is always drawn in one (`inThread`).
   */
  botChat?: boolean;
  /**
   * #6863: a private thread with Homeroom bot, alone in its tab's column,
   * reads as a public thread's rows do — every message is the flat named
   * row, its author's face and name beside it, never a bubble on a side.
   */
  flat?: boolean;
}) {
  const t = useMessages('messages');
  // #6738: the words a search result was opened by stay marked in this
  // message while it is read (../ai/search-mark.ts marks only the id it
  // was opened for, so the thread's other rows are untouched).
  const marks = useSearchMark(message.id);
  const mine = Number(typeof window !== 'undefined' ? window.App?.user?.id : 0) === message.sender.id;
  // #6081: someone else's words can be read in the reader's language. A
  // request's words are asked for only on a tap; a chat's ask for themselves
  // when they come into view (#6525). Only what a person wrote: the bot's
  // cards and the platform's notices are not translated.
  const canTranslate = !mine && !message.sender.bot && !message.system
    && !!message.content && !message.deleted && !message.moderated;
  // #6525: a message that is still on its way (or failed) is not translated
  // yet, and one with no words of its own — emoji, a link, a name — is not
  // worth a request. A signed-out reader of a public channel is not either.
  const autoTranslate = canTranslate
    && !message.pending && !message.queued && !message.failed
    && typeof window !== 'undefined' && !!window.App?.user && worthAsking(message.content);
  const translation = useTranslate(message.content ? [message.content] : [], {
    enabled: canTranslate,
    auto: autoTranslate,
  });
  const article = useRef<HTMLElement>(null);
  const { askAuto } = translation;
  // #6525: the first time the row is (nearly) on screen, ask for its words.
  useEffect(() => {
    const el = article.current;
    if (!el || !autoTranslate) return undefined;
    return observeAutoTranslate(el, askAuto);
  }, [autoTranslate, askAuto]);
  // #4655: in a direct message people are named bare ("ada", not "@ada") in
  // the Block and Report labels; group chats and channels keep the @ there.
  // The author line, a quote and the sheet's header name them bare in every
  // chat (audit C05/Y06).
  const bare = kind === 'direct';
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(message.content);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  // #1408: the edit box grows with the message being edited, same as the
  // composer it visually replaces.
  const editRef = useRef<HTMLTextAreaElement>(null);
  useAutoGrow(editRef, editValue);

  const slowSend = useSlowSend(!!message.pending, message.createdAt);
  // A quiet step line in a request's thread ("Reading it.", "Built. Testing it…").
  const step = !!message.sender.bot && message.metadata?.homeroomBot?.kind === 'step';
  const scope = scopeKey(conversationId, inThread ? message.threadRootId : null);
  // #4055: the message's pictures. In the app, whether its build can save
  // one is known only once asked; asking re-renders the row so the menu's
  // Download line can appear.
  const images = (message.attachments || []).filter((att) => att.contentType.startsWith('image/'));
  // #6862: pictures sit above the bubble; every other file keeps its card
  // under it, with its name and size as before.
  const fileAttachments = (message.attachments || []).filter((att) => !att.contentType.startsWith('image/'));
  useCanSaveImage(images[0]?.url || '');

  async function saveEdit() {
    const content = editValue.trim();
    if (!content || content === message.content) { setEditing(false); return; }
    setBusy(true); setNotice('');
    try { await edit(message.id, content); setEditing(false); }
    catch (err) { setNotice(err instanceof Error ? err.message : t('messages:row.error.edit')); }
    finally { setBusy(false); }
  }

  async function toggle(emoji: string) {
    setNotice('');
    try { await react(message.id, emoji); }
    catch (err) { setNotice(err instanceof Error ? err.message : t('messages:row.error.reaction')); }
  }

  async function save() {
    setNotice('');
    try { await toggleSaved(message.id); }
    catch (err) { setNotice(err instanceof Error ? err.message : t('messages:row.error.saved')); }
  }

  function startEdit() { setEditValue(message.content); setEditing(true); }

  // What the viewer can do with this message here: the one rule every chat
  // asks (../message-actions/rules.ts). Threads where the chat keeps them
  // (./bot-shared.ts threadsAllowed): a channel and a group; the chat with
  // Homeroom bot is direct, and every row of it is already in a thread.
  // A send still on its way is asked as delivered, so its bar keeps its
  // place, invisible and inert, until it lands (#2907).
  const senderId = message.sender.id;
  const allowed = messageActions({
    viewer: { signedIn: true, canWrite: true },
    author: { mine, known: !!senderId },
    place: inThread ? 'thread' : kind,
    message: {
      live: !message.deleted && !message.failed && !message.queued && (message.id > 0 || !!message.pending),
      said: true,
      hasText: !!message.content,
      threadable: threadsAllowed({ kind, homeroomBot: botChat }),
    },
  });
  const threadRoot = message.threadRootId || message.id;
  const sided = rowSided({ message, kind, flat, botChat, step });
  const placement = barPlacement({ sided, mine, grouped });
  const controls = useMessageControls({
    allowed,
    reacted: (emoji) => message.reactions.some((reaction) => reaction.emoji === emoji && reaction.reacted),
    acts: {
      react: (emoji) => { void toggle(emoji); },
      reply: () => setReply(scope, message),
      save: { saved: !!message.saved, toggle: () => { void save(); } },
      thread: { started: !!message.thread || threadRoot !== message.id, open: () => openThread(threadRoot) },
      edit: startEdit,
      text: message.content,
      translation: canTranslate ? translation : null,
      // #4055: its pictures onto the device, whoever sent them.
      pictures: images.map((att) => ({ src: att.url, name: att.name })),
      link: messageAddress(conversationId, message.id),
      markUnread: () => { setNotice(''); return markUnread(message.id); },
      remove: () => { setNotice(''); return deleteMessage(message.id); },
      report: () => openReport({ targetType: 'conversation_message', target: message.id, label: message.sender.unnamed ? (message.sender.id ? t('messages:row.reportLabelUnknownHandle') : t('messages:row.reportLabelUnknown')) : t('messages:row.reportLabel', { name: senderName(message.sender, { bare }) }), userId: message.sender.id }),
      block: senderId ? {
        who: message.sender.unnamed ? { unknown: 'handle' } : { name: senderName(message.sender, { bare }) },
        busy,
        run: async () => {
          setBusy(true); setNotice('');
          try { await setUserBlocked(senderId, true); } finally { setBusy(false); }
        },
      } : null,
      failed: (err, fallback) => setNotice(err instanceof Error ? err.message : fallback),
    },
    preview: { who: senderName(message.sender, { bare: true }), text: message.content },
    barClassName: `messages-message-actions ${placement === 'bubble' ? 'msgx-bar-on-bubble' : ''}`,
    hidden: !!message.pending,
    disabled: editing,
  });

  // The time of day for today's messages, prefixed with the date once it is
  // not today's (#1808). `fullTime` on the title never elides.
  const time = messageStamp(message.createdAt, { hour: 'numeric' }).text;
  // The gutter's clock on a continuation line: the time of day alone, since
  // the header above it already said which day.
  const shortTime = timeOfDay(message.createdAt);

  // The words, as markdown. A Homeroom bot message about a request names its
  // project, so its `#N` chips open that project's requests (#3770), and the
  // line naming what it is about is that thing's card (#4097,
  // ./bot-head-card.tsx), which is then not drawn again under the words.
  const head = botHead(message.content, botMeta(message));
  // 18 Nov 2026: a reply that started work draws its request as a live card
  // (./bot-live-card.tsx), in place of the request's plain card.
  const liveWork = liveWorkOf(message);
  const objects = message.objects.filter((object) => !(head && isHeadCard(head, object)) && !isLiveCardObject(liveWork, object));
  // #6151: a design filed as a request says what happens to it next, after
  // its line, in the reader's language (./bot-track.tsx filedNextLine).
  const filedNext = botMeta(message)?.kind === 'design_filed' ? filedNextLine(botMeta(message)?.filedNext) : null;
  // #6248: a request draft Homeroom bot offered to file, still waiting, has
  // its card open a read-only preview beside the chat (./request-draft-pane.tsx).
  const draft = botChat && kind === 'direct'
    ? draftPreviewOf(head, botMeta(message), message.threadRootId, message.conversationId || conversationId)
    : null;
  // Task 2020: a bot answer laid out is drawn in place of its words, which
  // stay its fallback (./bot-html.tsx).
  const richHtml = head ? null : botReplyHtml(message);
  const markdown = <MessageMarkdown content={message.content} channels={channels} appSlug={botMeta(message)?.appSlug} requestColors={!!botMeta(message)} marks={marks} />;
  const words = !message.content ? null : head
    ? <BotHeadWords head={head} objects={message.objects} channels={channels} draft={draft} marks={marks} />
    : richHtml ? <BotHtmlReply html={richHtml} fallback={markdown} /> : markdown;

  // The quoted reply, the body and the inline editor: the part of the
  // message that stands as the row's text. A deleted message says so in its
  // place and nothing else (#2387).
  const quote = <>{message.reply ? <button type="button" className="messages-quote" onClick={() => document.getElementById(`messages-message-${message.reply?.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })}><span>{senderName(message.reply.sender, { bare: true })}</span><p>{message.reply.deleted ? t('messages:row.quote.deleted') : plainText(message.reply.content) || t('messages:row.quote.attachment')}</p></button> : null}</>;
  const body = message.deleted ? (
    <p className="messages-deleted">{t('messages:row.deleted')}</p>
  ) : (
    <>
      {quote}
      {/* Homeroom bot parity, P1: what the reply looked at, above its words (./bot-looked.tsx). */}
      {!editing ? <BotLookedLine message={message} /> : null}
      {editing ? (
        <div className="messages-edit"><textarea ref={editRef} dir="auto" aria-label={t('messages:row.editLabel')} value={editValue} onChange={(event) => setEditValue(event.target.value.slice(0, 8000))} rows={2} maxLength={8000} autoFocus onKeyDown={(event) => { if (event.key === 'Escape') setEditing(false); else if (enterSends(event.nativeEvent)) { event.preventDefault(); void saveEdit(); } }} /><div><button type="button" disabled={busy} onClick={() => void saveEdit()}>{t('core:common.save')}</button><button type="button" onClick={() => setEditing(false)}>{t('core:common.cancel')}</button></div></div>
      ) : filedNext && words ? (
        // #6151: a design filed as a request: its line, then what happens next.
        <>
          {words}
          <p className="messages-markdown gc-msg-content" data-design-filed-next={botMeta(message)?.filedNext?.say}>{filedNext}</p>
        </>
      ) : isThanksMessage(message) ? (
        // #4392: the activity card Build it moved under a plan is the bot's
        // thanks: its words over the app's card and build line.
        <BotThanksCard message={message} words={words} />
      ) : isActivityMessage(message) ? (
        // #3736: the bot's activity card stands in place of its words, which
        // say the same for the inbox preview and the bell (./bot-activity.tsx).
        // #3770: a card with nothing on record keeps its words.
        // 16 Oct 2026: its request's track, where the viewer's bot work has
        // one (./bot-track.tsx).
        <>
          {/* B5: the bot's hello leads the first card it sends somebody. */}
          {message.metadata?.homeroomBot?.hello ? <p className="messages-bot-hello">{message.metadata.homeroomBot.hello}</p> : null}
          <BotCardOrTrack message={message} words={words} />
        </>
      ) : isPlanMessage(message) ? (
        // B6: a first version's plan, and two questions at once, stand in
        // place of their words too (./bot-plan.tsx).
        <BotPlanCard message={message} conversationId={conversationId} cardId={planCardId} />
      ) : isTwoQuestions(message) ? (
        <BotTwoQuestions message={message} conversationId={conversationId} />
      ) : isReadyMessage(message) ? (
        // B7: a change ready to try, with Try it, Approve and Change something.
        <BotReadyCard message={message} conversationId={conversationId} />
      ) : step && words ? (
        // One request, one story: a step line in its thread reads quietly.
        <div className="messages-bot-step text-[0.8125rem] leading-[1.125rem] text-zinc-500 dark:text-zinc-400" data-bot-step="">{words}</div>
      ) : words}
    </>
  );

  // #6081: a person's words read in another language on a tap. The quoted
  // reply stays above them, and the same markdown renderer draws the
  // translation, so the row reads as it did.
  const translatedBody = translation.state === 'shown' && !editing
    ? <>{quote}<MessageMarkdown content={translation.texts[0]} channels={channels} appSlug={botMeta(message)?.appSlug} requestColors={!!botMeta(message)} marks={marks} /></>
    : null;

  // Everything a message carries besides its text: files, shared items,
  // reactions, the thread under it and the status line.
  // 1 Nov 2026: a version of the thread's design, said by the bot, drawn
  // small under its words with Open preview (./design-card.tsx).
  const designVersion = inThread && message.threadRootId && !message.deleted ? designVersionOf(message) : null;
  // #6862: the pictures, on their own above the bubble. A message that is
  // only pictures has no words, so it gets no empty bubble under them.
  const imageList = images.length ? (
    <div className="messages-message-images">
      {images.map((attachment) => <ImageAttachment key={attachment.id} attachment={attachment} />)}
    </div>
  ) : null;
  const imagesOnly = images.length > 0 && !message.content && !message.reply && !editing && !message.deleted;

  const extras = (
    <>
      {designVersion && message.threadRootId ? (
        <DesignVersionCard conversationId={conversationId} rootId={message.threadRootId} version={designVersion} title={message.metadata?.homeroomBot?.designTitle || null} artifactId={designArtifactOf(message)} />
      ) : null}
      {/* Homeroom bot parity (P1-P9): a card the bot put under its reply
          (./bot-cards/). Phone review #30 (23 Nov 2026): it is part of the
          answer, which its words refer to ("the table compares…"), so it is
          drawn right under them, before the questions and buttons that
          close a reply, not after them. */}
      {botCardOf(message) ? <BotRichCard message={message} conversationId={conversationId} /> : null}
      {message.sender.bot && (message.metadata?.homeroomBot?.question || message.metadata?.homeroomBot?.actions?.length)
        && !isTwoQuestions(message) && !isReadyMessage(message)
        ? <BotQuestion message={message} conversationId={conversationId} hidePrompts={hidePrompts} /> : null}
      {/* 18 Nov 2026: the request the reply started work on, followed live. */}
      {liveWork ? <BotLiveCard work={liveWork} objects={message.objects} /> : null}
      {fileAttachments.length ? <div className="messages-attachments">{fileAttachments.map((attachment) => <Attachment key={attachment.id} attachment={attachment} />)}</div> : null}
      {objects.length ? <div className="messages-object-list">{objects.map((object, index) => <ObjectCard key={`${object.type}-${index}`} object={object} />)}</div> : null}
      {/* #3660: a link in the words to one of Homeroom's own pages, as the
          card it names — for this reader, and never one already above. */}
      {message.content && !message.moderated ? <LinkEmbeds text={message.content} exclude={message.objects} /> : null}
      <MessageReactions className="messages-reactions" reactions={message.reactions.map((reaction) => ({ emoji: reaction.emoji, count: reaction.count, mine: reaction.reacted, users: reaction.users }))} onToggle={controls.toggleReaction} />
      {message.thread && !inThread ? (
        <ThreadSummaryChip
          replyCount={message.thread.replyCount}
          lastReplyAt={message.thread.lastReplyAt}
          active={threadOpen}
          avatars={message.thread.participants.map((person) => <UserAvatar key={person.id} user={person} size="sm" shape="square" />)}
          lastReply={message.thread.lastReply ? {
            face: <span className="msgx-thread-face"><UserAvatar user={message.thread.lastReply.sender} size="sm" shape="square" /></span>,
            name: message.thread.lastReply.sender.username,
            ...(message.thread.lastReply.sender.unnamed ? { unnamed: 'unknown' as const } : {}),
            text: message.thread.lastReply.content,
          } : null}
          onOpen={() => openThread(message.id)}
        />
      ) : null}
      {notice ? <p role="status" className="mt-1 text-sm text-red-700 dark:text-red-400">{notice}</p> : null}
    </>
  );

  // The state word a header carries — edited. A continuation line has no
  // header, so it carries it on a meta line of its own, beside nothing: the
  // time is already in the gutter.
  //
  // NO "sending…" IN THE HEADER (#2907). A message in flight says so by
  // being faded (app.css), which changes no line's height; the word came and
  // went in a line of its own on a continuation row and moved the transcript
  // twice. Only a send still out after SLOW_SEND_MS says it, under the text
  // (sendNote below).
  const status = message.editedAt && !message.deleted ? <span title={fullTime(message.editedAt)}>{t('messages:row.edited')}</span> : null;

  // A send that failed says so under its text, with the two things to do
  // about it: send it again (the same idempotency key, so never twice) or
  // drop it. Its own line, not the header's: three more words beside the
  // name and time wrapped the header on a phone.
  const failedNote = message.failed ? <div className="messages-message-meta messages-message-failed-note" role="status">
    <span className="text-red-700 dark:text-red-400">{t('messages:row.notSent')}</span>
    {message.clientKey ? <button type="button" className="messages-retry" onClick={() => void retrySend(message.clientKey as string)}>{t('core:common.retry')}</button> : null}
    {message.clientKey ? <button type="button" className="messages-discard" onClick={() => discardFailed(message.clientKey as string)}>{t('messages:row.discard')}</button> : null}
  </div> : null;

  // Offline test, finding 1: the same line for a message not sent yet. One
  // written with no connection says it will go by itself, and can be dropped;
  // one on its way for longer than SLOW_SEND_MS says it is still sending.
  const sendNote = failedNote ? null : message.queued ? <div className="messages-message-meta messages-message-send-note" role="status">
    <span>{t('messages:row.queued')}</span>
    {message.clientKey ? <button type="button" className="messages-discard" onClick={() => discardFailed(message.clientKey as string)}>{t('messages:row.discard')}</button> : null}
  </div> : slowSend ? <div className="messages-message-meta messages-message-send-note" role="status">
    <span>{t('messages:row.sending')}</span>
  </div> : null;

  return (
    <MessageRowView
      rowRef={article}
      id={`messages-message-${message.id}`}
      attrs={{ 'data-message-id': message.id }}
      sided={sided}
      mine={mine}
      // #7163: your own message in a channel sits on the right like a chat,
      // its face at the trailing edge beside its words (app.css), the head
      // against that edge as it already was. A conversation's bubbles have
      // their own side (`.messages-message-bubble`), so this is the named row
      // alone.
      end={mine && !sided}
      grouped={grouped}
      state={{ saved: !!message.saved, pending: !!message.pending, failed: !!message.failed, deleted: !!message.deleted, focused, system: !!message.system }}
      avatar={<UserAvatar user={message.sender} size="md" shape="square" />}
      author={senderName(message.sender, { bare: true })}
      bot={!!message.sender.bot}
      at={message.createdAt}
      time={time}
      timeTitle={fullTime(message.createdAt)}
      gutter={shortTime}
      meta={status}
      continuedMeta={message.editedAt && !message.deleted ? status : null}
      pictures={imageList}
      body={imagesOnly ? null : translatedBody || body}
      rich={!!richHtml && !translatedBody && !editing}
      under={canTranslate ? <TranslateNote view={translation} className="mt-1" /> : null}
      extras={extras}
      notes={<>{failedNote}{sendNote}</>}
      bar={controls.bar}
      barInHead={placement === 'head'}
      sheet={controls.sheet}
      longPress={controls.longPress}
    />
  );
});

/*
 * #5219: A message from the request's public discussion, shown inside a
 * request's thread in the chat with Homeroom bot. The same row a reply draws
 * (avatar, name, time, text), with no reaction, reply or menu: taking part
 * happens on the request page, and the line under the name is the way there.
 */
export const DiscussionRow = memo(function DiscussionRow({
  message,
  appSlug,
  issueNumber,
}: {
  message: DiscussionMessage;
  appSlug: string;
  issueNumber: number;
}) {
  const t = useMessages('messages');
  const time = messageStamp(message.createdAt, { hour: 'numeric' }).text;
  return (
    <article id={`messages-discussion-${message.id}`} data-discussion-message-id={message.id} className="messages-message">
      <UserAvatar user={message.sender} size="md" shape="square" />
      <div className="min-w-0 flex-1">
        <div className="messages-message-head">
          <span dir="auto" className="messages-message-author">{senderName(message.sender, { bare: true })}</span>
          <time dateTime={message.createdAt} title={fullTime(message.createdAt)}>{time}</time>
        </div>
        <a
          className="block max-w-full truncate text-start text-[0.8125rem] font-medium text-zinc-500 hover:text-zinc-900 hover:underline dark:text-zinc-400 dark:hover:text-zinc-100"
          href={issueRefHref(appSlug, String(issueNumber))}
        >{t('messages:replies.discussion.from')}</a>
        {message.content ? <MessageMarkdown content={message.content} appSlug={appSlug} /> : null}
      </div>
    </article>
  );
});
