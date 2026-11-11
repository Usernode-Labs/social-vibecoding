/**
 * The You tab in the one frame, version 2 (the tour's s44 and s45): the first
 * tour's layout holding today's page. Your handle as the title with the line
 * of facts under it and Edit profile; the tabs (Overview, Changes, Requests,
 * Feedback, Votes, Friends); then two columns. The work column is the
 * standard page's row groups in its order (../account-panel.tsx: Your work,
 * Rewards, Account, Settings, Admin) under the verified accounts; the side
 * column is its two figures and This week with its chart and Share
 * (../profile-view.tsx StatCards, ActivityCard).
 *
 * Presentational: the profile's own view (../profile-store.js
 * buildProfileView) with another face. ../profile-view.tsx hands it in and
 * keeps the sheets (edit, feedback, app slots, share your week) it opens.
 * `YouPage` is the shell every tab is drawn in; `YouFrame` is the Overview.
 */
import { useEffect, type MouseEvent, type ReactNode } from 'react';

import { Bars, Btn, Card, Cols, Facts, Frame, GroupLink, Lead, PageBody, Pill, Row, Sec, Sub, Tabs, k } from '@/components/ui/kit';
import { useMessages } from '../../../lib/i18n/react';
import { useFrameFlag } from '../../frame/frame-flag';
import { tabAddress, type YouTab } from './you-tabs';

interface Chip { key: string; label: string; href?: string; external?: boolean }
export interface YouIdentity {
  name: string;
  /** `@handle`: the page's title. */
  username?: string | null;
  /** The display name, when one is set (the title is the handle either way). */
  displayName?: string | null;
  /** "Building since April 2026 · Changes live in 81 apps". */
  about?: string | null;
  bio?: string | null;
  chips?: Chip[];
}
interface Stat { key: string; value: string; label: string; zero?: boolean }
interface Day { key: string; label: string; heightPct: number; zero: boolean; today: boolean; peakLabel: string | null }
interface Activity {
  empty: boolean; canShare?: boolean;
  time?: string | null; apps?: string | null; appsLabel?: string;
  merged?: string | null; mergedLabel?: string | null; challenges?: string | null; challengesLabel?: string | null;
  days?: Day[];
}
interface Rows {
  changes?: string | null; requests?: string | null; requestsPending?: boolean; feedback?: string | null;
  votes?: string | null; challenges?: string | null; friends?: string | null;
}

/** A plain click is handled here; a cmd-click or a middle click keeps the address. */
const plain = (event: MouseEvent<HTMLElement>, run: () => void) => {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
  event.preventDefault();
  run();
};

export interface YouShell {
  identity: YouIdentity;
  tab: YouTab;
  onTab: (tab: YouTab) => void;
  onEdit: () => void;
  onFeedback: () => void;
}

/**
 * You's page under a look: the head and the tabs, around one tab's columns.
 * Feedback is a tab that opens the product's own "Your feedback" card (it has
 * no page of its own), so it is never the lit one.
 */
