/**
 * "Made for you": the landing screen of a visitor who opened an invite link
 * (/invite/<token>, src/services/community-invites.js) while signed out.
 *
 * It is three pieces, top to bottom (#4203):
 *
 *   hero     one card: the project's tile and name, and under them the
 *            invitation, "Evan invited you to Supply Line · 26 people are in
 *            it" (inviteLine), then its one-line description (#3700). It
 *            leads with who invited you, not who made it, and the icon shows
 *            once;
 *   picture  the project itself, when there is more to show than the tile:
 *            the after-shot of its latest change, else the Discover card's
 *            image, else, while it is built, the featured card of the idea
 *            its maker was shown (../first-session/sketch-card.tsx, drawn
 *            here from its words) (preview().project.picture), and the
 *            sender's note when they left one;
 *   join     "Join Supply Line" and "Evan will see that you joined.", pinned
 *            to the bottom of the screen where a phone page keeps its main
 *            action (InviteJoinBar). The landing draws it OUTSIDE its
 *            scroller, below it, so it stays in reach however long the page
 *            is and can never cover its last line, and it clears the
 *            home-indicator strip itself.
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
    /** A public community: its Join asks for a username, not a name. */
    public?: boolean;
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
 * Who sent the link, as the page names them: their display name where they
 * have one, else their handle with its @. The preview's `inviterName` is the
 * display name, or the handle when there is none (services/community-
 * invites.js preview()), so a name equal to the handle is the handle.
 */
export function inviterLabel(preview: Pick<InvitePreview, 'inviter' | 'inviterName'>): string {
  const name = (preview.inviterName || '').trim();
  const handle = (preview.inviter || '').trim();
  if (name && name !== handle) return name;
  return handle ? `@${handle}` : name;
}

/** "26 people are in it", "1 person is in it", or '' for none. */
export function membersPhrase(count: number | undefined): string {
  if (!count || count < 1) return '';
  return `${count} ${count === 1 ? 'person is' : 'people are'} in it`;
}

/**
 * The hero's line under the project's name (#4203): the invitation first,
 * then how many are in it. "Evan invited you to Supply Line · 26 people are
 * in it"; "You're invited to Supply Line" when the sender is not known; a
 * zero count says nothing.
 */
export function inviteLine(preview: InvitePreview): string {
  const name = preview.project?.name || 'a project';
  const who = inviterLabel(preview);
  const invited = who ? `${who} invited you to ${name}` : `You're invited to ${name}`;
  const members = membersPhrase(preview.memberCount);
  return members ? `${invited} · ${members}` : invited;
}

/**
 * WP-E: the link's maker hears when somebody joins through it
 * (src/services/invite-activity.js), so the page says so before they do.
 */
export function seenLine(preview: Pick<InvitePreview, 'inviter' | 'inviterName'>): string {
  const who = inviterLabel(preview);
  return who ? `${who} will see that you joined.` : '';
}

