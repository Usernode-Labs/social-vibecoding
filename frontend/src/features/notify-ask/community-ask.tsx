import { useTourRunning } from '../first-session/tour-running';
import { NotifyAsk } from './notify-ask';

/*
 * The notification ask on a project's hub, for somebody who is in its
 * community but did not make it: the invited person the walk's last card
 * ("Go to community") lands here, or somebody who joined from Discover.
 *
 * What it promises is what rings for that community. In a small private
 * group (2 to 8 people, services/group-channel-notify.js MAX_GROUP_PEOPLE)
 * every message in its chat notifies everyone, so the promise is the group's
 * messages and the votes it needs. Anywhere bigger only mentions and replies
 * ring, so it is the votes and the replies.
 *
 * Held while a first-session tour is on screen, so it comes up as the walk
 * ends rather than under its last card.
 */

/** services/group-channel-notify.js: the size at which a group's chat rings everyone. */
export const SMALL_GROUP_PEOPLE = 8;

export interface CommunityAskData {
  name?: string;
  is_member: boolean;
  is_creator: boolean;
  audience: 'open' | 'invited' | 'solo';
  member_count: number;
}

/** Whether a community's chat rings every member (a small private group). */
export function ringsEveryone(data: Pick<CommunityAskData, 'audience' | 'member_count'>): boolean {
  return data.audience === 'invited' && data.member_count >= 2 && data.member_count <= SMALL_GROUP_PEOPLE;
}

export function CommunityAsk({ data, name }: { data: CommunityAskData | null | undefined; name: string }) {
  const touring = useTourRunning();
  if (!data || !data.is_member || data.is_creator || touring) return null;
  return <NotifyAsk moment="community" project={data.name || name} small={ringsEveryone(data)} />;
}
