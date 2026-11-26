/**
 * #5303: MUTE for a project's Discussion (its #general).
 *
 * #general had a line above its room: what it is for, how many members it
 * reaches, and Mute. The room is the Discussion now (26 Nov 2026), whose
 * page head says what it is for, so what is left of the line is Mute, at
 * the end of that head (hub-discussion.tsx, page mode).
 *
 * MUTE is the viewer's own (services/channel-mutes.js): the Discussion's
 * unread stops counting on the places list, the bar's dot and the sidebar,
 * and a small group's "every message" ring passes them by. Mentions and
 * replies still reach them, as the button's hover text says. It is drawn for
 * a signed-in viewer whose record says whether the channel is muted (the
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

export function ChannelMute({ slug, data }: {
  slug: string;
  data: CommunityPayload | null;
}): ReactNode {
  const t = useMessages('project');
  const known = generalMuted(data);
  const [muted, setMuted] = useState<boolean | null>(known);
  const [busy, setBusy] = useState(false);
  // The record is the truth once it lands or is read again.
  useEffect(() => { setMuted(known); }, [known]);

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

  if (muted == null) return null;
  return (
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
  );
}
