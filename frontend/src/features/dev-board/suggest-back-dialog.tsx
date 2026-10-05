import { useMessages as useUiLanguage } from "../../lib/i18n/react";
import { LocalizedValue, LocalizedDynamic } from "../../lib/i18n/react";
import { t as tr } from "../../lib/i18n/runtime";
import { Message } from "../../lib/i18n/react";
/**
 * "Suggest this back to <Original>": the confirmation a remix's owner sees
 * before their copy's changes go to the app it was copied from, as a
 * proposal there (src/services/suggest-back.js says what is sent).
 *
 * Opened from the project's ⋯ (./actions-row.tsx DevPlusMenu, its
 * "Suggest this back" row), and drawn the way that menu's other pop-up,
 * the Featured illustration editor, is: portalled to <body> and handed to
 * the kit as a modal (lib/kit-surface.ts adoptKitSurface). It is not one of
 * the static dialogs (features/dialogs/): it exists only while it is open.
 *
 * It reads GET /api/apps/:slug/suggest-back once it is open, never in a
 * render: the commit subjects since the remix (or how many files changed),
 * and whether Send can go ahead. The refusals it can meet are the server's
 * own sentences. A non-member of the original is asked to Join by the fetch
 * wrapper when Send is pressed (lib/join-required.ts), which then sends again.
 */

import { useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';

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
}

/**
 * Who the ⋯ offers "Suggest this back" to: the copy's owner, on a copy whose
 * original still exists. `app` is the open app's payload (AppView.appData,
 * whose `forked_from` GET /api/apps/:slug resolves to { slug, name,
 * linkable }); `viewerId` the signed-in user's id. Copies made before the
 * lineage commits were recorded still get the row: the dialog then says
 * plainly why it cannot send. Pure.
 */
export function suggestBackTarget(
  app: any,
  viewerId: number | null | undefined,
): { slug: string; name: string } | null {
  if (!app || app.self_hosted || viewerId == null) return null;
  if (app.created_by == null || app.created_by !== viewerId) return null;
  const ref = app.forked_from;
  if (!ref || typeof ref !== 'object' || !ref.linkable || typeof ref.slug !== 'string' || !ref.slug) return null;
  return { slug: ref.slug, name: typeof ref.name === 'string' && ref.name ? ref.name : ref.slug };
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
    return more ? [...listed, tr("workshop:and_value1_more_05cce967", { value1: more })] : listed;
  }
  if (view.fileCount > 0) return [view.fileCount === 1 ? tr("workshop:1_file_changed_32dfcdbc") : tr("workshop:value1_files_changed_eb9dc2d2", { value1: view.fileCount })];
  return [];
}

const LINK = 'text-violet-700 dark:text-violet-400 underline';

