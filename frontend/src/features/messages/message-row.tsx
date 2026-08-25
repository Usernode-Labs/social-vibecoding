import { useRef, useState } from 'react';

import * as api from './api';
import { edit, react, setReply } from './store';
import type { ConversationMessage } from './types';
import { fileSize, fullTime, MessageMarkdown, ObjectCard, UserAvatar } from './format';
import { useAutoGrow } from '../../lib/use-auto-grow';

const REACTIONS = ['👍', '❤️', '😂', '🎉', '😮', '😢', '🙏', '🔥'];
type ReportReason = 'harassment' | 'spam' | 'threats' | 'hate' | 'sexual_content' | 'other';

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

export function MessageRow({ message, conversationId }: { message: ConversationMessage; conversationId: number }) {
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

  return (
    <article id={`messages-message-${message.id}`} data-message-id={message.id} className={`messages-message group ${mine ? 'messages-message-self' : ''} ${message.pending ? 'messages-message-pending' : ''} ${message.failed ? 'messages-message-failed' : ''}`} onPointerDown={startLongPress} onPointerUp={cancelLongPress} onPointerCancel={cancelLongPress} onPointerMove={cancelLongPress}>
      <UserAvatar user={message.sender} size="sm" />
      <div className="min-w-0 flex-1">
        <div className="messages-message-head"><span className={mine ? 'text-violet-700 dark:text-violet-300' : ''}>@{message.sender.username}</span><time title={fullTime(message.createdAt)}>{new Date(message.createdAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</time>{message.editedAt ? <span title={fullTime(message.editedAt)}>edited</span> : null}{message.pending ? <span>sending…</span> : null}{message.failed ? <span className="text-red-700 dark:text-red-400">not sent</span> : null}</div>
        {message.reply ? <button type="button" className="messages-quote" onClick={() => document.getElementById(`messages-message-${message.reply?.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })}><span>@{message.reply.sender.username}</span><p>{message.reply.content || 'Attachment'}</p></button> : null}
        {editing ? (
          <div className="messages-edit"><textarea ref={editRef} value={editValue} onChange={(event) => setEditValue(event.target.value.slice(0, 8000))} rows={2} maxLength={8000} autoFocus onKeyDown={(event) => { if (event.key === 'Escape') setEditing(false); if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void saveEdit(); } }} /><div><button type="button" disabled={busy} onClick={() => void saveEdit()}>Save</button><button type="button" onClick={() => setEditing(false)}>Cancel</button></div></div>
        ) : message.content ? <MessageMarkdown content={message.content} /> : null}
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
        {notice ? <p role="status" className={`mt-1 text-[11px] ${notice === 'Report submitted.' ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-700 dark:text-red-400'}`}>{notice}</p> : null}
      </div>
      {!message.pending && !message.failed ? <div className="messages-message-actions">
        <button type="button" onClick={() => setReply(conversationId, message)} title="Reply" aria-label="Reply">↩</button>
        <button type="button" onClick={() => setPicker((open) => !open)} title="React" aria-label="React">☺</button>
        {mine && message.content ? <button type="button" onClick={() => { setEditValue(message.content); setEditing(true); }} title="Edit" aria-label="Edit">✎</button> : null}
        {!mine ? <button type="button" onClick={() => { setReporting((open) => !open); setNotice(''); }} title="Report" aria-label="Report">!</button> : null}
      </div> : null}
      {picker ? <div className="messages-reaction-picker" role="menu" aria-label="Choose a reaction">{REACTIONS.map((emoji) => <button key={emoji} type="button" role="menuitem" onClick={() => void toggle(emoji)}>{emoji}</button>)}</div> : null}
    </article>
  );
}
