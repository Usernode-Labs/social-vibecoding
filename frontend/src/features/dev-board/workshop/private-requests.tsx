// PRIVATE REQUESTS (#5048), on the Workshop for platform admins only.
//
// A private request is kept in Homeroom and never becomes a GitHub issue
// (src/routes/private-requests.js), so it is not on the board, in a chat
// thread or in any feed: this section is where admins find, read, discuss
// and close one. Filing one is the "Private request" box in the Suggest an
// improvement dialog (features/dialogs/feedback-controller.js).
//
// Nothing renders for anyone else, and nothing renders on the first pass:
// whether the viewer is an admin is read in an effect, so the server render
// and the first client render agree. The routes answer 404 to a non-admin
// either way; hiding the section is the courtesy, not the wall.

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { GroupedList, ListRow, SectionHeader } from '@/components/ui/grouped-list';
import { LockIcon } from '@/components/ui/icons';
import { Textarea } from '@/components/ui/textarea';
import { useMessages } from '../../../lib/i18n/react';
import { agoStamp } from '../../../lib/timestamp';

interface PrivateRequest {
  id: number;
  title: string;
  description: string;
  status: 'open' | 'closed';
  createdBy: string | null;
  createdAt: string;
  commentCount: number;
}

interface PrivateComment {
  id: number;
  author: string | null;
  body: string;
  createdAt: string;
}

// The event the dialog sends when it files one, so the list catches up.
export const PRIVATE_REQUESTS_CHANGED = 'usernode:private-requests-changed';

function viewerIsAdmin(): boolean {
  const user = (window as unknown as { App?: { user?: { isAdmin?: boolean } | null } }).App?.user;
  return !!user?.isAdmin;
}

async function postJson(url: string, body?: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
}

// The "Private" marker every private request carries. Neutral, not the
// accent: it says what the request is, it does not ask anything.
export function PrivateBadge({ label }: { label: string }): ReactNode {
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-semibold text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200"
      data-private-badge=""
    >
      <LockIcon className="h-3.5 w-3.5" aria-hidden="true" />
      {label}
    </span>
  );
}

