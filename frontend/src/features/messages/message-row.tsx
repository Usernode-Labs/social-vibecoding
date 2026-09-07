import { useRef, useState, type ReactNode } from 'react';

import { BookmarkIcon, BookmarkSolidIcon } from '@/components/ui/icons';

import * as api from './api';
import { edit, react, setReply, toggleSaved } from './store';
import type { ConversationMessage } from './types';
import { fileSize, fullTime, MessageMarkdown, ObjectCard, UserAvatar } from './format';
import { useAutoGrow } from '../../lib/use-auto-grow';

const REACTIONS = ['👍', '❤️', '😂', '🎉', '😮', '😢', '🙏', '🔥'];
type ReportReason = 'harassment' | 'spam' | 'threats' | 'hate' | 'sexual_content' | 'other';

/**
 * The two transcript shapes (see the header note in ./index.tsx). `bubble`
 * is a direct conversation: no avatar and no name, the body in a bubble
 * whose side and surface say who is speaking, and the time under it.
 * `row` is a group: the named-row transcript the app chat draws — square
 * avatar, bold name, muted time, flat text.
 */
export type MessageShape = 'bubble' | 'row';

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

export function MessageRow({ message, conversationId, shape = 'row' }: { message: ConversationMessage; conversationId: number; shape?: MessageShape }) {
  const mine = Number(typeof window !== 'undefined' ? window.App?.user?.id : 0) === message.sender.id;
  const [picker, setPicker] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(message.content);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [reporting, setReporting] = useState(false);
  const [reportReason, setReportReason] = useState<ReportReason>('spam');
  const [reportDetail, setReportDetail] = useState('');
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

  async function report() {
    setBusy(true); setNotice('');
    try {
      await api.reportMessage(conversationId, message.id, reportReason, reportDetail.trim());
      setNotice('Report submitted.'); setReporting(false); setReportDetail('');
    }
    catch (err) { setNotice(err instanceof Error ? err.message : 'Couldn’t submit this report.'); }
    finally { setBusy(false); }
  }

  function startLongPress() {
    if (mine) return;
    longPress.current = window.setTimeout(() => setPicker(true), 520);
  }
  function cancelLongPress() {
    if (longPress.current) window.clearTimeout(longPress.current);
    longPress.current = null;
  }

  const time = new Date(message.createdAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

  // The quoted reply, the body and the inline editor: the part of the
  // message that goes INSIDE the bubble, or stands as the row's text.
  const body = (
    <>
      {message.reply ? <button type="button" className="messages-quote" onClick={() => document.getElementById(`messages-message-${message.reply?.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })}><span>@{message.reply.sender.username}</span><p>{message.reply.content || 'Attachment'}</p></button> : null}
      {editing ? (
        <div className="messages-edit"><textarea ref={editRef} value={editValue} onChange={(event) => setEditValue(event.target.value.slice(0, 8000))} rows={2} maxLength={8000} autoFocus onKeyDown={(event) => { if (event.key === 'Escape') setEditing(false); if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void saveEdit(); } }} /><div><button type="button" disabled={busy} onClick={() => void saveEdit()}>Save</button><button type="button" onClick={() => setEditing(false)}>Cancel</button></div></div>
      ) : message.content ? <MessageMarkdown content={message.content} /> : null}
    </>
  );

  // Everything a message carries besides its text: files, shared items,
  // reactions, the report form and the status line. Same in both shapes.
  const extras = (
    <>
      {message.attachments.length ? <div className="messages-attachments">{message.attachments.map((attachment) => <Attachment key={attachment.id} attachment={attachment} />)}</div> : null}
      {message.objects.length ? <div className="messages-object-list">{message.objects.map((object, index) => <ObjectCard key={`${object.type}-${index}`} object={object} />)}</div> : null}
      {message.reactions.length ? <div className="messages-reactions">{message.reactions.map((reaction) => <button type="button" key={reaction.emoji} aria-pressed={reaction.reacted} title={reaction.users?.join(', ')} onClick={() => void toggle(reaction.emoji)} className={reaction.reacted ? 'messages-reaction-mine' : ''}><span>{reaction.emoji}</span><span>{reaction.count}</span></button>)}</div> : null}
      {reporting ? <form className="messages-report" onSubmit={(event) => { event.preventDefault(); void report(); }}>
        <label><span>Reason</span><select value={reportReason} onChange={(event) => setReportReason(event.target.value as ReportReason)}>
          <option value="spam">Spam</option><option value="harassment">Harassment</option><option value="threats">Threats</option><option value="hate">Hate</option><option value="sexual_content">Sexual content</option><option value="other">Other</option>
        </select></label>
        <label><span>Details <span className="font-normal text-zinc-500 dark:text-zinc-400">(optional)</span></span><textarea value={reportDetail} onChange={(event) => setReportDetail(event.target.value.slice(0, 500))} rows={2} maxLength={500} /></label>
        <div><button type="submit" disabled={busy}>{busy ? 'Submitting…' : 'Submit report'}</button><button type="button" onClick={() => { setReporting(false); setReportDetail(''); }}>Cancel</button></div>
      </form> : null}
      {notice ? <p role="status" className={`mt-1 text-sm ${notice === 'Report submitted.' ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-700 dark:text-red-400'}`}>{notice}</p> : null}
    </>
  );

  // The per-message controls. Hover-revealed on a pointer, always laid out
  // on touch (app.css). In a bubble they sit beside the bubble; in a row, on
  // the row's trailing edge.
  const actions: ReactNode = !message.pending && !message.failed ? <div className="messages-message-actions">
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
    {!mine ? <button type="button" onClick={() => { setReporting((open) => !open); setNotice(''); }} title="Report" aria-label="Report">!</button> : null}
  </div> : null;

  const pickerNode = picker ? <div className="messages-reaction-picker" role="menu" aria-label="Choose a reaction">{REACTIONS.map((emoji) => <button key={emoji} type="button" role="menuitem" onClick={() => void toggle(emoji)}>{emoji}</button>)}</div> : null;

  const stateClasses = `${mine ? 'messages-message-self' : ''} ${message.saved ? 'messages-message-saved' : ''} ${message.pending ? 'messages-message-pending' : ''} ${message.failed ? 'messages-message-failed' : ''}`;
  const pointerProps = { onPointerDown: startLongPress, onPointerUp: cancelLongPress, onPointerCancel: cancelLongPress, onPointerMove: cancelLongPress };

  if (shape === 'bubble') {
    return (
      <article id={`messages-message-${message.id}`} data-message-id={message.id} className={`messages-message messages-message-bubble group ${stateClasses}`} {...pointerProps}>
        <div className="messages-bubble-wrap">
          {message.content || message.reply || editing ? <div className="messages-bubble">{body}</div> : null}
          {actions}
          {pickerNode}
        </div>
        {extras}
        <div className="messages-message-meta"><time title={fullTime(message.createdAt)}>{time}</time>{message.editedAt ? <span title={fullTime(message.editedAt)}> · edited</span> : null}{message.pending ? <span> · sending…</span> : null}{message.failed ? <span className="text-red-700 dark:text-red-400"> · not sent</span> : null}</div>
      </article>
    );
  }

  return (
    <article id={`messages-message-${message.id}`} data-message-id={message.id} className={`messages-message group ${stateClasses}`} {...pointerProps}>
      <UserAvatar user={message.sender} size="md" shape="square" />
      <div className="min-w-0 flex-1">
        <div className="messages-message-head"><span className={mine ? 'text-violet-700 dark:text-violet-300' : ''}>@{message.sender.username}</span><time title={fullTime(message.createdAt)}>{time}</time>{message.editedAt ? <span title={fullTime(message.editedAt)}>edited</span> : null}{message.pending ? <span>sending…</span> : null}{message.failed ? <span className="text-red-700 dark:text-red-400">not sent</span> : null}</div>
        {body}
        {extras}
      </div>
      {actions}
      {pickerNode}
    </article>
  );
}
