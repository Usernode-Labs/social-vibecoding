/**
 * #6071 follow-up: a new thread with Homeroom bot, from its "+" (the
 * Homeroom bot tab's header, and the bot chat's header in Messages).
 *
 * The "+" opens a BLANK thread where a thread pane goes. Nothing is saved
 * yet: the thread is made when the person sends their first message
 * (POST /api/conversations/homeroom-bot/new-thread, then the message as its
 * first reply), and a stray tap leaves nothing behind. Until then it shows a
 * welcome block, like RecipeBot's: the project the change is for (Any
 * project) and the kind of change (Any kind of change; Fix something
 * broken, Add something new, Design a screen), and a line saying a change
 * can be started here or just typed into the chat. The two picks ride with
 * the first message, so the bot knows what the thread is for.
 *
 * Design a screen is a message like the others (1 Nov 2026: the screen
 * picker retired): the block says to describe the screen, and Homeroom bot
 * draws it in the thread (services/design-bot.js write_screen).
 */

import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react';

import { ChatComposerBar } from '@/components/ui/chat';
import { Select } from '@/components/ui/select';
import { PaperClipIcon, PlusIcon, XIcon } from '@/components/ui/icons';
import { useComposerKeyboard } from '../../lib/composer-keyboard';
import { useMessages } from '../../lib/i18n/react';
import { useStoreState } from '../../lib/use-store-state';
import { communityScopeStore, warmCommunities } from '../workshop/community-scope';
import { DropOverlay, useFileDrag } from '../attachments/file-drag';
import { MAX_ATTACHMENTS, stageFiles } from '../attachments/limits';
import * as api from './api';
import { closeThread, openThread } from './store';
import { fileSize } from './format';
import type { MessageAttachment } from './types';
import { projectChoices } from './private-thread-bar';

export type ChangeKind = 'any' | 'fix' | 'add' | 'design';
export const CHANGE_KINDS: readonly ChangeKind[] = ['any', 'fix', 'add', 'design'];

// Which conversation a blank thread is open beside, or none.
let blankIn: number | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((fn) => fn());

/** Open a blank thread beside the bot chat `conversationId` (closing a thread open there). */
export function startNewThread(conversationId: number): void {
  if (!conversationId) return;
  closeThread();
  blankIn = conversationId;
  notify();
}

/** Close the blank thread. */
export function closeNewThread(): void {
  if (blankIn === null) return;
  blankIn = null;
  notify();
}