function RequestDetail({ slug, request, canWrite, onClosed }: {
  slug: string;
  request: PrivateRequest;
  canWrite: boolean;
  onClosed: () => void;
}): ReactNode {
  const t = useMessages('project');
  const [comments, setComments] = useState<PrivateComment[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionFailed, setActionFailed] = useState(false);
  const base = `/api/apps/${encodeURIComponent(slug)}/private-requests/${request.id}`;

  useEffect(() => {
    let live = true;
    fetch(base)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((data) => { if (live) setComments(Array.isArray(data.comments) ? data.comments : []); })
      .catch(() => { if (live) setLoadFailed(true); });
    return () => { live = false; };
  }, [base]);

  const send = async () => {
    const body = draft.trim();
    if (!body || busy) return;
    setBusy(true);
    setActionFailed(false);
    try {
      const res = await postJson(`${base}/comments`, { body });
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      setComments((list) => [...(list || []), data.comment]);
      setDraft('');
    } catch {
      setActionFailed(true);
    } finally {
      setBusy(false);
    }
  };

  const close = async () => {
    if (busy) return;
    setBusy(true);
    setActionFailed(false);
    try {
      const res = await postJson(`${base}/close`);
      if (!res.ok) throw new Error(String(res.status));
      onClosed();
    } catch {
      setActionFailed(true);
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3 px-4 pb-4" data-private-request-detail={request.id}>
      <p className="whitespace-pre-wrap break-words text-[0.9375rem] leading-6 text-zinc-800 dark:text-zinc-200">
        {request.description}
      </p>
      {loadFailed ? (
        <p className="text-[0.8125rem] text-red-600 dark:text-red-400">{t('project:workshop.private.loadFailed')}</p>
      ) : comments === null ? null : comments.length ? (
        <ul className="space-y-2">
          {comments.map((c) => {
            const when = agoStamp(c.createdAt);
            return (
              <li key={c.id} className="rounded-xl bg-zinc-100 px-3 py-2 dark:bg-zinc-800" data-private-comment="">
                <div className="text-[0.8125rem] text-zinc-500 dark:text-zinc-400">
                  <span className="font-semibold text-zinc-700 dark:text-zinc-200">
                    {c.author || t('project:workshop.private.someone')}
                  </span>
                  {' · '}
                  <time dateTime={c.createdAt} title={when.title}>{when.text}</time>
                </div>
                <p className="whitespace-pre-wrap break-words text-[0.9375rem] leading-6 text-zinc-800 dark:text-zinc-200">{c.body}</p>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-[0.8125rem] text-zinc-500 dark:text-zinc-400">{t('project:workshop.private.noComments')}</p>
      )}
      {canWrite ? (
        <div className="space-y-2">
          <Textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value.slice(0, 8000))}
            rows={2}
            maxLength={8000}
            placeholder={t('project:workshop.private.commentPlaceholder')}
            aria-label={t('project:workshop.private.commentPlaceholder')}
          />
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="default" size="sm" disabled={busy || !draft.trim()} onClick={send}>
              {t('project:workshop.private.comment')}
            </Button>
            <Button type="button" variant="neutral" ink="neutral" size="sm" disabled={busy} onClick={close} data-private-close="">
              {t('project:workshop.private.close')}
            </Button>
          </div>
        </div>
      ) : null}
      {actionFailed ? (
        <p className="text-[0.8125rem] text-red-600 dark:text-red-400" role="alert">{t('project:workshop.private.actionFailed')}</p>
      ) : null}
    </div>
  );
}

export function PrivateRequests({ slug }: { slug: string }): ReactNode {
  const t = useMessages('project');
  const [admin, setAdmin] = useState(false);
  const [requests, setRequests] = useState<PrivateRequest[]>([]);
  const [canWrite, setCanWrite] = useState(false);
  const [openId, setOpenId] = useState<number | null>(null);

  useEffect(() => { setAdmin(viewerIsAdmin()); }, []);

  const load = useCallback(() => {
    if (!slug || !viewerIsAdmin()) return () => {};
    let live = true;
    fetch(`/api/apps/${encodeURIComponent(slug)}/private-requests`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!live || !data) return;
        setRequests(Array.isArray(data.requests) ? data.requests : []);
        setCanWrite(!!data.canWrite);
      })
      .catch(() => { /* the section stays as it was */ });
    return () => { live = false; };
  }, [slug]);

  useEffect(() => {
    if (!admin) return undefined;
    let cancel = load();
    const onChanged = (event: Event) => {
      const changed = (event as CustomEvent<{ slug?: string | null }>).detail?.slug;
      if (changed && changed !== slug) return;
      cancel();
      cancel = load();
    };
    window.addEventListener(PRIVATE_REQUESTS_CHANGED, onChanged);
    return () => {
      cancel();
      window.removeEventListener(PRIVATE_REQUESTS_CHANGED, onChanged);
    };
  }, [admin, load, slug]);

  if (!admin || !requests.length) return null;

  return (
    <>
      <SectionHeader className="px-1.5 pb-0 pt-3.5" data-ws-part="private">{t('project:workshop.private.title')}</SectionHeader>
      <p className="px-1.5 text-[0.8125rem] text-zinc-500 dark:text-zinc-400">{t('project:workshop.private.note')}</p>
      <GroupedList className="mx-0" data-ws-private="">
        {requests.map((r) => {
          const open = openId === r.id;
          const when = agoStamp(r.createdAt);
          const by = r.createdBy || t('project:workshop.private.someone');
          return (
            <div key={r.id} data-private-request={r.id}>
              <ListRow
                as="button"
                aria-expanded={open}
                onClick={() => setOpenId(open ? null : r.id)}
                chevron={false}
                leading={(
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200">
                    <LockIcon className="h-5 w-5" aria-hidden="true" />
                  </span>
                )}
                title={r.title}
                subtitle={(
                  <>
                    {by}
                    {' · '}
                    <time dateTime={r.createdAt} title={when.title}>{when.text}</time>
                    {r.commentCount ? <>{' · '}{t('project:workshop.private.comments', { count: r.commentCount })}</> : null}
                  </>
                )}
                trailing={<PrivateBadge label={t('project:workshop.private.badge')} />}
              />
              {open ? (
                <RequestDetail
                  slug={slug}
                  request={r}
                  canWrite={canWrite}
                  onClosed={() => {
                    setOpenId(null);
                    setRequests((list) => list.filter((x) => x.id !== r.id));
                  }}
                />
              ) : null}
            </div>
          );
        })}
      </GroupedList>
    </>
  );
}
