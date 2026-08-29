import { useMemo } from 'react';

import type { ConversationUser, SharedObjectCard } from './types';

export function initials(label: string): string {
  return label
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('') || '?';
}

export function relativeTime(value: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return '';
  const seconds = Math.max(0, Math.floor((Date.now() - time) / 1000));
  if (seconds < 60) return 'now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(time).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function fullTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
}

function fallbackMarkdown(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');
}

export function MessageMarkdown({ content }: { content: string }) {
  const html = useMemo(() => {
    if (typeof window !== 'undefined' && window.DevChat?.renderMarkdown) {
      return window.DevChat.renderMarkdown(content, { breaks: true });
    }
    return fallbackMarkdown(content);
  }, [content]);
  return <div className="messages-markdown gc-msg-content" dangerouslySetInnerHTML={{ __html: html }} />;
}

export function UserAvatar({ user, title, size = 'md' }: { user?: ConversationUser | null; title?: string; size?: 'sm' | 'md' | 'lg' }) {
  const label = title || user?.username || 'Conversation';
  const sizeClass = size === 'sm' ? 'w-7 h-7 text-[10px]' : size === 'lg' ? 'w-11 h-11 text-sm' : 'w-9 h-9 text-xs';
  if (user?.avatarUrl) {
    return <img src={user.avatarUrl} alt="" className={`${sizeClass} rounded-full object-cover bg-zinc-100 dark:bg-zinc-800 shrink-0`} />;
  }
  return (
    <span aria-hidden="true" className={`${sizeClass} rounded-full bg-zinc-200 dark:bg-zinc-700 text-zinc-700 dark:text-zinc-200 font-semibold flex items-center justify-center shrink-0`}>
      {initials(label)}
    </span>
  );
}

const OBJECT_LABELS: Record<SharedObjectCard['type'], string> = {
  app: 'App', issue: 'Issue', proposal: 'Code proposal', governance: 'Governance proposal', spec: 'Spec version',
};

export function ObjectCard({ object, compact = false }: { object: SharedObjectCard; compact?: boolean }) {
  if (!object.available) {
    return (
      <div className="messages-object-card messages-object-unavailable" aria-disabled="true">
        <span className="messages-object-icon">?</span>
        <div className="min-w-0"><div className="text-xs font-semibold">Unavailable</div><div className="text-[11px] text-zinc-500 dark:text-zinc-300">You can’t access this item.</div></div>
      </div>
    );
  }
  const body = (
    <>
      <span className="messages-object-icon">{object.type === 'app' ? '◆' : object.type === 'spec' ? '§' : '#'}</span>
      <div className="min-w-0 flex-1">
        <div className="text-xs uppercase tracking-wide text-azure-800 dark:text-azure-200 font-semibold">{OBJECT_LABELS[object.type]}</div>
        <div className="text-xs font-semibold text-zinc-800 dark:text-zinc-100 truncate">{object.title || 'Untitled'}</div>
        {!compact && (object.subtitle || object.state || object.author) ? (
          <div className="text-[11px] text-zinc-500 dark:text-zinc-300 truncate">
            {[object.subtitle, object.state, object.author ? `by ${object.author}` : null].filter(Boolean).join(' · ')}
          </div>
        ) : null}
      </div>
      {object.href ? <span aria-hidden="true" className="text-zinc-500 dark:text-zinc-300">›</span> : null}
    </>
  );
  return object.href ? (
    <a href={object.href} className="messages-object-card" target={object.href.startsWith('http') ? '_blank' : undefined} rel="noopener noreferrer">{body}</a>
  ) : <div className="messages-object-card">{body}</div>;
}

export function fileSize(bytes: number): string {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
