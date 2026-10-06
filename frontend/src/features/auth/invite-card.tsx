/**
 * "Made for you": the landing screen of a visitor who opened an invite link
 * (/invite/<token>, src/services/community-invites.js) while signed out.
 *
 * It is three pieces, top to bottom, each on its own card so each reads as
 * one thing:
 *
 *   who      the project's tile, "Maya made Run Tracker" (or "@ada invited
 *            you to join …" when the sender did not make it), how many
 *            people are in it, and its one-line description (#3700) unless
 *            the picture below is the tile that already carries it;
 *   picture  the project itself: the after-shot of its latest change, else
 *            the Discover card's image, else, while it is built, the
 *            thumbnail of the idea its maker was shown
 *            (../first-session/sketch-card.tsx, drawn here from its words),
 *            else a large tile with its one-line description
 *            (preview().project.picture);
 *   join     the sender's note, when they left one, and the one way in.
 *
 * Everything comes from GET /api/public/invites/:token, which discloses
 * nothing more than the invite offers to share. Joining needs an account:
 * Join opens the sign-in sheet over this screen (./sign-in-sheet.tsx), whose
 * email code makes one or signs into one, and the server follows the link as
 * the account that comes out of it — the page left the token in an HttpOnly
 * cookie (routes/community-invites.js), so nothing here has to carry it.
 * Somebody new lands in the waiting room with the project queued unless the
 * invite tree lets them past.
 *
 * Until the preview is back an invite link shows a quiet placeholder where
 * the cards will be (InvitePending), and nothing at all renders on any other
 * path: the landing is every signed-out visitor's first screen, and only an
 * invite link has anything to say here. While a live link's card is up, or
 * still on its way, the landing hides its own pitch (landing.tsx); a dead
 * link keeps it and says why above it, and so does a preview that could not
 * be read.
 */

import { useEffect, useState } from 'react';

import { Skeleton, SkeletonGroup } from '@/components/ui/skeleton';

import { FeaturedCard, sketchCardOf } from '../first-session/sketch-card';

export type InvitePicture =
  | { kind: 'shot' | 'illustration'; url: string; darkUrl: string | null }
  | { kind: 'sketch'; url?: null; darkUrl?: null; card: unknown };

export type InvitePreview = {
  live: boolean;
  reason: string | null;
  project?: {
    name: string;
    iconEmoji: string | null;
    iconUrl: string | null;
    description?: string | null;
    picture?: InvitePicture | null;
  };
  inviter?: string | null;
  inviterName?: string | null;
  inviterMadeIt?: boolean;
  /** Its first version is still on its way: "Maya is making Run Tracker". */
  building?: boolean;
  /**
   * The community's own name, when it has one apart from its project's.
   * Communities and projects are one-to-one today and a community carries
   * no name of its own (the "Communities" block of src/db/schema.sql), so
   * the server sends none and the card names the project.
   */
  communityName?: string | null;
  note?: string | null;
  memberCount?: number;
};

const DEAD: Record<string, string> = {
  expired: 'This invite link has expired. Ask whoever sent it for a new one.',
  revoked: 'This invite link was turned off. Ask whoever sent it for a new one.',
  used_up: 'This invite link has been used as many times as it allows. Ask whoever sent it for a new one.',
  unknown: 'This invite link does not work. Check it was copied whole.',
};

// The pieces share the landing's card: white on the wallpaper, the sheet
// line as its edge, the 20px radius the sign-in screen's groups use.
const CARD = 'mx-4 rounded-[20px] bg-white dark:bg-zinc-900 p-4 shadow-[inset_0_0_0_1px_var(--app-sheet-line)]';

/** The token of an invite path, or null. Same shape as the server's. */
export function inviteTokenFrom(pathname: string): string | null {
  const m = /^\/invite\/([A-Za-z0-9_-]{22})$/.exec(pathname || '');
  return m ? m[1] : null;
}

/** "@ada invited you to join Game Corner." */
export function invitedLine(preview: InvitePreview): string {
  const name = preview.project?.name || 'a project';
  return preview.inviter ? `@${preview.inviter} invited you to join ${name}.` : `You are invited to join ${name}.`;
}

/**
 * The community a project was made for, when it is named apart from the
 * project, or null. A community with one project shares its name, and "Maya
 * made this for Run Tracker" reads as if the project were made for itself.
 */
export function madeForName(preview: InvitePreview): string | null {
  const community = (preview.communityName || '').trim();
  const project = (preview.project?.name || '').trim();
  return community && community.toLowerCase() !== project.toLowerCase() ? community : null;
}

/**
 * The card's headline. "Maya made Run Tracker" when whoever sent the link
 * made the project — the gift the link is — or "Maya made this for Sunday
 * Run Club" when the community it was made for has a name of its own; the
 * plain invitation otherwise. While its first version is still on its way
 * (`building`) it is "Maya is making Run Tracker": nothing is made yet.
 */
