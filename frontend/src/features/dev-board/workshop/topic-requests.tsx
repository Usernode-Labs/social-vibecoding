/**
 * #5304: A TOPIC'S REQUESTS, the tab its channel opens on.
 *
 * A topic is a category before it is a room: the requests filed under it are
 * the thing it groups. Its channel used to open on its figures and its chat,
 * with the requests a small link in the line above them. Now they are the
 * first of the channel's tabs (project-discussion.tsx TopicChannel), drawn as
 * By category draws the topic's card when it is opened: one lane per stage,
 * the board's rows under each (./work-row.tsx, variant `board`), and the way
 * to all of them on the Board under the last.
 *
 * The rows are the Workshop's own publish (AppView._workshopView `topics`):
 * the topic's theme in the whole grouping, so a search typed on All items
 * does not empty it. While the board has not loaded the tab draws
 * skeleton rows; a topic with nothing in it says so, and
 * still offers the Board when its record counts requests the grouping has not
 * placed yet.
 */

import type { ReactNode } from 'react';

import { Skeleton, SkeletonGroup } from '@/components/ui/skeleton';

import { useMessages } from '../../../lib/i18n/react';
import { useStoreState } from '../../../lib/use-store-state';
import { devWorkshopStore } from '../card/cards-store';
import type { DevWorkshopView, WorkshopTheme } from '../card/model';
import type { PlaceChannel } from './community-card';
import { WorkList, type CardRow } from './work-row';

/** The topic's theme in a Workshop publish, or null. Pure. */
export function topicTheme(view: Pick<DevWorkshopView, 'themes' | 'topics'> | null, key: string | null): WorkshopTheme | null {
  if (!view || !key) return null;
  const list = Array.isArray(view.topics) ? view.topics : (view.themes || []);
  return list.find((theme) => !!theme.topic && theme.topic.key === key) || null;
}

/** The lanes worth drawing: the ones with rows, in the publish's order. Pure. */
export function topicLanes(theme: WorkshopTheme | null): Array<{ lane: WorkshopTheme['lanes'][number]; rows: CardRow[] }> {
  if (!theme) return [];
  return theme.lanes
    .map((lane) => ({ lane, rows: lane.rows.filter((row): row is CardRow => row.t === 'card' && !!row.brief) }))
    .filter(({ lane, rows }) => rows.length > 0 || lane.more > 0);
}

export function TopicRequests({ slug, topic, onAll }: {
  slug: string;
  topic: PlaceChannel;
  /** Open All items narrowed to this topic. */
  onAll: () => void;
}): ReactNode {
  const t = useMessages('project');
  const view = useStoreState(devWorkshopStore) as DevWorkshopView;
  const theme = topicTheme(view, topic.key);
  const lanes = topicLanes(theme);
  const counted = Number(topic.requests) || 0;

  if (view.loading && !lanes.length) {
    return (
      <div className="dev-ws-topic-requests" data-ws-topic-requests-list={topic.handle} aria-busy="true">
        <SkeletonGroup label={t('project:places.topicRequests.loading')} className="dev-ws-topic-requests-card motion-reduce:animate-none">
          {[0, 1, 2].map((i) => (
            <div key={i} className="px-2.5 py-2">
              <Skeleton shape="line" className={i === 1 ? 'w-1/2' : 'w-3/4'} />
              <Skeleton shape="muted" className="mt-2 w-1/3" />
            </div>
          ))}
        </SkeletonGroup>
      </div>
    );
  }

  return (
    <div className="dev-ws-topic-requests" data-ws-topic-requests-list={topic.handle}>
      {lanes.length ? (
        <div className="dev-ws-topic-requests-card">
          {lanes.map(({ lane, rows }) => (
            <div key={lane.key} className={`dev-ws-lane dev-ws-lane-${lane.key}`} data-ws-lane={lane.key}>
              <h4 className="dev-ws-lane-title"><span className="dev-ws-dot" aria-hidden="true"></span>{lane.title}</h4>
              {rows.length ? <WorkList rows={rows} slug={slug} variant="board" category={false} /> : null}
              {lane.more ? <div className="dev-ws-more">{t('project:allItems.lane.more', { count: lane.more })}</div> : null}
            </div>
          ))}
        </div>
      ) : (
        <p className="dev-ws-week-note" data-ws-topic-requests-none="">
          {t('project:places.topicRequests.none')}
        </p>
      )}
      {lanes.length || counted > 0 ? (
        <div className="dev-ws-theme-more">
          <button type="button" className="dev-ws-link" data-ws-topic-requests={topic.handle} onClick={onAll}>
            {t('project:allItems.theme.openOnBoard')}
          </button>
        </div>
      ) : null}
    </div>
  );
}
