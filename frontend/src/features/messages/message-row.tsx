import { useEffect, useRef, useState, type ReactNode } from 'react';

import { BookmarkIcon, BookmarkSolidIcon } from '@/components/ui/icons';

import * as api from './api';
import { discardFailed, edit, react, retrySend, setReply, setUserBlocked, toggleSaved } from './store';
import type { ConversationMessage } from './types';
import { fileSize, fullTime, MessageMarkdown, ObjectCard, UserAvatar } from './format';
import { useAutoGrow } from '../../lib/use-auto-grow';
import { messageStamp, timeOfDay } from '../../lib/timestamp';
import { ReportForm, submitReport } from '../reports/report-form';

const REACTIONS = ['👍', '❤️', '😂', '🎉', '😮', '😢', '🙏', '🔥'];

/*
 * ONE SHAPE, DISCORD'S (#2783). Every chat — a DM, a group, #general and an
 * app's channel — draws its messages as named rows: square avatar, bold name,
 * muted time, flat text. A DM used to be a bubble transcript, on the reading
 * that with two participants the side says who is speaking; it no longer is,
 * so a conversation reads the same whichever list it came from.
 *
 * CONSECUTIVE MESSAGES GROUP. A message from the same person, close behind
 * their previous one (`groupsWithPrevious`, @/components/ui/chat.tsx — the app
 * chat uses the same rule), drops its avatar and name and becomes a
 * continuation line, with its time in the gutter where the avatar would be.
 */

function Attachment({ attachment }: { attachment: ConversationMessage['attachments'][number] }) {
  const image = attachment.contentType.startsWith('image/');
  const html = attachment.contentType === 'text/html' || /\.html?$/i.test(attachment.name);
  return (
    <div className="messages-attachment">
      {image ? <a href={attachment.url} target="_blank" rel="noopener noreferrer"><img src={attachment.url} alt={attachment.name} loading="lazy" /></a> : <span className="messages-file-icon" aria-hidden="true">{html ? '</>' : '↓'}</span>}
      <div className="min-w-0 flex-1"><a className="font-medium truncate block" href={attachment.url} download>{attachment.name}</a><span>{fileSize(attachment.size)}</span></div>
      {html && attachment.viewUrl ? <a className="messages-attachment-view" href={attachment.viewUrl} target="_blank" rel="noopener noreferrer">Preview</a> : null}
    </div>
  );
}

