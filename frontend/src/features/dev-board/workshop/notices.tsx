import { t as tr } from "../../../lib/i18n/runtime";
import { useMessages as useUiLanguage } from "../../../lib/i18n/react";
import { RichMessage } from "../../../lib/i18n/react";
import { Message } from "../../../lib/i18n/react";
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
  const who = notice.by ? tr("workshop:by_value1_363778f7", { value1: notice.by }) : (notice.kind === 'approver' ? '' : tr("workshop:through_a_voted_change_ed6e92ec"));
  const when = notice.at ? agoStamp(notice.at).text : '';
  return [who, when].filter(Boolean).join(' · ');
}

/** True when the panel has anything to say. */
export function hasNotices(notices: Notices | null | undefined): boolean {
  return !!notices && (!!notices.week || notices.settings.length > 0);
}

export function NoticesPanel({ notices }: { notices: Notices }) {
  if (!hasNotices(notices)) return null;
  return (
    <section className="dev-ws-strip" data-ws-notices="">
      <div className="dev-ws-head"><RichMessage id="workshop:sentence_702899cf9be6" components={[<span className="dev-ws-head-title" />]} /></div>
      <ul className="dev-ws-notices">
        {notices.week ? (
          <li className="dev-ws-notice" data-ws-notice="week">
            <span className="dev-ws-notice-text"><b><Message id="workshop:this_week_6654dcf5" /></b> {notices.week.line.replace(/^This week on [^:]+:\s*/, '')}</span>
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
  useUiLanguage();
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
