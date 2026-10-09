/**
 * A project's notices, at the head of its Workshop tab: what changed about
 * the project itself lately (GET /api/apps/:slug/notices,
 * src/services/app-notices.js).
 *
 * These were lines in the project's channel until a channel became only
 * what people said. Two kinds had nowhere else to be seen, and they are
 * this panel:
 *
 *   - THIS WEEK, the Friday card, for a few days after it is made: what went
 *     live and what is waiting on votes, a few titles of each and a count
 *     of the rest, naming nobody (#3678);
 *   - SETTINGS CHANGED in the last week: who can see it, the approval rule,
 *     its admins, the lock, a new approver, and who did it (or that a vote
 *     carried it, for a change made in dapp.json).
 *
 * Merges paused by a red main and a release that has not rolled out are
 * already banners at the top of the project page (../board-frame.tsx), over
 * both tabs, so they are not repeated here.
 *
 * IT APPEARS ONLY WHEN THERE IS SOMETHING TO SAY. Nothing renders while it
 * loads, if it fails, or when both are empty, and the first render is
 * nothing, so the prerendered page is unchanged; the data loads in an
 * effect.
 */

import { useEffect, useState } from 'react';

import { RichMessage, useMessages } from '../../../lib/i18n/react';
import { t } from '../../../lib/i18n/runtime';
import { agoStamp } from '../../../lib/timestamp';

export type SettingsNotice = {
  kind: string;
  text: string;
  /** The person who did it, or null for a change a vote carried. */
  by: string | null;
  at: string | null;
};

export type WeekNotice = {
  at: string | null;
  line: string;
  mergedTotal: number;
  openTotal: number;
};

export type Notices = { settings: SettingsNotice[]; week: WeekNotice | null };

/** "by @ada · 2d ago", or "through a voted change · 2d ago". */
export function noticeMeta(notice: Pick<SettingsNotice, 'by' | 'at' | 'kind'>): string {
  const when = notice.at ? agoStamp(notice.at).text : '';
  // Each case is a whole message: who did it, when, or both.
  if (notice.by) {
    return when
      ? t('project:notices.meta.byWhen', { username: notice.by, when })
      : t('project:notices.meta.by', { username: notice.by });
  }
  if (notice.kind === 'approver') return when;
  return when ? t('project:notices.meta.votedWhen', { when }) : t('project:notices.meta.voted');
}

/** True when the panel has anything to say. */
export function hasNotices(notices: Notices | null | undefined): boolean {
  return !!notices && (!!notices.week || notices.settings.length > 0);
}

export function NoticesPanel({ notices }: { notices: Notices }) {
  // Subscribed: the head, and the meta lines noticeMeta reads.
  const translate = useMessages('project');
  if (!hasNotices(notices)) return null;
  return (
    <section className="dev-ws-strip" data-ws-notices="">
      <div className="dev-ws-head">
        <span className="dev-ws-head-title">{translate('project:notices.title')}</span>
      </div>
      <ul className="dev-ws-notices">
        {notices.week ? (
          <li className="dev-ws-notice" data-ws-notice="week">
            <span className="dev-ws-notice-text">
              <RichMessage
                id="project:notices.week"
                values={{ summary: notices.week.line.replace(/^This week on [^:]+:\s*/, '') }}
                components={[<b />]}
              />
            </span>
            {notices.week.at ? <span className="dev-ws-notice-meta">{agoStamp(notices.week.at).text}</span> : null}
          </li>
        ) : null}
        {notices.settings.map((notice, i) => (
          <li key={`${notice.kind}-${notice.at || i}-${i}`} className="dev-ws-notice" data-ws-notice={notice.kind}>
            <span className="dev-ws-notice-text">{notice.text}</span>
            {noticeMeta(notice) ? <span className="dev-ws-notice-meta">{noticeMeta(notice)}</span> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Loads a project's notices and draws the panel when there are any. */
export function WorkshopNotices({ slug }: { slug: string }) {
  const [notices, setNotices] = useState<Notices | null>(null);
  useEffect(() => {
    if (!slug) return undefined;
    let live = true;
    const demo = typeof location !== 'undefined' && new URLSearchParams(location.search).get('demo') === '1' ? '?demo=1' : '';
    fetch(`/api/apps/${encodeURIComponent(slug)}/notices${demo}`, { credentials: 'same-origin' })
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (!live || !body || !Array.isArray(body.settings)) return;
        setNotices({ settings: body.settings, week: body.week || null });
      })
      .catch(() => { /* nothing to say is the same as failing to say it */ });
    return () => { live = false; };
  }, [slug]);
  return notices ? <NoticesPanel notices={notices} /> : null;
}