export function MessageRow({ message, conversationId, grouped = false, channels }: {
  message: ConversationMessage;
  conversationId: number;
  /** A continuation of the same person's previous message. */
  grouped?: boolean;
  /** The viewer's channel handles, so `#name` in the body links (#2783). */
  channels?: ReadonlySet<string>;
}) {
  const mine = Number(typeof window !== 'undefined' ? window.App?.user?.id : 0) === message.sender.id;
  const [picker, setPicker] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(message.content);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [reporting, setReporting] = useState(false);
  const [userReporting, setUserReporting] = useState(false);
  const [more, setMore] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  const moreButton = useRef<HTMLButtonElement>(null);
  const longPress = useRef<number | null>(null);
  // #1408: the edit box grows with the message being edited, same as the
  // composer it visually replaces.
  const editRef = useRef<HTMLTextAreaElement>(null);
  useAutoGrow(editRef, editValue);

  async function saveEdit() {
    const content = editValue.trim();
    if (!content || content === message.content) { setEditing(false); return; }
    setBusy(true); setNotice('');
    try { await edit(message.id, content); setEditing(false); }
    catch (err) { setNotice(err instanceof Error ? err.message : 'Your edit wasn’t saved.'); }
    finally { setBusy(false); }
  }

  async function toggle(emoji: string) {
    setPicker(false); setNotice('');
    try { await react(message.id, emoji); }
    catch (err) { setNotice(err instanceof Error ? err.message : 'Couldn’t update the reaction.'); }
  }

  async function save() {
    setNotice('');
    try { await toggleSaved(message.id); }
    catch (err) { setNotice(err instanceof Error ? err.message : 'Couldn’t update your saved messages.'); }
  }

  async function blockSender() {
    if (mine || !message.sender.id
        || !window.confirm(`Block @${message.sender.username}? Their messages in shared chats and app discussions will be hidden, and they won’t be able to message you directly.`)) return;
    setBusy(true); setNotice('');
    try { await setUserBlocked(message.sender.id, true); }
    catch (err) { setNotice(err instanceof Error ? err.message : 'Couldn’t block this person.'); }
    finally { setBusy(false); }
  }

  // The ⋯ menu closes on a tap outside it or on Escape, like the composer's
  // add menu. The ⋯ itself is not outside: its own click toggles it shut.
  useEffect(() => {
    if (!more) return undefined;
    const onDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node;
      if (moreRef.current?.contains(target) || moreButton.current?.contains(target)) return;
      setMore(false);
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setMore(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [more]);

  function startLongPress() {
    if (mine) return;
    longPress.current = window.setTimeout(() => setPicker(true), 520);
  }
  function cancelLongPress() {
    if (longPress.current) window.clearTimeout(longPress.current);
    longPress.current = null;
  }

  // The time of day for today's messages, prefixed with the date once it is
  // not today's (#1808). `fullTime` on the title never elides.
  const time = messageStamp(message.createdAt, { hour: 'numeric' }).text;
  // The gutter's clock on a continuation line: the time of day alone, since
  // the header above it already said which day.
  const shortTime = timeOfDay(message.createdAt);

  // The quoted reply, the body and the inline editor: the part of the
  // message that goes INSIDE the bubble, or stands as the row's text.
  const body = (
    <>
      {message.reply ? <button type="button" className="messages-quote" onClick={() => document.getElementById(`messages-message-${message.reply?.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })}><span>@{message.reply.sender.username}</span><p>{message.reply.content || 'Attachment'}</p></button> : null}
      {editing ? (
        <div className="messages-edit"><textarea ref={editRef} value={editValue} onChange={(event) => setEditValue(event.target.value.slice(0, 8000))} rows={2} maxLength={8000} autoFocus onKeyDown={(event) => { if (event.key === 'Escape') setEditing(false); if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void saveEdit(); } }} /><div><button type="button" disabled={busy} onClick={() => void saveEdit()}>Save</button><button type="button" onClick={() => setEditing(false)}>Cancel</button></div></div>
      ) : message.content ? <MessageMarkdown content={message.content} channels={channels} /> : null}
    </>
  );

  // Everything a message carries besides its text: files, shared items,
  // reactions, the report form and the status line.
  const extras = (
    <>
      {message.attachments.length ? <div className="messages-attachments">{message.attachments.map((attachment) => <Attachment key={attachment.id} attachment={attachment} />)}</div> : null}
      {message.objects.length ? <div className="messages-object-list">{message.objects.map((object, index) => <ObjectCard key={`${object.type}-${index}`} object={object} />)}</div> : null}
      {message.reactions.length ? <div className="messages-reactions">{message.reactions.map((reaction) => <button type="button" key={reaction.emoji} aria-pressed={reaction.reacted} title={reaction.users?.join(', ')} onClick={() => void toggle(reaction.emoji)} className={reaction.reacted ? 'messages-reaction-mine' : ''}><span>{reaction.emoji}</span><span>{reaction.count}</span></button>)}</div> : null}
      {reporting ? <ReportForm kind="message" onCancel={() => setReporting(false)}
        onSubmit={(reason, detail) => api.reportMessage(conversationId, message.id, reason as Parameters<typeof api.reportMessage>[2], detail)} /> : null}
      {userReporting ? <ReportForm kind="user" onCancel={() => setUserReporting(false)}
        onSubmit={(reason, detail) => submitReport(`/api/users/${encodeURIComponent(message.sender.username)}/report`, reason, detail)} /> : null}
      {notice ? <p role="status" className="mt-1 text-sm text-red-700 dark:text-red-400">{notice}</p> : null}
    </>
  );

  // The per-message controls. Hover-revealed on a pointer, always laid out
  // on touch (app.css), on the row's trailing edge.
  //
  // WHILE A SEND IS IN FLIGHT the tray is still laid out, but invisible and
  // inert (#2907): on touch it is a line of its own under the message, and a
  // row that grew that line only once the server answered moved everything
  // under it. A failed row has no tray — its Retry is its control.
  const actions: ReactNode = !message.failed ? <div className={`messages-message-actions ${message.pending ? 'messages-message-actions-reserved' : ''}`} aria-hidden={message.pending || undefined} inert={message.pending || undefined}>
    <button type="button" onClick={() => setReply(conversationId, message)} title="Reply" aria-label="Reply">↩</button>
    <button type="button" onClick={() => setPicker((open) => !open)} title="React" aria-label="React">☺</button>
    {/* Save, the Messages half of the app-chat bookmark (#1280). It sits
        beside React rather than behind the ⋯ because it is the same rank
        of act as reacting — personal, one tap, instantly reversible — and
        it is available on your OWN messages too: saving is a private note
        to yourself about anything worth finding again, not a judgement on
        someone else's message.

        THE BOOKMARK, not a star. This drew ☆/★ — two text glyphs — while
        the app chat's identical control drew @/components/ui/icons.tsx's
        BookmarkIcon / BookmarkSolidIcon (see ../group-chat/transcript.tsx),
        and the saved list they BOTH feed is headed by the solid bookmark
        in ../notifications/notifications-list.tsx. One feature drawn as
        two different objects on the two surfaces that offer it. The
        glyph is now the same on both, and the state still lives in the
        SHAPE — solid when saved, outline when not, which survives being
        read at 13px and in a screenshot — with `aria-pressed` saying so
        for anyone who cannot see the difference. */}
    <button
      type="button"
      onClick={() => void save()}
      aria-pressed={!!message.saved}
      className={message.saved ? 'messages-action-saved' : undefined}
      title={message.saved ? 'Saved. Click to unsave' : 'Save to your notifications'}
      aria-label={message.saved ? 'Unsave message' : 'Save message'}
    >{message.saved ? <BookmarkSolidIcon /> : <BookmarkIcon strokeWidth="1.5" />}</button>
    {mine && message.content ? <button type="button" onClick={() => { setEditValue(message.content); setEditing(true); }} title="Edit" aria-label="Edit">✎</button> : null}
    {/* #2905: reporting and blocking are one ⋯ disc, not three. They are
        the rare acts on a row, and each disc they took was one more on the
        line every message carries on a phone. */}
    {!mine ? <button ref={moreButton} type="button" className="messages-action-more" onClick={() => setMore((open) => !open)} title="More" aria-label="More actions" aria-haspopup="menu" aria-expanded={more}>⋯</button> : null}
  </div> : null;

  const moreNode = more && !mine ? <div ref={moreRef} className="messages-more-menu" role="menu" aria-label="More actions">
    <button type="button" role="menuitem" onClick={() => { setMore(false); setReporting(true); setUserReporting(false); setNotice(''); }}>Report message</button>
    {message.sender.id ? <button type="button" role="menuitem" onClick={() => { setMore(false); setUserReporting(true); setReporting(false); }}>Report @{message.sender.username}</button> : null}
    {message.sender.id ? <button type="button" role="menuitem" className="messages-more-danger" disabled={busy} onClick={() => { setMore(false); void blockSender(); }}>Block @{message.sender.username}</button> : null}
  </div> : null;

  const pickerNode = picker ? <div className="messages-reaction-picker" role="menu" aria-label="Choose a reaction">{REACTIONS.map((emoji) => <button key={emoji} type="button" role="menuitem" onClick={() => void toggle(emoji)}>{emoji}</button>)}</div> : null;

  const stateClasses = `${mine ? 'messages-message-self' : ''} ${message.saved ? 'messages-message-saved' : ''} ${message.pending ? 'messages-message-pending' : ''} ${message.failed ? 'messages-message-failed' : ''}`;
  const pointerProps = { onPointerDown: startLongPress, onPointerUp: cancelLongPress, onPointerCancel: cancelLongPress, onPointerMove: cancelLongPress };

  // The state word a header carries — edited. A continuation line has no
  // header, so it carries it on a meta line of its own, beside nothing: the
  // time is already in the gutter.
  //
  // NO "sending…" (#2907). A message in flight says so by being faded
  // (app.css), which changes no line's height; the word came and went in a
  // line of its own on a continuation row and moved the transcript twice.
  const status = message.editedAt ? <span title={fullTime(message.editedAt)}>edited</span> : null;

  // A send that failed says so under its text, with the two things to do
  // about it: send it again (the same idempotency key, so never twice) or
  // drop it. Its own line, not the header's: three more words beside the
  // name and time wrapped the header on a phone.
  const failedNote = message.failed ? <div className="messages-message-meta messages-message-failed-note" role="status">
    <span className="text-red-700 dark:text-red-400">Not sent</span>
    {message.clientKey ? <button type="button" className="messages-retry" onClick={() => void retrySend(message.clientKey as string)}>Retry</button> : null}
    {message.clientKey ? <button type="button" className="messages-discard" onClick={() => discardFailed(message.clientKey as string)}>Discard</button> : null}
  </div> : null;

  return (
    <article id={`messages-message-${message.id}`} data-message-id={message.id} className={`messages-message group ${grouped ? 'messages-message-grouped' : ''} ${stateClasses}`} {...pointerProps}>
      {grouped
        ? <time className="messages-message-gutter" dateTime={message.createdAt} title={fullTime(message.createdAt)}>{shortTime}</time>
        : <UserAvatar user={message.sender} size="md" shape="square" />}
      <div className="min-w-0 flex-1">
        {grouped ? null : <div className="messages-message-head"><span className={mine ? 'text-violet-700 dark:text-violet-300' : ''}>@{message.sender.username}</span><time dateTime={message.createdAt} title={fullTime(message.createdAt)}>{time}</time>{status}</div>}
        {body}
        {extras}
        {grouped && message.editedAt ? <div className="messages-message-meta">{status}</div> : null}
        {failedNote}
      </div>
      {actions}
      {pickerNode}
      {moreNode}
    </article>
  );
}
