/**
 * `#profile-feedback-sheet` — "Your feedback" (#3186): what the viewer sent
 * through the feedback dialog, where it went, its status, and a link to the
 * request each one became.
 *
 * The same presentation as ./profile-edit-sheet.tsx, on purpose: rendered
 * inside #profile-root while `feedbackOpen` is set, and handed to the native
 * kit's MODAL by lib/sheet.ts. The modal and not the bottom sheet for
 * the reason #1285 moved the editor: `.un-modal` is a real scroller, while the
 * kit sheet takes every vertical drag as a drag of the sheet, so a list longer
 * than the screen could not be scrolled in it. With no kit the card simply
 * stays where React put it, at the top of the screen.
 *
 * The constraints are the editor's, for the same reasons: the root and card
 * class strings are constants (the kit writes `platform-modal-adopted` and
 * `platform-modal-card` onto them), the root is the flagged node and the card
 * the lifted one, and the Sheet brings the card home before React removes it.
 *
 * Everything the list SAYS is ./profile-store.js's feedbackListView, where the
 * node suite can reach it; this file only turns it into elements.
 */

import { Fragment, useEffect, useState, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { GroupedList, ListRow } from '@/components/ui/grouped-list';
import { useMessages } from '../../lib/i18n/react';
import { useSheet } from '../../lib/sheet';
import { Profile } from './profile.js';

/** The no-kit card chrome, on the node the kit flags. Constant. */
const ROOT_CLASS = 'rounded-2xl bg-white dark:bg-zinc-900 mb-5';

/** The lifted card. Constant, and `flex flex-col` for the #1285 reason. */
const CARD_CLASS = 'flex flex-col px-4 pb-5';

const NOTE_CLASS = 'text-sm text-zinc-500 dark:text-zinc-400';

// × as a character: this is text, not HTML source.
const TIMES = '×';

export interface FeedbackRowView {
  key: string;
  title: string;
  meta: string;
  status: 'received' | 'counted';
  statusLabel: string;
  statusClassName: string;
  href: string | null;
  edit: { reportId: number; version: number; title: string; description: string; secondsLeft: number; expiresAt: number } | null;
}

export interface FeedbackListView {
  loaded: boolean;
  summary: string | null;
  truncated: boolean;
  rows: FeedbackRowView[];
}

function EditRow({ row }: { row: FeedbackRowView }): ReactNode {
  const t = useMessages('profile');
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!row.edit) return;
    const deadline = row.edit.expiresAt;
    const timer = setInterval(() => {
      const at = Date.now();
      setNow(at);
      if (at >= deadline) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [row.edit]);
  const secondsLeft = row.edit ? Math.max(0, (row.edit.expiresAt - now) / 1000) : 0;
  if (!row.edit || secondsLeft <= 0) return null;
  return (
    <ListRow as="button" data-feedback-edit={row.key}
      title={t('profile:feedback.edit')} titleClassName="text-violet-700 dark:text-violet-300"
      subtitle={t('profile:feedback.editLeft', { count: Math.ceil(secondsLeft / 60) })} chevron={false}
      onClick={() => {
        if (!row.edit) return;
        const remaining = Math.max(0, (row.edit.expiresAt - Date.now()) / 1000);
        if (!remaining) { setNow(Date.now()); return; }
        const open = window.App?.openFeedbackModal;
        if (typeof open !== 'function') return;
        Profile._dismissFeedback();
        open({ edit: { ...row.edit, secondsLeft: remaining },
          onEditSaved: () => { void Profile.refreshFeedback(); } });
      }}
    />
  );
}

function Rows({ view }: { view: FeedbackListView }): ReactNode {
  const t = useMessages('profile');
  if (!view.loaded) {
    return (
      <p id="profile-feedback-error" className={`${NOTE_CLASS} py-6 text-center`}>
        {t('profile:feedback.loadFailed')}
      </p>
    );
  }
  if (!view.rows.length) {
    return (
      <p id="profile-feedback-empty" className={`${NOTE_CLASS} py-6 text-center`}>
        {t('profile:feedback.empty')}
      </p>
    );
  }
  return (
    <>
      <GroupedList id="profile-feedback-list" className="mx-0">
        {view.rows.map((row) => (
          <Fragment key={row.key}>
            <ListRow
              as={row.href ? 'a' : 'div'}
              href={row.href || undefined}
              data-feedback-report={row.key}
              data-feedback-status={row.status}
              // Leaving for the request closes the list first, as the editor's
              // links do; the back record is spent after the navigation lands.
              onClick={row.href ? () => Profile._dismissFeedback() : undefined}
              title={row.title}
              titleClassName="text-[0.9375rem] font-semibold whitespace-normal line-clamp-2"
              // The status leads the second line rather than taking the row's
              // trailing edge: on a phone a chip and a chevron side by side
              // left the title two words a line.
              subtitle={(
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className={row.statusClassName}>{row.statusLabel}</span>
                  <span>{row.meta}</span>
                </span>
              )}
              subtitleClassName="mt-1 text-[0.8125rem] whitespace-normal"
              chevron={!!row.href}
            />
            {row.edit ? <EditRow row={row} /> : null}
          </Fragment>
        ))}
      </GroupedList>
      {view.truncated ? (
        <p className={`${NOTE_CLASS} mt-3`}>{t('profile:feedback.truncated')}</p>
      ) : null}
    </>
  );
}

export function FeedbackSheet({ view }: { view: FeedbackListView }): ReactNode {
  const t = useMessages('profile');

  // Lifted into the kit's modal while it is mounted; Escape, Back, the
  // backdrop and focus are the Sheet's (lib/sheet.ts).
  const { rootRef, panelRef } = useSheet({ kind: 'modal', onClose: () => Profile._dismissFeedback() });

  return (
    <div id="profile-feedback-root" ref={rootRef} className={ROOT_CLASS}>
      <div id="profile-feedback-sheet" ref={panelRef} className={CARD_CLASS}>
        <div className="flex items-center justify-between gap-3 pt-3">
          <h2 className="text-lg font-bold">{t('profile:feedback.title')}</h2>
          <Button
            id="profile-feedback-close"
            variant="neutral"
            size="sm"
            ink="neutral"
            aria-label={t('profile:feedback.close')}
            onClick={() => Profile._dismissFeedback()}
          >
            {TIMES}
          </Button>
        </div>
        {view.summary ? (
          <p id="profile-feedback-summary" className={`${NOTE_CLASS} mt-0.5`}>{view.summary}</p>
        ) : null}
        {/* What the two statuses mean, once, above the rows that wear them. */}
        <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-2 mb-3">
          {t('profile:feedback.legend')}
        </p>
        <Rows view={view} />
      </div>
    </div>
  );
}
