/**
 * `#dev-topic-card` — the topic head's card slot — the noNav variant of
 * whichever card the opened topic is.
 *
 * `_renderTopicHead` still owns the REST of the head: it innerHTMLs
 * `#gc-thread-head` with this empty slot plus the module-built body
 * (detail actions, issue body / proposal details, transcript section),
 * then mounts this component into the slot and publishes the model. Every
 * WS-driven repaint rebuilds the host, so this mounts per paint and the
 * previous host's portal entry is swept as detached (lib/legacy-portals).
 */

import type { ReactNode } from 'react';

import { useStoreState } from '../../../lib/use-store-state';
import { topicCardStore } from './cards-store';
import { DevCard } from './dev-card';

export function TopicCard(): ReactNode {
  const { card } = useStoreState(topicCardStore);
  if (!card) return null;
  return <DevCard model={card} />;
}