/** "12 people are in it." or '' for none. */
export function membersLine(count: number | undefined): string {
  const members = membersPhrase(count);
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

function Tile({ project }: { project: NonNullable<InvitePreview['project']> }) {
  return (
    <span className={`app-icon-tile w-20 h-20 rounded-[22px] text-5xl shrink-0 overflow-hidden flex items-center justify-center`} aria-hidden="true">
      {project.iconUrl ? <img src={project.iconUrl} alt="" className="w-full h-full object-cover" /> : (project.iconEmoji || project.name.slice(0, 1))}
    </span>
  );
}

/**
 * Whether the hero is all the picture there is: no picture, or a sketch
 * without a card to draw. The hero then carries `data-landing-invite-picture
 * ="tile"` and Picture draws nothing.
 */
export function pictureIsTile(project: Pick<NonNullable<InvitePreview['project']>, 'picture'>): boolean {
  const picture = project.picture;
  if (!picture) return true;
  return picture.kind === 'sketch' ? !sketchCardOf(picture) : false;
}

/**
 * The project as a picture, under the hero. A shot is phone-shaped, so it shows its top:
 * the part of a screen that says what the project is. An illustration has
 * a dark version when its group made one, and each theme shows its own.
 */
function Picture({ project, building = false }: { project: NonNullable<InvitePreview['project']>; building?: boolean }) {
  const picture = project.picture;
  // WP-D: while it is built, the card of the idea its maker was shown:
  // "Being made" while its first version is on its way, no pill otherwise.
  const card = picture && picture.kind === 'sketch' ? sketchCardOf(picture) : null;
  if (card) {
    return (
      <div data-landing-invite-picture="sketch" className="mx-4 mt-3">
        <FeaturedCard name={project.name} colorKey={project.name} emoji={card.emoji} card={card} stage={building ? 'making' : 'plain'} />
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
  // The tile is the hero's own (MadeForYou): the icon shows once.
  return null;
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

/**
 * The scrolling part of a live link's page: the hero, the picture and the
 * note. Join is not in it: it is InviteJoinBar, pinned below the scroller.
 */
export function MadeForYou({ preview }: { preview: InvitePreview }) {
  const project = preview.project!;
  const tile = pictureIsTile(project);
  return (
    <>
      {/* #4203: one hero, the tile and name with the invitation under them,
          instead of a "who made it" card above a second copy of the icon. */}
      <section
        data-landing-invite="live"
        data-landing-invite-picture={tile ? 'tile' : undefined}
        className={`${CARD} mt-4 flex flex-col items-center px-6 py-8 text-center`}
      >
        <Tile project={project} />
        <p className="mt-3 text-[20px] font-bold leading-tight text-zinc-900 dark:text-zinc-100">{project.name}</p>
        <p data-landing-invite-line="" className="mt-1.5 text-[15px] leading-snug text-zinc-500 dark:text-zinc-400 text-pretty">
          {inviteLine(preview)}
        </p>
        {/* #3700: what it is, in its own line: the same proof the project's
            page gives somebody signed in. */}
        {project.description ? (
          <p data-landing-invite-description="" className="mt-3 text-[15px] leading-snug text-zinc-700 dark:text-zinc-200 text-pretty">
            {project.description}
          </p>
        ) : null}
      </section>
      <Picture project={project} building={!!preview.building} />
      {preview.note ? (
        <section className={`${CARD} mt-3`}>
          <p data-landing-invite-note="" className="rounded-2xl bg-violet-500/10 px-4 py-3 text-[15px] leading-snug text-zinc-700 dark:text-zinc-200">
            <span className="font-medium">{`${inviterLabel(preview) || 'They'}:`}</span>
            {` “${preview.note}”`}
          </p>
        </section>
      ) : null}
    </>
  );
}

/**
 * "Join Supply Line", pinned to the bottom of the screen (#4203). The
 * landing renders it as the column's last child, BELOW its scroller rather
 * than over it, so however long the page grows (a description, a note, a
 * shot) the action stays in reach and the scroller simply ends above it:
 * nothing it draws can be covered. Its own bottom padding clears the
 * home-indicator strip (--platform-safe-bottom, which is
 * env(safe-area-inset-bottom) unless the native kit reports its own), and
 * the fixed column it sits in ends where Safari's toolbar begins.
 */
export function InviteJoinBar({ preview, primaryClass, onJoin }: {
  preview: InvitePreview;
  primaryClass: string;
  /** Opens the sign-in sheet over this screen (./sign-in-sheet.tsx). */
  onJoin: () => void;
}) {
  const project = preview.project!;
  const seen = seenLine(preview);
  return (
    <div
      data-landing-invite-join=""
      className="shrink-0 border-t border-[color:var(--app-sheet-line)] bg-white dark:bg-zinc-950 px-4 pt-3"
      style={{ paddingBottom: 'calc(0.75rem + var(--platform-safe-bottom, env(safe-area-inset-bottom, 0px)))' }}
    >
      <div className="max-w-sm md:max-w-lg xl:max-w-2xl mx-auto">
        {/* An anchor to the email-code screen, so it still works before the
            script that opens the sheet has; the sheet takes the tap once it has. */}
        <a
          href="#signup"
          data-landing-invite-signup=""
          className={primaryClass}
          onClick={(e) => { e.preventDefault(); onJoin(); }}
        >
          {`Join ${project.name}`}
        </a>
        {seen ? <p data-landing-invite-seen="" className="mt-2 text-center text-[13px] text-zinc-500 dark:text-zinc-400">{seen}</p> : null}
      </div>
    </div>
  );
}
