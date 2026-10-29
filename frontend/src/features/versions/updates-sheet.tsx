/**
 * "Updates from <original>": the small sheet a version's ⋯ opens from its
 * Settings & rules (../dev-board/actions-row.tsx DevPlusMenu, the
 * `data-plus="updates"` row), docs/plans/versions.md.
 *
 * Two switches, each a row of words with the switch at its end, as the
 * board filters dialog draws them:
 *
 *   - GET <ORIGINAL>'S UPDATES. Whether the version is given the original's
 *     changes to try and vote on is a line of its dapp.json
 *     (`followOriginal`), so it is a vote like any other setting: turning
 *     the switch opens that proposal (POST /api/apps/:slug/follow-pr) and
 *     the sheet links to it. The switch keeps saying how it is now until
 *     the proposal goes in; a proposal already up is linked the same way.
 *   - SHARE WHAT WE MAKE WITH <ORIGINAL>, on a private version, for whoever
 *     manages it: whether the original may list the titles of the changes
 *     that go live here ("Lately in its versions"). A privacy preference, not
 *     a line of the project, so it is set at once (…/upstream/share).
 *
 * Drawn the way the ⋯'s other pop-ups are (../dev-board/suggest-back-dialog.tsx):
 * portalled to <body> and handed to the kit as a modal, existing only while
 * it is open. Its state is GET /api/apps/:slug/upstream, read once it is open
 * (./upstream.ts), never in a render.
 */

import { useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';

import { RichMessage, useMessages } from '../../lib/i18n/react';
import { adoptKitSurface, type KitAdoption } from '../../lib/kit-surface';
import { useIsomorphicLayoutEffect } from '../../lib/legacy-dom';
import { proposeFollow, upstreamAction, upstreamAnswered, useUpstream } from './upstream';

const LINK = 'text-violet-700 dark:text-violet-400 underline';

export function UpdatesSheet({ slug, original, onClose }: {
  slug: string;
  /** The original's name as the ⋯'s row knew it, until the read answers. */
  original: { slug: string; name: string; following?: boolean };
  onClose: () => void;
}) {
  const t = useMessages('project');
  const root = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  useIsomorphicLayoutEffect(() => { close.current = onClose; }, [onClose]);
  const up = useUpstream(slug, true);
  const [busy, setBusy] = useState<'follow' | 'share' | null>(null);
  const [error, setError] = useState('');
  const [proposed, setProposed] = useState<string | null>(null);
  const name = up?.original?.name || original.name;

  useIsomorphicLayoutEffect(() => {
    if (!root.current || !card.current) return undefined;
    let adoption: KitAdoption | null = adoptKitSurface({
      kind: 'modal', contentEl: card.current, adoptedOn: root.current, home: 'placeholder', gate: 'kit',
      onDismiss: () => { adoption = null; close.current(); },
    });
    return () => { if (adoption) adoption.release(); };
  }, []);

  const following = up ? up.following : !!original.following;
  const turnFollow = async (next: boolean) => {
    if (busy) return;
    setBusy('follow');
    setError('');
    try {
      setProposed((await proposeFollow(slug, next, 'project:updates.follow.failed')) || '');
    } catch (err) {
      setError(err instanceof Error ? err.message : t('project:updates.follow.failed'));
    } finally {
      setBusy(null);
    }
  };
  const turnShare = async (next: boolean) => {
    if (busy) return;
    setBusy('share');
    setError('');
    try {
      await upstreamAction(slug, 'share', { share: next }, 'project:updates.share.failed');
    } catch (err) {
      setError(err instanceof Error ? err.message : t('project:updates.share.failed'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div ref={root} className="rounded-2xl bg-white dark:bg-zinc-900 mb-5">
      <div ref={card} id="updates-sheet" className="flex flex-col px-4 pb-5" aria-label={t('project:updates.title', { project: name })}>
        <h2 className="text-lg font-bold pt-3 pb-3 break-words">{t('project:updates.title', { project: name })}</h2>
        <div className="space-y-3">
          <label className="fork-follow" data-updates-follow="">
            <span className="min-w-0 flex-1">
              <span className="fork-follow-title">{t('project:updates.follow.title', { project: name })}</span>
              <span className="fork-follow-sub">{t('project:updates.follow.sub', { project: name })}</span>
            </span>
            {/* How it is now, until a vote changes it: the press asks for the
                vote rather than flipping the line on its own. */}
            <Switch
              checked={following}
              disabled={!up || busy !== null || proposed !== null}
              onChange={(event) => { void turnFollow(event.target.checked); }}
            />
          </label>
          <p className="text-xs text-zinc-500 dark:text-zinc-400" data-updates-follow-note="">
            {proposed !== null ? (
              <RichMessage
                id="project:updates.follow.proposed"
                components={[proposed ? <a href={proposed} className={LINK} onClick={onClose} /> : <span />]}
              />
            ) : t('project:updates.follow.vote')}
          </p>
          {up && up.private && up.canManage ? (
            <label className="fork-follow" data-updates-share="">
              <span className="min-w-0 flex-1">
                <span className="fork-follow-title">{t('project:updates.share.title', { project: name })}</span>
                <span className="fork-follow-sub">{t('project:updates.share.sub', { project: name })}</span>
              </span>
              <Switch
                checked={up.share}
                disabled={busy !== null}
                onChange={(event) => { void turnShare(event.target.checked); }}
              />
            </label>
          ) : null}
          {!up && upstreamAnswered(slug) ? (
            <p role="alert" className="text-sm text-red-700 dark:text-red-400">{t('project:updates.load.failed')}</p>
          ) : null}
          {error ? <p role="alert" className="text-sm text-red-700 dark:text-red-400">{error}</p> : null}
        </div>
        <div className="flex gap-3 mt-5">
          <Button type="button" className="min-h-[44px] flex-1" onClick={onClose}>{t('core:common.done')}</Button>
        </div>
      </div>
    </div>
  );
}