export function madeLine(preview: InvitePreview): string {
  const name = preview.project?.name || 'a project';
  if (preview.inviterMadeIt && preview.inviterName) {
    const community = madeForName(preview);
    const made = preview.building ? 'is making' : 'made';
    return community ? `${preview.inviterName} ${made} this for ${community}` : `${preview.inviterName} ${made} ${name}`;
  }
  return invitedLine(preview);
}

/**
 * WP-E: the link's maker hears when somebody joins through it
 * (src/services/invite-activity.js), so the page says so before they do.
 */
export function seenLine(preview: InvitePreview): string {
  const who = preview.inviterName || (preview.inviter ? `@${preview.inviter}` : '');
  return who ? `${who} will see that you joined.` : '';
}

/** "12 people are in it." or '' for none. */
export function membersLine(count: number | undefined): string {
  if (!count) return '';
  return `${count} ${count === 1 ? 'person is' : 'people are'} in it.`;
}

/** The line under the headline: "and invited you to join · 4 people are in it". */
export function underLine(preview: InvitePreview): string {
  const count = preview.memberCount || 0;
  const members = count ? `${count} ${count === 1 ? 'person is' : 'people are'} in it` : '';
  if (preview.inviterMadeIt && preview.inviterName) {
    return members ? `and invited you to join · ${members}` : 'and invited you to join';
  }
  return members ? `${members}.` : '';
}

// How long the landing waits on a preview before it shows its own pitch
// instead. A preview that arrives later still replaces it.
export const INVITE_PREVIEW_WAIT_MS = 8000;

/**
 * The preview of the invite link this page was opened on, and whether it is
 * still on its way.
 *
 * `preview` is null before it is back, on any other path, or when it could
 * not be read. It is read in an EFFECT, never the first render: the landing's
 * interior hydrates over the prerendered document, which has no invite.
 *
 * `pending` is true from the first render on an invite path until the
 * preview is back, could not be read, or has taken INVITE_PREVIEW_WAIT_MS.
 * Its first value reads the path the way the landing's `onInvitePath` does:
 * it only shapes the interior, which mounts on reveal (lib/mount-on-reveal.ts),
 * and the prerender pass has no location, so there is no markup to mismatch.
 */
export function useInvitePreview(): { preview: InvitePreview | null; pending: boolean } {
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [pending, setPending] = useState(
    () => typeof location !== 'undefined' && !!inviteTokenFrom(location.pathname),
  );
  useEffect(() => {
    const token = inviteTokenFrom(location.pathname);
    if (!token) { setPending(false); return undefined; }
    let live = true;
    const giveUp = setTimeout(() => { if (live) setPending(false); }, INVITE_PREVIEW_WAIT_MS);
    fetch(`/api/public/invites/${encodeURIComponent(token)}`)
      .then((res) => res.json())
      .then((body: InvitePreview) => {
        if (!live) return;
        if (body && typeof body.live === 'boolean') setPreview(body);
        setPending(false);
      })
      .catch(() => { if (live) setPending(false); /* the landing still works without the card */ })
      .finally(() => clearTimeout(giveUp));
    return () => { live = false; clearTimeout(giveUp); };
  }, []);
  return { preview, pending };
}

function Tile({ project, size }: { project: NonNullable<InvitePreview['project']>; size: 'card' | 'hero' }) {
  const box = size === 'hero' ? 'w-20 h-20 rounded-[22px] text-5xl' : 'w-12 h-12 rounded-xl text-2xl';
  return (
    <span className={`app-icon-tile ${box} shrink-0 overflow-hidden flex items-center justify-center`} aria-hidden="true">
      {project.iconUrl ? <img src={project.iconUrl} alt="" className="w-full h-full object-cover" /> : (project.iconEmoji || project.name.slice(0, 1))}
    </span>
  );
}

/**
 * Whether the picture card is the tile with the one-line description in it
 * (Picture's last case): no picture, or a sketch without a card to draw.
 */
export function pictureIsTile(project: Pick<NonNullable<InvitePreview['project']>, 'picture'>): boolean {
  const picture = project.picture;
  if (!picture) return true;
  return picture.kind === 'sketch' ? !sketchCardOf(picture) : false;
}

/**
 * The project as a picture. A shot is phone-shaped, so it shows its top:
 * the part of a screen that says what the project is. An illustration has
 * a dark version when its group made one, and each theme shows its own.
 */