export function YouPage({ shell, side, sideFirst, children }: { shell: YouShell; side?: ReactNode; sideFirst?: boolean; children?: ReactNode }) {
  useFrameFlag('you-frame');
  const t = useMessages('profile');
  const tm = useMessages('messages');
  const { identity, tab, onTab, onEdit, onFeedback } = shell;
  const door = (key: YouTab, label: string) => ({ key, label, href: tabAddress(key) });
  // Six tabs are wider than a phone, where the row scrolls: the lit one is brought into view.
  useEffect(() => {
    document.querySelector('[data-you-frame] .fr-tab.fr-on')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [tab]);
  return (
    <PageBody
      data-you-frame=""
      data-you-tab={tab}
      title={identity.username || identity.name}
      under={identity.displayName || undefined}
      purpose={identity.about || undefined}
      acts={<Btn kind="line" onClick={onEdit}>{t('profile:identity.edit')}</Btn>}
      tabs={(
        <Tabs
          label={t('profile:frame.tab.label')}
          current={tab}
          onPick={(key, event) => plain(event, () => (key === 'feedback' ? onFeedback() : onTab(key as YouTab)))}
          tabs={[
            door('overview', t('profile:frame.tab.overview')),
            door('changes', tm('messages:ai.history.kind.change')),
            door('requests', tm('messages:ai.history.kind.request')),
            { key: 'feedback', label: t('profile:frame.tab.feedback'), href: '#profile?feedback' },
            door('votes', tm('messages:ai.history.kind.vote')),
            door('friends', t('profile:friends.title')),
          ]}
        />
      )}
      side={side}
      sideFirst={sideFirst}
    >
      {children}
    </PageBody>
  );
}

/** The week's figures, two to a line, as the standard card lists them. */
function weekFigures(activity: Activity, timeLabel: string) {
  const figures = [
    activity.time ? { value: activity.time, label: timeLabel } : null,
    activity.apps ? { value: activity.apps, label: activity.appsLabel || '' } : null,
    activity.merged ? { value: activity.merged, label: activity.mergedLabel || '' } : null,
    activity.challenges ? { value: activity.challenges, label: activity.challengesLabel || '' } : null,
  ].filter(Boolean) as Array<{ value: string; label: string }>;
  const lines: Array<typeof figures> = [];
  for (let i = 0; i < figures.length; i += 2) lines.push(figures.slice(i, i + 2));
  return lines;
}

/**
 * You before its data, under a look: the kit's page at its own shape (the
 * title and its line, a card of rows, the figures beside it), drawn as
 * blocks in the look's sunk tone. The standard look keeps its own outline
 * (../profile-view.tsx ProfileSkeleton); the words a screen reader hears
 * are the same.
 */
export function YouLoading() {
  useFrameFlag('you-frame');
  const t = useMessages('profile');
  const row = (i: number) => (
    <div key={i} className={k('row')}>
      <span data-sk="tile" />
      <span className={k('tx')}><span data-sk="line" /><span data-sk="sub" /></span>
    </div>
  );
  return (
    <Frame data-you-frame="" data-you-loading="" role="status" aria-label={t('profile:screen.loading')}>
      <div className={`${k('inner')} animate-pulse`} aria-hidden="true">
        <div className={k('head')}><div className={k('tx')}><span data-sk="title" /><span data-sk="purpose" /></div></div>
        <div data-sk="tabs" />
        <Cols side={<><Card pad><span data-sk="figure" /><span data-sk="sub" /></Card><Card pad><span data-sk="line" /><span data-sk="plot" /></Card></>}>
          <Card>{[0, 1, 2, 3].map(row)}</Card>
          <Card>{[0, 1].map(row)}</Card>
        </Cols>
      </div>
    </Frame>
  );
}

export function YouFrame({ shell, stats, activity, rows, slots, admin, wallet = false, onSlots, onShareWeek }: {
  shell: YouShell;
  stats: Stat[];
  activity: Activity | null;
  rows: Rows;
  /** The App slots row's line, as the standard row says it. */
  slots: string | null;
  admin: boolean;
  /** The native app, where Settings also holds the wallet (the standard row's own line says so). */
  wallet?: boolean;
  onSlots: () => void;
  /** Share your week (#6464), the standard card's own button: the group's link. */
  onShareWeek?: () => void;
}) {
  const t = useMessages('profile');
  const { identity, onTab, onEdit, onFeedback } = shell;
  const said = stats.filter((stat) => !stat.zero);
  const chips = identity.chips || [];
  const days = (activity && activity.days) || [];
  return (
    <YouPage
      shell={shell}
      side={(
        <>
          {said.length ? (
            <Sec label={t('profile:frame.numbers')}>
              <Facts items={said.slice(0, 5).map((stat) => ({ value: stat.value, label: stat.label }))} />
            </Sec>
          ) : null}
          {activity ? (
            <Sec label={t('profile:activity.title')} action={activity.canShare && onShareWeek ? <GroupLink onClick={onShareWeek}>{t('profile:activity.share')}</GroupLink> : undefined}>
              {activity.empty ? <Card pad>{t('profile:activity.empty')}</Card> : (
                <Card>
                  {weekFigures(activity, t('profile:activity.timeLabel')).map((line, i) => <Facts key={i} inset items={line} />)}
                  {days.length ? (
                    <Bars
                      label={t('profile:activity.chartLabel')}
                      days={days.map((day) => ({ label: day.label, value: day.zero ? 0 : day.heightPct / 100, text: day.peakLabel, now: day.today }))}
                    />
                  ) : null}
                  <div className={k('foot', 'left')}>{t('profile:activity.note')}</div>
                </Card>
              )}
            </Sec>
          ) : null}
        </>
      )}
    >
      {identity.bio ? <Sub size={15} as="p">{identity.bio}</Sub> : null}
      {chips.length ? (
        <div className={k('btnrow', 'chips')}>
          {chips.map((chip) => (chip.href
            ? <a key={chip.key} className={k('pill')} href={chip.href} {...(chip.external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>{chip.label}</a>
            : <Pill key={chip.key}>{chip.label}</Pill>))}
        </div>
      ) : null}
      <Sec label={t('profile:work.heading')}>
        <Card>
          <Row href={tabAddress('changes')} onClick={(e) => plain(e, () => onTab('changes'))} lead={<Lead icon="tool" />} title={t('profile:work.changes.title')} line={rows.changes || t('profile:work.changes.hint')} go />
          <Row href={tabAddress('requests')} onClick={(e) => plain(e, () => onTab('requests'))} lead={<Lead icon="chat" />} title={t('profile:work.requests.title')} line={rows.requests || (rows.requestsPending ? t('profile:work.requests.counting') : t('profile:work.requests.hint'))} go />
          <Row href="#profile?feedback" onClick={(e) => plain(e, onFeedback)} lead={<Lead icon="edit" />} title={t('profile:work.feedback.title')} line={rows.feedback || t('profile:work.feedback.hint')} go />
          <Row href={tabAddress('votes')} onClick={(e) => plain(e, () => onTab('votes'))} lead={<Lead icon="hand" />} title={t('profile:work.votes.title')} line={rows.votes || t('profile:work.votes.hint')} go />
        </Card>
      </Sec>
      <Sec label={t('profile:rewards.heading')}>
        <Card>
          <Row href="#leaderboard/challenges" lead={<Lead icon="trophy" />} title={t('profile:more.challenges.title')} line={rows.challenges || t('profile:more.challenges.hint')} go />
        </Card>
      </Sec>
      <Sec label={t('profile:account.heading')}>
        <Card>
          <Row href={tabAddress('friends')} onClick={(e) => plain(e, () => onTab('friends'))} lead={<Lead icon="users" />} title={t('profile:more.friends.title')} line={rows.friends || t('profile:more.friends.hint')} go />
          <Row href="#profile?slots" onClick={(e) => plain(e, onSlots)} lead={<Lead icon="box" />} title={t('profile:more.appSlots.title')} line={slots || t('profile:more.appSlots.hint')} go />
        </Card>
      </Sec>
      <Sec label={t('profile:settings.heading')}>
        <Card>
          <Row href="#profile?edit" onClick={(e) => plain(e, onEdit)} lead={<Lead icon="user" />} title={t('profile:settings.profile.title')} line={t('profile:settings.profile.hint')} go />
          <Row href="#settings/alerts" lead={<Lead icon="bell" />} title={t('profile:settings.notifications.title')} line={t('profile:settings.notifications.hint')} go />
          <Row href="#settings" lead={<Lead icon="sliders" />} title={t('profile:more.settings.title')} line={wallet ? t('profile:more.settings.hintWallet') : t('profile:more.settings.hint')} go />
        </Card>
      </Sec>
      {admin ? (
        <Sec label={t('profile:admin.heading')}>
          <Card>
            <Row href="#admin" lead={<Lead icon="shield" />} title={t('profile:admin.console.title')} line={t('profile:admin.console.hint')} go />
          </Card>
        </Sec>
      ) : null}
    </YouPage>
  );
}
