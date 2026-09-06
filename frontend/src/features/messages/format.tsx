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

/**
 * A stable colour per name, so the same person or group is the same swatch
 * in every row without the server storing one. The same six swatches as the
 * app chat's `swatchFor` (../group-chat/transcript.tsx), kept in step by
 * hand, so a person reads as one voice across the two surfaces.
 *
 * FNV-1a with a final mix, not the app chat's `h * 31`. That one has two
 * faults this surface would show on every screen: past about eleven
 * characters the float product exceeds 2^53 and its low bits — the only
 * ones ToUint32 keeps — are all zero, and 31 ≡ 1 (mod 6), so before that
 * the pick is just the sum of the character codes mod 6. Both put "ada",
 * "Launch crew" and "Design review" in the same green.
 */
const SWATCHES = ['#5b7553', '#c0532f', '#6fb3a8', '#4a6fa5', '#8a5a83', '#b08344'];
export function swatchFor(name: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i += 1) h = Math.imul(h ^ name.charCodeAt(i), 0x01000193);
  h ^= h >>> 16; h = Math.imul(h, 0x45d9f3b); h ^= h >>> 16;
  return SWATCHES[(h >>> 0) % SWATCHES.length];
}

/**
 * Two shapes, the language's own split (see @/components/ui/feed.tsx):
 * `square` for a person speaking in a conversation — the list, the thread's
 * title row and the named rows of a group — and `circle` for a person in a
 * roster, which is what the dialogs show. A square wears the person's swatch
 * with white initials; a circle keeps the accent tint the dialogs had.
 */
export function UserAvatar({ user, title, size = 'md', shape = 'circle' }: {
  user?: ConversationUser | null;
  title?: string;
  size?: 'sm' | 'md' | 'lg';
  shape?: 'circle' | 'square';
}) {
  const label = title || user?.username || 'Conversation';
  const sizeClass = size === 'sm' ? 'w-7 h-7 text-[10px]' : size === 'lg' ? 'w-11 h-11 text-sm' : 'w-9 h-9 text-xs';
  const square = shape === 'square';
  const radius = square ? (size === 'sm' ? 'rounded-lg' : 'rounded-xl') : 'rounded-full';
  if (user?.avatarUrl) {
    return <img src={user.avatarUrl} alt="" className={`${sizeClass} ${radius} object-cover bg-zinc-100 dark:bg-zinc-800 shrink-0`} />;
  }
  if (square) {
    return (
      <span aria-hidden="true" className={`${sizeClass} ${radius} text-white font-bold flex items-center justify-center shrink-0`} style={{ backgroundColor: swatchFor(label) }}>
        {initials(label)}
      </span>
    );
  }
  return (
    <span aria-hidden="true" className={`${sizeClass} rounded-full bg-violet-100 dark:bg-violet-950 text-violet-700 dark:text-violet-300 font-semibold flex items-center justify-center shrink-0`}>
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
        <div className="min-w-0"><div className="text-base font-semibold">Unavailable</div><div className="text-sm text-zinc-500 dark:text-zinc-400">You can’t access this item.</div></div>
      </div>
    );
  }
  const body = (
    <>
      <span className="messages-object-icon">{object.type === 'app' ? '◆' : object.type === 'spec' ? '§' : '#'}</span>
      <div className="min-w-0 flex-1">
        <div className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400 font-semibold">{OBJECT_LABELS[object.type]}</div>
        <div className="text-base font-semibold text-zinc-900 dark:text-zinc-100 truncate">{object.title || 'Untitled'}</div>
        {!compact && (object.subtitle || object.state || object.author) ? (
          <div className="text-sm text-zinc-500 dark:text-zinc-400 truncate">
            {[object.subtitle, object.state, object.author ? `by ${object.author}` : null].filter(Boolean).join(' · ')}
          </div>
        ) : null}
      </div>
      {object.href ? <span aria-hidden="true" className="text-zinc-500 dark:text-zinc-400">›</span> : null}
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
