/**
 * The You tab in the one frame, as the 2026-11-06 screen tour draws it (its
 * steps s44 and s45): your handle as the title, one line about you, Edit
 * profile; four numbers in one strip in place of the stat boxes and the bar
 * chart; Your work as rows; the week said in rows of words; the season,
 * friends, projects and Settings in the context column.
 *
 * Presentational: the profile's own view (../profile-store.js
 * buildProfileView) with another face. ../profile-view.tsx hands it in and
 * keeps the sheets (edit, friends, feedback, app slots) it opens.
 */
import type { MouseEvent } from 'react';

import { Btn, Card, Facts, Lead, PageBody, Row, Sec } from '@/components/ui/kit';
import { useMessages } from '../../../lib/i18n/react';
import { useFrameFlag } from '../../frame/frame-flag';

interface Identity { name: string; sub?: string | null; chips?: Array<{ key: string; label: string }> }
interface Stat { key: string; value: string; label: string; zero?: boolean }
interface Activity { empty: boolean; time?: string | null; apps?: string | null; appsLabel?: string }
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

export function YouFrame({ identity, stats, activity, rows, slots, admin, onEdit, onFriends, onSlots, onFeedback }: {
  identity: Identity;
  stats: Stat[];
  activity: Activity | null;
  rows: Rows;
  /** The App slots row's line, as the standard row says it. */
  slots: string | null;
  admin: boolean;
  onEdit: () => void;
  onFriends: () => void;
  onSlots: () => void;
  onFeedback: () => void;
}) {
  useFrameFlag('you-frame');
  const t = useMessages('profile');
  const said = stats.filter((stat) => !stat.zero);
  const about = [identity.sub, ...(identity.chips || []).map((chip) => chip.label)].filter(Boolean) as string[];
  const purpose = about.length ? about.reduce((first, second) => t('profile:frame.pair', { first, second })) : undefined;
  return (
    <PageBody
      data-you-frame=""
      title={identity.name}
      purpose={purpose}
      acts={<Btn icon="edit" onClick={onEdit}>{t('profile:identity.edit')}</Btn>}
      side={(
        <>
          <Sec label={t('profile:rewards.heading')}>
            <Card>
              <Row href="#leaderboard/challenges" lead={<Lead icon="trophy" />} title={t('profile:more.challenges.title')} line={rows.challenges || t('profile:more.challenges.hint')} go />
            </Card>
          </Sec>
          <Sec label={t('profile:account.heading')}>
            <Card>
              <Row href="#profile?friends" onClick={(e) => plain(e, onFriends)} lead={<Lead icon="users" />} title={t('profile:more.friends.title')} line={rows.friends || t('profile:more.friends.hint')} go />
              <Row href="#profile?slots" onClick={(e) => plain(e, onSlots)} lead={<Lead icon="box" />} title={t('profile:more.appSlots.title')} line={slots || t('profile:more.appSlots.hint')} go />
              <Row sm href="#settings" lead={<Lead icon="sliders" />} title={t('profile:more.settings.title')} go />
              {admin ? <Row sm href="#admin" lead={<Lead icon="shield" />} title={t('profile:admin.console.title')} go /> : null}
            </Card>
          </Sec>
        </>
      )}
    >
      {said.length ? (
        <Sec label={t('profile:frame.numbers')}>
          <Facts items={said.slice(0, 5).map((stat) => ({ value: stat.value, label: stat.label }))} />
        </Sec>
      ) : null}
      <Sec label={t('profile:work.heading')}>
        <Card>
          <Row href="#homeroom-bot/history?kind=change" lead={<Lead icon="tool" />} title={t('profile:work.changes.title')} line={rows.changes || t('profile:work.changes.hint')} go />
          <Row href="#homeroom-bot/history?kind=request" lead={<Lead icon="chat" />} title={t('profile:work.requests.title')} line={rows.requests || (rows.requestsPending ? t('profile:work.requests.counting') : t('profile:work.requests.hint'))} go />
          <Row href="#profile?feedback" onClick={(e) => plain(e, onFeedback)} lead={<Lead icon="bolt" />} title={t('profile:work.feedback.title')} line={rows.feedback || t('profile:work.feedback.hint')} go />
          <Row href="#homeroom-bot/history?kind=vote" lead={<Lead icon="vote" />} title={t('profile:work.votes.title')} line={rows.votes || t('profile:work.votes.hint')} go />
        </Card>
      </Sec>
      {activity && !activity.empty ? (
        <Sec label={t('profile:activity.title')}>
          <Card>
            {activity.time ? <Row sm lead={<Lead icon="clock" />} title={t('profile:frame.week.time', { time: activity.time })} /> : null}
            {activity.apps ? <Row sm lead={<Lead icon="grid" />} title={t('profile:frame.week.apps', { count: activity.apps, label: activity.appsLabel || '' })} /> : null}
          </Card>
        </Sec>
      ) : null}
    </PageBody>
  );
}