export function SuggestBackDialog({ slug, copyName, original, onClose }: {
  slug: string;
  copyName: string;
  original: { slug: string; name: string };
  onClose: () => void;
}) {
  useUiLanguage();
  const root = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  useIsomorphicLayoutEffect(() => { close.current = onClose; }, [onClose]);

  const [view, setView] = useState<SuggestBackPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState<{ href: string } | null>(null);
  const endpoint = `/api/apps/${encodeURIComponent(slug)}/suggest-back`;
  const name = view?.original?.name || original.name;

  useEffect(() => {
    const controller = new AbortController();
    fetch(endpoint, { signal: controller.signal })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (controller.signal.aborted) return;
        if (!res.ok) throw new Error(data.error || tr("workshop:could_not_load_your_changes_close_this_and_try_a_8e801c26"));
        setView(data as SuggestBackPreview);
        setLoading(false);
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : tr("workshop:could_not_load_your_changes_c4f4961d"));
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
      const res = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || tr("workshop:your_changes_were_not_sent_try_again_78138f23"));
        if (data.open?.href) setView((v) => (v ? { ...v, open: data.open, ready: false } : v));
        return;
      }
      setSent({ href: data.href });
    } catch {
      setError(tr("workshop:network_error_please_try_again_9ff8cfaf"));
    } finally {
      setBusy(false);
    }
  }

  const lines = changeLines(view);
  const reason = view && !view.ready ? view.reason : null;
  // join_required is not a reason to hold Send back: pressing it is how the
  // Join question gets asked (lib/join-required.ts).
  const blocked = !!reason && reason.code !== 'join_required';
  const askToJoin = reason?.code === 'collab_required';
  const openHref = view?.open?.href || null;

  return (
    <div ref={root} className="rounded-2xl bg-white dark:bg-zinc-900 mb-5">
      <LocalizedDynamic element={<div ref={card} id="suggest-back-dialog" className="flex flex-col px-4 pb-5" aria-label={tr("workshop:suggest_this_back_to_value1_7596aa48", { value1: name })}>
        <h2 className="text-lg font-bold pt-3 pb-2 break-words"><LocalizedValue render={() => (tr("workshop:suggest_this_back_to_value1_7596aa48", { value1: name }))} /></h2>
        {sent ? (
          <p role="status" data-suggest-sent className="text-sm text-zinc-700 dark:text-zinc-300">
            <LocalizedValue render={() => (tr("workshop:sent_your_changes_are_a_proposal_on_value1_now_5325f3f6", { value1: name }))} />
            <a href={sent.href} className={LINK} onClick={onClose}><Message id="workshop:open_the_proposal_7376180d" /></a>
          </p>
        ) : (
          <>
            <p className="text-sm text-zinc-600 dark:text-zinc-300 mb-3">
              <LocalizedValue render={() => (tr("workshop:your_changes_since_you_remixed_go_to_value1_as_a_65f4493c", { value1: name }))} />
            </p>
            <div className="rounded-lg bg-zinc-50 dark:bg-zinc-800/60 border border-zinc-200 dark:border-zinc-700 p-3 text-sm text-zinc-700 dark:text-zinc-200">
              {loading ? (
                <p role="status" className="text-zinc-500 dark:text-zinc-400"><Message id="workshop:loading_your_changes_6775b5b0" /></p>
              ) : lines.length ? (
                <ul data-suggest-changes className="list-disc pl-5 space-y-1">
                  {lines.map((line, i) => <li key={`${i}:${line}`} className="break-words">{line}</li>)}
                </ul>
              ) : (
                <p className="text-zinc-500 dark:text-zinc-400"><Message id="workshop:no_changes_listed_yet_f53696e1" /></p>
              )}
            </div>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-3">
              <LocalizedValue render={() => (tr("workshop:not_sent_value1_s_name_who_can_see_it_its_admins_625852f3", { value1: copyName }))} />
            </p>
            {blocked && reason ? (
              <p role="alert" data-suggest-reason={reason.code} className="text-sm text-zinc-800 dark:text-zinc-200 mt-3">
                {`${reason.error} `}
                {askToJoin ? (
                  <a href={`#app/${encodeURIComponent(original.slug)}`} className={LINK} onClick={onClose}>
                    <LocalizedValue render={() => (tr("workshop:open_value1_839d6dee", { value1: name }))} />
                  </a>
                ) : null}
                {openHref ? <a href={openHref} className={LINK} onClick={onClose}><Message id="workshop:open_the_proposal_7376180d" /></a> : null}
              </p>
            ) : null}
            {error ? <p role="alert" className="text-sm text-red-700 dark:text-red-400 mt-3">{error}</p> : null}
          </>
        )}
        <div className="flex gap-3 mt-5">
          {sent ? (
            <Button type="button" className="min-h-[44px] flex-1" onClick={onClose}><Message id="workshop:done_11a6767d" /></Button>
          ) : (
            <>
              <Button type="button" variant="neutral" ink="muted" className="min-h-[44px]" disabled={busy} onClick={onClose}><Message id="workshop:cancel_19766ed6" /></Button>
              <Button
                type="button"
                data-suggest-send
                className="min-h-[44px] flex-1"
                disabled={loading || busy || blocked}
                onClick={() => { void send(); }}
              >
                <LocalizedValue render={() => (busy ? tr("workshop:sending_b8ed5279") : tr("workshop:send_to_value1_e83239e2", { value1: name }))} />
              </Button>
            </>
          )}
        </div>
      </div>} resolve={() => ({ get "aria-label"() { return tr("workshop:suggest_this_back_to_value1_7596aa48", { value1: name }); } })} />
    </div>
  );
}