/** Whether a blank thread is open beside `conversationId`. */
export function useNewThread(conversationId: number | null | undefined): boolean {
  const open = useSyncExternalStore(
    (fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    () => blankIn,
    () => null,
  );
  return !!conversationId && open === conversationId;
}

/** A started thread's name in its head: the kind of change it is for, or New thread. */
export function startedThreadTitle(t: (id: string) => string, changeKind: string | null | undefined): string {
  if (changeKind === 'fix') return t('messages:newThread.kinds.fix');
  if (changeKind === 'add') return t('messages:newThread.kinds.add');
  if (changeKind === 'design') return t('messages:newThread.kinds.design');
  return t('messages:newThread.title');
}

const KEY_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';
function key(): string {
  let out = 'newthread-';
  for (let i = 0; i < 16; i += 1) out += KEY_CHARS[Math.floor(Math.random() * KEY_CHARS.length)];
  return out;
}

/** The "+" that opens a blank thread with Homeroom bot. */
export function NewThreadButton({ conversationId, className, onOpen }: {
  conversationId: number | null;
  className: string;
  /** Before the blank thread opens: to bring the chat it opens beside into view. */
  onOpen?: () => void;
}): ReactNode {
  const t = useMessages('messages');
  if (!conversationId) return null;
  return (
    <button
      type="button"
      className={className}
      aria-label={t('messages:newThread.start')}
      title={t('messages:newThread.start')}
      data-bot-new-thread=""
      onClick={() => { onOpen?.(); startNewThread(conversationId); }}
    >
      <PlusIcon aria-hidden="true" />
    </button>
  );
}

/** The blank thread itself, in a thread pane's place. */
export function NewThreadPanel({ conversationId }: { conversationId: number }): ReactNode {
  const t = useMessages('messages');
  const scope = useStoreState(communityScopeStore);
  const [project, setProject] = useState('');
  const [kind, setKind] = useState<ChangeKind>('any');
  const [words, setWords] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // #6256: files, the way every other thread takes them — dropped, pasted or
  // picked from the "+". They upload at once to the bot chat, before the
  // thread exists; the thread is still made only on the first send, and an
  // upload never sent is left to the orphan-attachment sweep.
  const [attachments, setAttachments] = useState<MessageAttachment[]>([]);
  const [uploading, setUploading] = useState(0);
  const [addOpen, setAddOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const addRef = useRef<HTMLDivElement>(null);
  // The kit's keyboard avoidance, as a thread's own scroller has it.
  const scroller = useRef<HTMLDivElement>(null);
  useComposerKeyboard(scroller);
  const projects = projectChoices(scope);

  /** Attach a drop's, a paste's or a pick's files: stage them against the cap, then upload each. */
  const addFiles = async (files: File[]) => {
    const { upload, refused } = stageFiles(files, attachments.length + uploading, t);
    setError(refused || null);
    for (const file of upload) {
      setUploading((count) => count + 1);
      try {
        const attachment = await api.uploadAttachment(conversationId, file);
        setAttachments((items) => [...items, attachment]);
      } catch (err) {
        setError(err instanceof Error && err.message ? err.message : t('messages:composer.uploadFailed', { file: file.name }));
      } finally {
        setUploading((count) => Math.max(0, count - 1));
      }
    }
  };

  // #4065: the same drop zone a reply thread has, in the same shared tracker.
  const drop = useFileDrag({ onFiles: (files) => { void addFiles(files); } });

  // The "+" menu closes the way every other transient panel in the shell
  // does: a press outside it, or Escape. Bound only while it is open.
  useEffect(() => {
    if (!addOpen) return undefined;
    const onDown = (event: MouseEvent) => {
      if (!addRef.current?.contains(event.target as Node)) setAddOpen(false);
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setAddOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [addOpen]);

  const send = async (event?: FormEvent) => {
    event?.preventDefault();
    const content = words.trim();
    if (busy || uploading || (!content && !attachments.length)) return;
    setBusy(true);
    setError(null);
    try {
      const made = await api.startBotThread({ project: project || null, kind });
      await api.sendMessage(conversationId, { content, threadRootId: made.rootId, attachmentIds: attachments.map((item) => item.id), idempotencyKey: key() });
      closeNewThread();
      openThread(made.rootId);
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : t('messages:newThread.failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="messages-reply-pane platform-kb-column dc-lift dc-lift-session" aria-label={t('messages:newThread.title')} data-bot-new-thread-pane="">
      <header className="messages-thread-header">
        <div className="min-w-0 flex-1">
          <div className="messages-thread-name">{t('messages:newThread.title')}</div>
          <div className="messages-thread-sub">{t('messages:newThread.sub')}</div>
        </div>
        <button type="button" className="messages-thread-action" aria-label={t('messages:newThread.close')} title={t('messages:newThread.close')} onClick={() => closeNewThread()}>
          <XIcon aria-hidden="true" />
        </button>
      </header>
      {/* A thread's foot, as every chat's (@/components/ui/chat, "A chat's
          foot"), with no typing line: nobody else is in a thread that does
          not exist yet. */}
      <div ref={scroller} className="messages-thread-scroll messages-reply-scroll platform-safe-scroll flex flex-col justify-end chat-transcript">
        <div className="mx-4 mb-4 flex flex-col gap-3 rounded-[20px] bg-white p-4 shadow-[inset_0_0_0_1px_var(--app-sheet-line)] dark:bg-zinc-900" data-bot-new-thread-start="">
          <label className="flex items-center gap-3 text-[13px] text-zinc-500 dark:text-zinc-400">
            <span className="w-24 shrink-0">{t('messages:newThread.project')}</span>
            <Select
              aria-label={t('messages:newThread.project')}
              value={project}
              onFocus={() => warmCommunities(0)}
              onChange={(e) => setProject(e.currentTarget.value)}
              data-bot-new-thread-project=""
            >
              <option value="">{t('messages:newThread.anyProject')}</option>
              {projects.map((p) => <option key={p.slug} value={p.slug}>{p.name}</option>)}
            </Select>
          </label>
          <label className="flex items-center gap-3 text-[13px] text-zinc-500 dark:text-zinc-400">
            <span className="w-24 shrink-0">{t('messages:newThread.kind')}</span>
            <Select
              aria-label={t('messages:newThread.kind')}
              value={kind}
              onChange={(e) => setKind(e.currentTarget.value as ChangeKind)}
              data-bot-new-thread-kind=""
            >
              <option value="any">{t('messages:newThread.kinds.any')}</option>
              <option value="fix">{t('messages:newThread.kinds.fix')}</option>
              <option value="add">{t('messages:newThread.kinds.add')}</option>
              <option value="design">{t('messages:newThread.kinds.design')}</option>
            </Select>
          </label>
          {kind === 'design' ? (
            <p className="text-[13px] text-zinc-600 dark:text-zinc-300" data-bot-new-thread-draws="">
              {t('messages:newThread.draws')}
            </p>
          ) : null}
          <p className="text-[12px] text-zinc-500 dark:text-zinc-400">{t('messages:newThread.hint')}</p>
        </div>
      </div>
      <ChatComposerBar as="form" className={`messages-composer messages-composer-thread${drop.dragging ? ' messages-composer-dragging' : ''}`} onSubmit={(e) => { void send(e); }} {...drop.handlers}>
        {error ? <p className="px-4 pb-1 text-[13px] text-red-600" role="alert">{error}</p> : null}
        {/* The files staged for the first message, as a reply thread draws
            them: name, size, and a × that takes it back off. */}
        {attachments.length || uploading ? (
          <div className="dc-attach-strip dc-attach-strip-active">
            {attachments.map((item) => (
              <div key={item.id} className="dc-attach-item">
                <div className="min-w-0">
                  <div className="dc-attach-name">{item.name}</div>
                  <div className="dc-attach-size">{fileSize(item.size)}</div>
                </div>
                <button type="button" className="dc-attach-remove" onClick={() => setAttachments((items) => items.filter((candidate) => candidate.id !== item.id))} aria-label={t('messages:composer.removeAttachment', { file: item.name })}>×</button>
              </div>
            ))}
            {uploading ? <span className="dc-attach-uploading">{t('messages:composer.uploading', { count: uploading })}</span> : null}
          </div>
        ) : null}
        <div className="messages-composer-card flex items-end gap-2">
          <input ref={fileRef} type="file" multiple className="hidden" onChange={(event) => { void addFiles([...(event.target.files || [])]); event.target.value = ''; }} />
          {/* The same "+" and menu a reply thread offers. The cap disables the
              Attach files ROW, never the "+" itself. */}
          <div className="messages-composer-add" ref={addRef}>
            <button type="button" className="messages-composer-action" onClick={() => setAddOpen((open) => !open)} aria-haspopup="menu" aria-expanded={addOpen} aria-label={t('messages:composer.addToMessage')} title={t('messages:composer.addToMessage')}><PlusIcon aria-hidden="true" /></button>
            {addOpen ? (
              <div className="messages-composer-menu" role="menu" aria-label={t('messages:composer.addToMessage')}>
                <button type="button" role="menuitem" disabled={attachments.length + uploading >= MAX_ATTACHMENTS} onClick={() => { setAddOpen(false); fileRef.current?.click(); }}>
                  <PaperClipIcon aria-hidden="true" />
                  <span>{t('messages:composer.attachFiles')}</span>
                </button>
              </div>
            ) : null}
          </div>
          <textarea
            className="messages-composer-input"
            value={words}
            rows={1}
            maxLength={8000}
            placeholder={t('messages:newThread.placeholder')}
            aria-label={t('messages:newThread.placeholder')}
            onChange={(e) => setWords(e.currentTarget.value)}
            onPaste={(e) => { const files = [...e.clipboardData.files]; if (files.length) { e.preventDefault(); void addFiles(files); } }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); }
            }}
          />
          <button type="submit" className="messages-composer-action" onMouseDown={(event) => event.preventDefault()} disabled={busy || uploading > 0 || (!words.trim() && !attachments.length)} aria-label={t('messages:newThread.send')} data-bot-new-thread-send="">
            <span className="text-[13px] font-semibold">{t('messages:newThread.send')}</span>
          </button>
        </div>
        {drop.dragging ? <DropOverlay className="messages-drop-overlay" /> : null}
      </ChatComposerBar>
    </aside>
  );
}