function Picture({ project }: { project: NonNullable<InvitePreview['project']>; building?: boolean }) {
  const picture = project.picture;
  // WP-D: while it is built, the thumbnail of the idea its maker was shown.
  // #4053: without its build line, which needs the step, and the invite
  // knows only that its first version is on its way.
  const card = picture && picture.kind === 'sketch' ? sketchCardOf(picture) : null;
  if (card) {
    return (
      <div data-landing-invite-picture="sketch" className="mx-4 mt-3">
        <FeaturedCard name={project.name} colorKey={project.name} emoji={card.emoji} card={card} />
      </div>
    );
  }
  if (picture && picture.kind !== 'sketch') {
    const img = 'block w-full h-[340px] object-cover object-top';
    return (
      <div data-landing-invite-picture={picture.kind} className="mx-4 mt-3 overflow-hidden rounded-[20px] bg-white dark:bg-zinc-900 shadow-[inset_0_0_0_1px_var(--app-sheet-line)]">
        <img src={picture.url} alt={`${project.name}`} className={picture.darkUrl ? `${img} dark:hidden` : img} />
        {picture.darkUrl ? <img src={picture.darkUrl} alt={`${project.name}`} className={`${img} hidden dark:block`} /> : null}
      </div>
    );
  }
  return (
    <div data-landing-invite-picture="tile" className={`${CARD} mt-3 flex flex-col items-center px-6 py-8 text-center`}>
      <Tile project={project} size="hero" />
      <p className="mt-3 text-[20px] font-bold leading-tight text-zinc-900 dark:text-zinc-100">{project.name}</p>
      {project.description ? (
        <p className="mt-1.5 text-[15px] leading-snug text-zinc-500 dark:text-zinc-400 text-pretty">{project.description}</p>
      ) : null}
    </div>
  );
}

/**
 * Where the cards will be while the preview is on its way: the first card's
 * tile and two lines, and the picture's frame, breathing on one clock. It
 * stands in for the landing's pitch, which an invited visitor should not see
 * first.
 */
export function InvitePending() {
  return (
    <SkeletonGroup label="Opening your invite" data-landing-invite="pending">
      <div className={`${CARD} mt-4 flex items-center gap-3`}>
        <Skeleton shape="block" className="h-12 w-12 rounded-xl" />
        <div className="min-w-0 flex-1">
          <Skeleton className="w-3/4" />
          <Skeleton shape="muted" className="mt-2 w-1/2" />
        </div>
      </div>
      <div className={`${CARD} mt-3 h-[340px]`} />
    </SkeletonGroup>
  );
}

/** A dead link's one sentence, above the landing's own pitch. */
export function DeadInvite({ preview }: { preview: InvitePreview }) {
  return (
    <section data-landing-invite="dead" className="mx-4 mt-4 rounded-[20px] bg-white/80 dark:bg-zinc-900/80 p-4 text-[15px] text-zinc-600 dark:text-zinc-300">
      {DEAD[preview.reason || 'unknown'] || DEAD.unknown}
    </section>
  );
}

export function MadeForYou({ preview, primaryClass, onJoin }: {
  preview: InvitePreview;
  primaryClass: string;
  /** Opens the sign-in sheet over this screen (./sign-in-sheet.tsx). */
  onJoin: () => void;
}) {
  const project = preview.project!;
  const under = underLine(preview);
  const seen = seenLine(preview);
  // An anchor to the email-code screen, so it still works before the
  // script that opens the sheet has; the sheet takes the tap once it has.
  const join = (
    <a
      href="#signup"
      data-landing-invite-signup=""
      className={primaryClass}
      onClick={(e) => { e.preventDefault(); onJoin(); }}
    >
      {`Join ${project.name}`}
    </a>
  );
  const seenNote = seen
    ? <p data-landing-invite-seen="" className="mt-2 text-center text-[13px] text-zinc-500 dark:text-zinc-400">{seen}</p>
    : null;
  return (
    <>
      <section data-landing-invite="live" className={`${CARD} mt-4`}>
        <div className="flex items-center gap-3">
          <Tile project={project} size="card" />
          <div className="min-w-0">
            <p className="text-[15px] font-[650] leading-snug text-zinc-900 dark:text-zinc-100">{madeLine(preview)}</p>
            {under ? <p className="text-[13px] text-zinc-500 dark:text-zinc-400">{under}</p> : null}
          </div>
        </div>
        {/* #3700: what it is, in its own line, beside the icon and the count:
            the same proof the project's page gives somebody signed in. Not
            when the picture below is the tile, which carries it already. */}
        {project.description && !pictureIsTile(project) ? (
          <p data-landing-invite-description="" className="mt-3 text-[15px] leading-snug text-zinc-700 dark:text-zinc-200 text-pretty">
            {project.description}
          </p>
        ) : null}
      </section>
      <Picture project={project} building={!!preview.building} />
      {preview.note ? (
        <section data-landing-invite-join="" className={`${CARD} mt-3`}>
          <p data-landing-invite-note="" className="rounded-2xl bg-violet-500/10 px-4 py-3 text-[15px] leading-snug text-zinc-700 dark:text-zinc-200">
            <span className="font-medium">{`${preview.inviterName || (preview.inviter ? `@${preview.inviter}` : 'They')}:`}</span>
            {` “${preview.note}”`}
          </p>
          <div className="mt-4">{join}</div>
          {seenNote}
        </section>
      ) : (
        <div data-landing-invite-join="" className="mx-4 mt-4">{join}{seenNote}</div>
      )}
    </>
  );
}
