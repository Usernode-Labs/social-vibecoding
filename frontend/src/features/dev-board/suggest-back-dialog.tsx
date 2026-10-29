/**
 * "Suggest to <Original>": what a version's owner sees before some of their
 * version's own changes go to the app it was made from, its original, as a
 * suggestion there (docs/plans/versions.md; src/services/suggest-back.js
 * says what is sent). The code and the route keep "suggest-back"; nobody
 * reads those.
 *
 * Opened from the project's ⋯ (./actions-row.tsx DevPlusMenu, its
 * "Suggest to" row), and drawn the way that menu's other pop-up,
 * the Featured illustration editor, is: portalled to <body> and handed to
 * the kit as a modal (lib/kit-surface.ts adoptKitSurface). It is not one of
 * the static dialogs (features/dialogs/): it exists only while it is open.
 *
 * It reads GET /api/apps/:slug/suggest-back once it is open, never in a
 * render: the version's own changes (`changes: [{sha, title}]`, newest
 * last), each a tick box, all ticked, so the owner picks which to send
 * ("Send 2 changes", POST `picks: [sha]`); from a server that predates the
 * pick list, the commit subjects (or how many files changed) as a plain
 * list, all sent. And whether Send can go ahead. The refusals it can meet
 * are the server's own sentences. A non-member of the original is asked to
 * Join by the fetch wrapper when Send is pressed (lib/join-required.ts),
 * which then sends again.
 *
 * It promises nothing about how the changes are worded there: the version's
 * name and words stay its own (its words.json and its dapp.json's own lines
 * never travel), which is what the note under the list says.
 */

import { useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';

import { RichMessage, useMessages } from '../../lib/i18n/react';
import { t as translate } from '../../lib/i18n/runtime';
import { adoptKitSurface, type KitAdoption } from '../../lib/kit-surface';
import { useIsomorphicLayoutEffect } from '../../lib/legacy-dom';

/** GET /api/apps/:slug/suggest-back (services/suggest-back.js preview). */
export interface SuggestBackPreview {
  copy: { slug: string; name: string };
  original: { slug: string; name: string } | null;
  ready: boolean;
  reason: { code: string; error: string } | null;
  commits: string[];
  commitCount: number;
  fileCount: number;
  open: { sessionId: number; href: string } | null;
  /** The version's own changes, newest last, to pick from (docs/plans/versions.md). Absent from an older server. */
  changes?: Array<{ sha: string; title: string }>;
}

/**
 * The original a version was made from, as the open app's payload links it:
 * `upstream_link` (GET /api/apps/:slug, `{ slug, name, following, linkable }`,
 * docs/plans/versions.md), or, from a server that predates versions, the
 * resolved `forked_from` (`{ slug, name, linkable }`, which says nothing of
 * updates). Null for an app that is not a version, and for one whose
 * original is gone. Pure.
 */
export function versionOfApp(app: any): { slug: string; name: string; following: boolean } | null {
  if (!app || app.self_hosted) return null;
  const link = app.upstream_link && typeof app.upstream_link === 'object' ? app.upstream_link : null;
  const ref = link || (app.forked_from && typeof app.forked_from === 'object' ? app.forked_from : null);
  if (!ref || !ref.linkable || typeof ref.slug !== 'string' || !ref.slug) return null;
  return {
    slug: ref.slug,
    name: typeof ref.name === 'string' && ref.name ? ref.name : ref.slug,
    following: !!(link && link.following),
  };
}

/**
 * Who the ⋯ offers "Suggest to <original>" to: the version's owner, on a
 * version whose original still exists (versionOfApp). `app` is the open
 * app's payload (AppView.appData); `viewerId` the signed-in user's id.
 * Versions made before the lineage commits were recorded still get the row:
 * the dialog then says plainly why it cannot send. Pure.
 */
export function suggestBackTarget(
  app: any,
  viewerId: number | null | undefined,
): { slug: string; name: string } | null {
  if (!app || app.self_hosted || viewerId == null) return null;
  if (app.created_by == null || app.created_by !== viewerId) return null;
  const version = versionOfApp(app);
  return version ? { slug: version.slug, name: version.name } : null;
}

/** The version's own changes to pick from, in the order the server gives them (newest last). Pure. */
export function pickableChanges(view: Pick<SuggestBackPreview, 'changes'> | null): Array<{ sha: string; title: string }> {
  if (!view || !Array.isArray(view.changes)) return [];
  return view.changes.filter((c) => c && typeof c.sha === 'string' && c.sha && typeof c.title === 'string');
}

/**
 * The box's lines: the commit subjects (newest last) and "and N more", or a
 * file count when there are no subjects to show. Pure, for
 * tests/suggest-back.test.js.
 */
export function changeLines(view: Pick<SuggestBackPreview, 'commits' | 'commitCount' | 'fileCount'> | null): string[] {
  if (!view) return [];
  const listed = Array.isArray(view.commits) ? view.commits.filter(Boolean) : [];
  if (listed.length) {
    const more = Math.max(0, (view.commitCount || 0) - listed.length);
    return more ? [...listed, translate('project:suggestBack.changes.more', { count: more })] : listed;
  }
  if (view.fileCount > 0) return [translate('project:suggestBack.changes.files', { count: view.fileCount })];
  return [];
}

const LINK = 'text-violet-700 dark:text-violet-400 underline';
const PICK_ROW = 'suggest-pick-row';

export function SuggestBackDialog({ slug, copyName, original, onClose }: {
  slug: string;
  copyName: string;
  original: { slug: string; name: string };
  onClose: () => void;
}) {
  const t = useMessages('project');
  const root = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  useIsomorphicLayoutEffect(() => { close.current = onClose; }, [onClose]);

  const [view, setView] = useState<SuggestBackPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState<{ href: string } | null>(null);
  // The shas left unticked; every change starts ticked.
  const [unpicked, setUnpicked] = useState<ReadonlySet<string>>(() => new Set());
  const endpoint = `/api/apps/${encodeURIComponent(slug)}/suggest-back`;
  const name = view?.original?.name || original.name;

  useEffect(() => {
    const controller = new AbortController();
    fetch(endpoint, { signal: controller.signal })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (controller.signal.aborted) return;
        if (!res.ok) throw new Error(data.error || t('project:suggestBack.error.loadRetry'));
        setView(data as SuggestBackPreview);
        setLoading(false);
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : t('project:suggestBack.error.load'));
        setLoading(false);
      });
    return () => controller.abort();
  }, [endpoint]);

  useIsomorphicLayoutEffect(() => {
    if (!root.current || !card.current) return undefined;
    let adoption: KitAdoption | null = adoptKitSurface({
      kind: 'modal', contentEl: card.current, adoptedOn: root.current, home: 'placeholder', gate: 'kit',
      onDismiss: () => { adoption = null; close.current(); },
    });
    return () => { if (adoption) adoption.release(); };
  }, []);

  async function send() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      // With a pick list, exactly the ticked changes; without one (an older
      // server), no `picks`, which sends them all.
      const body = picks ? { picks: picks.filter((c) => !unpicked.has(c.sha)).map((c) => c.sha) } : {};
      const res = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || t('project:suggestBack.error.notSent'));
        if (data.open?.href) setView((v) => (v ? { ...v, open: data.open, ready: false } : v));
        return;
      }
      setSent({ href: data.href });
    } catch {
      setError(t('project:suggestBack.error.network'));
    } finally {
      setBusy(false);
    }
  }

  const lines = changeLines(view);
  const listed = pickableChanges(view);
  const picks = listed.length ? listed : null;
  const picked = picks ? picks.filter((c) => !unpicked.has(c.sha)).length : 0;
  const reason = view && !view.ready ? view.reason : null;
  // join_required is not a reason to hold Send back: pressing it is how the
  // Join question gets asked (lib/join-required.ts).
  const blocked = !!reason && reason.code !== 'join_required';
  const askToJoin = reason?.code === 'collab_required';
  const openHref = view?.open?.href || null;

  return (
    <div ref={root} className="rounded-2xl bg-white dark:bg-zinc-900 mb-5">
      <div ref={card} id="suggest-back-dialog" className="flex flex-col px-4 pb-5" aria-label={t('project:suggestBack.title', { project: name })}>
        <h2 className="text-lg font-bold pt-3 pb-2 break-words">{t('project:suggestBack.title', { project: name })}</h2>
        {sent ? (
          <p role="status" data-suggest-sent className="text-sm text-zinc-700 dark:text-zinc-300">
            <RichMessage
              id="project:suggestBack.sent"
              values={{ project: name }}
              components={[<a href={sent.href} className={LINK} onClick={onClose} />]}
            />
          </p>
        ) : (
          <>
            <p className="text-sm text-zinc-600 dark:text-zinc-300 mb-3">
              {t('project:suggestBack.intro', { project: name })}
            </p>
            <div className={`rounded-lg bg-zinc-50 dark:bg-zinc-800/60 border border-zinc-200 dark:border-zinc-700 text-sm text-zinc-700 dark:text-zinc-200 ${picks && !loading ? 'suggest-pick' : 'p-3'}`}>
              {loading ? (
                <p role="status" className="text-zinc-500 dark:text-zinc-400">{t('project:suggestBack.loading')}</p>
              ) : picks ? (
                // One tick box a change, all ticked: the whole row is the box's label.
                <ul data-suggest-changes="" data-suggest-picks="" aria-label={t('project:suggestBack.pick.name')}>
                  {picks.map((c) => (
                    <li key={c.sha}>
                      <label className={PICK_ROW} data-suggest-pick={c.sha}>
                        <input
                          type="checkbox"
                          className="suggest-pick-box"
                          checked={!unpicked.has(c.sha)}
                          disabled={busy}
                          onChange={(event) => {
                            const on = event.target.checked;
                            setUnpicked((was) => {
                              const next = new Set(was);
                              if (on) next.delete(c.sha); else next.add(c.sha);
                              return next;
                            });
                          }}
                        />
                        <span className="suggest-pick-title">{c.title || c.sha.slice(0, 7)}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              ) : lines.length ? (
                <ul data-suggest-changes className="list-disc pl-5 space-y-1">
                  {lines.map((line, i) => <li key={`${i}:${line}`} className="break-words">{line}</li>)}
                </ul>
              ) : (
                <p className="text-zinc-500 dark:text-zinc-400">{t('project:suggestBack.changes.none')}</p>
              )}
            </div>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-3">
              {t('project:suggestBack.notSent', { copy: copyName })}
            </p>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1.5">
              {t('project:suggestBack.after', { project: name })}
            </p>
            {blocked && reason ? (
              <p role="alert" data-suggest-reason={reason.code} className="text-sm text-zinc-800 dark:text-zinc-200 mt-3">
                {`${reason.error} `}
                {askToJoin ? (
                  <a href={`#app/${encodeURIComponent(original.slug)}`} className={LINK} onClick={onClose}>
                    {t('project:suggestBack.openOriginal', { project: name })}
                  </a>
                ) : null}
                {openHref ? <a href={openHref} className={LINK} onClick={onClose}>{t('project:suggestBack.openProposal')}</a> : null}
              </p>
            ) : null}
            {error ? <p role="alert" className="text-sm text-red-700 dark:text-red-400 mt-3">{error}</p> : null}
          </>
        )}
        <div className="flex gap-3 mt-5">
          {sent ? (
            <Button type="button" className="min-h-[44px] flex-1" onClick={onClose}>{t('core:common.done')}</Button>
          ) : (
            <>
              <Button type="button" variant="neutral" ink="muted" className="min-h-[44px]" disabled={busy} onClick={onClose}>
                {t('core:common.cancel')}
              </Button>
              <Button
                type="button"
                data-suggest-send
                className="min-h-[44px] flex-1"
                disabled={loading || busy || blocked || (!!picks && !picked)}
                onClick={() => { void send(); }}
              >
                {busy ? t('project:suggestBack.sending')
                  : picks ? t('project:suggestBack.sendCount', { count: picked })
                    : t('project:suggestBack.send', { project: name })}
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
