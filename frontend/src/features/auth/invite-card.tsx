/**
 * "Made for you": the landing screen of a visitor who opened an invite link
 * (/invite/<token>, src/services/community-invites.js) while signed out.
 *
 * It is three pieces, top to bottom, each on its own card so each reads as
 * one thing:
 *
 *   who      the project's tile, "Maya made this for Sunday Run Club" (or
 *            "@ada invited you to join …" when the sender did not make it),
 *            and how many people are in it;
 *   picture  the project itself: the after-shot of its latest change, else
 *            the Discover card's image, else the sketch its maker was shown
 *            while it is built (a sandboxed page: no script, its own origin),
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
 * Nothing renders until the preview is back, and nothing at all on any
 * other path: the landing is every signed-out visitor's first screen, and
 * only an invite link has anything to say here. While a live link's card is
 * up, the landing hides its own pitch (landing.tsx); a dead link keeps it
 * and says why above it.
 */

import { useEffect, useState } from 'react';

export type InvitePicture = { kind: 'shot' | 'illustration' | 'sketch'; url: string; darkUrl: string | null };

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
 * The card's headline. "Maya made this for Sunday Run Club" when whoever
 * sent the link made the project — the gift the link is — and the plain
 * invitation otherwise.
 */
export function madeLine(preview: InvitePreview): string {
  const name = preview.project?.name || 'a project';
  if (preview.inviterMadeIt && preview.inviterName) return `${preview.inviterName} made this for ${name}`;
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

/**
 * The preview of the invite link this page was opened on, or null — before
 * it is back, on any other path, or when it could not be read. Read in an
 * EFFECT, never the first render: the landing's interior hydrates over the
 * prerendered document, which has no invite.
 */
export function useInvitePreview(): InvitePreview | null {
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  useEffect(() => {
    const token = inviteTokenFrom(location.pathname);
    if (!token) return undefined;
    let live = true;
    fetch(`/api/public/invites/${encodeURIComponent(token)}`)
      .then((res) => res.json())
      .then((body: InvitePreview) => { if (live && body && typeof body.live === 'boolean') setPreview(body); })
      .catch(() => { /* the landing still works without the card */ });
    return () => { live = false; };
  }, []);
  return preview;
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
 * The project as a picture. A shot is phone-shaped, so it shows its top:
 * the part of a screen that says what the project is. An illustration has
 * a dark version when its group made one, and each theme shows its own.
 */
function Picture({ project }: { project: NonNullable<InvitePreview['project']> }) {
  const picture = project.picture;
  if (picture && picture.kind === 'sketch') {
    // WP-D: the page is drawn in this screen's look, read once: it is
    // static, and the screen does not stay up long.
    const dark = typeof document !== 'undefined' && document.documentElement.classList.contains('dark');
    return (
      <div data-landing-invite-picture="sketch" className="relative mx-4 mt-3 h-[340px] overflow-hidden rounded-[20px] bg-white dark:bg-zinc-900 shadow-[inset_0_0_0_1px_var(--app-sheet-line)]">
        <iframe
          title={`A sketch of ${project.name}`}
          src={`${picture.url}?theme=${dark ? 'dark' : 'light'}`}
          sandbox=""
          referrerPolicy="no-referrer"
          className="h-full w-full border-0"
        />
        <span className="pointer-events-none absolute right-2 top-2 rounded-full bg-black/60 px-2 py-0.5 text-[12px] font-semibold text-white">Sketch</span>
      </div>
    );
  }
  if (picture) {
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
      </section>
      <Picture project={project} />
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
