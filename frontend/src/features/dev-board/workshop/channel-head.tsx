/**
 * #5303: #general's LINE, above its room.
 *
 * The navigation review of 15 October found #general drawn with its name
 * alone: nothing said what the channel is for, how many people it reaches,
 * or how to quiet it. This is the line a topic has (./topic-head.tsx), for
 * #general: what it is for, then how many members it reaches, in 13px
 * muted text, with Mute at its end.
 *
 *   Everyone in Homeroom talks here · 263 members          [🔔 Mute]
 *
 * The channel's name is the bar's (a phone) or the page title's (desktop),
 * so the line does not say it again. A zero says nothing (AGENTS.md): no
 * member count before the record has one.
 *
 * MUTE is the viewer's own (services/channel-mutes.js): the channel's unread
 * stops counting on the places list, the bar's dot and the sidebar, and a
 * small group's "every message" ring passes them by. Mentions and replies
 * still reach them, as the button's hover text says. It is drawn for a
 * signed-in viewer whose record says whether the channel is muted (the
 * places block), and pressed it turns at once, writes, and turns back if
 * the write is refused.
 */

import { useEffect, useState, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { BellIcon } from '@/components/ui/icons';

import { useMessages } from '../../../lib/i18n/react';
import { reloadCommunity, type CommunityPayload } from './community-card';
import { channelsOf } from './places';

/** Whether #general is muted for this viewer, or null when the record does not say. Pure. */
export function generalMuted(data: CommunityPayload | null | undefined): boolean | null {
  const general = channelsOf(data?.places).find((c) => c.kind === 'general');
  if (!general || typeof general.muted !== 'boolean') return null;
  return general.muted;
}

export function ChannelHead({ slug, name, data }: {
  slug: string;
  /** The project's name, as the page says it. */
  name: string;
  data: CommunityPayload | null;
}): ReactNode {
  const t = useMessages('project');
  const known = generalMuted(data);
  const [muted, setMuted] = useState<boolean | null>(known);
  const [busy, setBusy] = useState(false);
  // The record is the truth once it lands or is read again.
  useEffect(() => { setMuted(known); }, [known]);

  const members = Math.max(0, Number(data?.member_count) || 0);
  const about = t('project:places.generalHead.about', { project: name });
  const line = members > 0
    ? t('project:places.generalHead.aboutThenMembers', { about, members: t('project:places.generalHead.members', { count: members }) })
    : about;

  const toggle = async () => {
    if (busy || muted == null) return;
    const next = !muted;
    setMuted(next);
    setBusy(true);
    try {
      const res = await fetch(`/api/apps/${encodeURIComponent(slug)}/channels/general/mute`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ muted: next }),
      });
      if (!res.ok) throw new Error(String(res.status));
      // The places list's count and the bar's dot are the record's.
      void reloadCommunity(slug);
    } catch {
      setMuted(!next);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dev-ws-channel-head" data-ws-channel-head="general">
      <p className="dev-ws-topic-head dev-ws-channel-head-line">{line}</p>
      {muted != null ? (
        <Button
          type="button"
          variant="pillNeutral"
          size="sm"
          ink="neutral"
          layout="iconRow"
          className="dev-ws-channel-mute shrink-0"
          data-ws-channel-mute={muted ? 'on' : 'off'}
          aria-pressed={muted}
          disabled={busy}
          title={muted ? t('project:places.generalHead.unmuteHint') : t('project:places.generalHead.muteHint')}
          onClick={() => { void toggle(); }}
        >
          <BellIcon className="h-4 w-4" aria-hidden="true" />
          {muted ? t('project:places.generalHead.muted') : t('project:places.generalHead.mute')}
        </Button>
      ) : null}
    </div>
  );
}
