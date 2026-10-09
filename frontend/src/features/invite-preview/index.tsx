/**
 * A private community's invite preview (#3700).
 *
 * Somebody signed in and not in a private community, following a live
 * invite link to it, was asked "Join <name>?" over Home. The community's own
 * page is for its members (services/app-access.js), and following a link
 * does not change that: a link holder is not a member until they press
 * Join. So instead of its page they see this one, drawn from the link's
 * standing alone (GET /api/invite-links/by-token/:token, which answers only
 * for a live link: services/community-invites.js entryFor).
 *
 *   SHOWN  the header in the community's colour, its icon and its name;
 *          "Private community · N members", a count with no faces; its
 *          one-line description; who invited them and their note; "Join
 *          <name>".
 *   NOT    any member but the inviter, any item, the trend, the discussion,
 *          Open app, the project's address. Nothing here reads the project,
 *          and every read of it would be refused anyway until Join.
 *
 * Join follows the link (../dev-board/workshop/invite-offer.ts joinByInvite),
 * so a use is spent and the inviter hears; the preview goes, and the shell
 * lands them where a Join lands (App._landJoined: Needs you at its first
 * card when votes are waiting, else the hub). The back arrow is Not now,
 * and so is Escape. The address under it is Home's, never the link's, so
 * Back leaves for wherever they were and a reload is Home.
 *
 * App._followInvite opens it through window.UsernodeReact.invitePreview.
 * It renders nothing until opened, so it adds nothing to the prerendered
 * shell, and the link's token lives only in its state.
 */

import { useEffect, useState } from 'react';

import { ChevronLeftIcon } from '@/components/ui/icons';

import { GRAPHITE, useResolvedCommunityColor } from '../../lib/community-color';
import { HeroPeople, InviteCard } from '../dev-board/workshop/community-card';
import { useMessages } from '../../lib/i18n/react';
import { joinByInvite, type InviteOffer } from '../dev-board/workshop/invite-offer';

export type InvitePreviewInfo = Pick<
  InviteOffer,
  'token' | 'name' | 'inviter' | 'inviterName' | 'inviterMadeIt' | 'building' | 'note' | 'welcome' | 'settle'
> & {
  iconEmoji: string | null;
  iconUrl: string | null;
  /** The colour its dapp.json sets, or null to read one off the icon. */
  iconColor: string | null;
  description: string | null;
  memberCount: number;
  audienceLabel: string;
  /** Where a Join lands, "You're in." already said (App._landJoined). */
  land?: ((slug: string) => void) | null;
};

/** Why there is nothing more to see: the rest is the members'. */
// A message id: the page reads it when it renders.
export const CLOSED_LINE = 'auth:invitePreview.closed';

export function InvitePreviewPage({ info, busy, onJoin, onClose }: {
  info: InvitePreviewInfo;
  busy: boolean;
  onJoin: () => void;
  onClose: () => void;
}) {
  const t = useMessages('auth');
  // The colour the community's own header wears (lib/community-color.ts),
  // from what the link's standing says of its icon. With no icon at all it
  // picks from the name: the project's address is not the preview's to know.
  const tint = useResolvedCommunityColor({
    color: info.iconColor, iconUrl: info.iconUrl, iconEmoji: info.iconEmoji, key: info.name,
  }) || GRAPHITE;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="invite-preview-name"
      data-invite-preview=""
      className="fixed inset-0 z-[8000] flex flex-col overflow-y-auto"
      style={{ background: 'var(--home-ground, var(--bg-primary))' }}
    >
      <header
        className="flex shrink-0 items-center gap-2 px-2 pb-2 text-white"
        style={{ background: tint, paddingTop: 'calc(env(safe-area-inset-top, 0px) + 8px)' }}
        data-invite-preview-header=""
      >
        <button
          type="button"
          aria-label={t('auth:invitePreview.notNow')}
          data-invite-preview-close=""
          onClick={onClose}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-white"
        >
          <ChevronLeftIcon className="h-6 w-6" aria-hidden="true" />
        </button>
        <span className="app-icon-tile flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-lg text-lg" aria-hidden="true">
          {info.iconUrl ? <img src={info.iconUrl} alt="" className="h-full w-full object-cover" /> : (info.iconEmoji || info.name.slice(0, 1))}
        </span>
        <h1 id="invite-preview-name" className="min-w-0 truncate text-[17px] font-semibold">{info.name}</h1>
      </header>
      <div className="mx-auto w-full max-w-xl px-4 pb-8 pt-4">
        <section className="dev-ws-hero" data-ws-invite-preview="">
          <InviteCard offer={info} name={info.name} busy={busy} onJoin={onJoin} />
          <HeroPeople members={[]} count={info.memberCount} audience="invited" audienceLabel={info.audienceLabel} />
          {info.description ? (
            <p className="dev-ws-hero-desc" data-invite-preview-description="">{info.description}</p>
          ) : null}
          <p className="dev-ws-hero-line" data-invite-preview-closed="">{t(CLOSED_LINE)}</p>
        </section>
      </div>
    </div>
  );
}

export function InvitePreview() {
  const [info, setInfo] = useState<InvitePreviewInfo | null>(null);
  const [busy, setBusy] = useState(false);

  // The bridge App._followInvite calls. open() answers whether it showed,
  // so the follow can ask its confirm instead when it did not.
  useEffect(() => {
    const w = window as any;
    w.UsernodeReact = w.UsernodeReact || {};
    const api = {
      // A link's token, or the `?shot=invite-preview` capture, which follows
      // nothing (App._applyInviteJoinShot).
      open(next: InvitePreviewInfo & { preview?: boolean }): boolean {
        if (!next || (!next.token && !next.preview)) return false;
        setBusy(false);
        setInfo(next);
        return true;
      },
    };
    w.UsernodeReact.invitePreview = api;
    return () => { if (w.UsernodeReact?.invitePreview === api) delete w.UsernodeReact.invitePreview; };
  }, []);

  // Not now: the preview goes, and the follow ends with nobody joined.
  const close = () => {
    if (!info) return;
    info.settle?.(false);
    setInfo(null);
  };

  useEffect(() => {
    if (!info) return undefined;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [info]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!info) return null;

  const join = async () => {
    if (busy) return;
    setBusy(true);
    const result = await joinByInvite(info).finally(() => setBusy(false));
    if (result.outcome === 'failed') return;
    setInfo(null);
    // The link died while they looked: the toast said why, and the follow
    // ends as a Not now.
    if (result.outcome === 'dead') { info.settle?.(false); return; }
    if (result.outcome === 'joined' && result.slug) info.land?.(result.slug);
  };

  return <InvitePreviewPage info={info} busy={busy} onJoin={() => { void join(); }} onClose={close} />;
}
