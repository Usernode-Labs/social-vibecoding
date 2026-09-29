/**
 * The invite card at the top of the landing screen, for a visitor who opened
 * an invite link (/invite/<token>, src/services/community-invites.js) while
 * signed out.
 *
 * It names the project, who invited them and how many people are in it —
 * GET /api/public/invites/:token, which discloses nothing else — and offers
 * the two ways in: sign up (the email-code step, #signup) or sign in. Either
 * way the server follows the link as the account that comes out of it: the
 * page left the token in an HttpOnly cookie (routes/community-invites.js),
 * so nothing here has to carry it. Somebody new lands in the waiting room
 * with the project queued (unless the invite tree lets them past, which is
 * off today), which is what the card's last line says, as a "may".
 *
 * Nothing renders until the preview is back, and nothing at all on any
 * other path: the landing is every signed-out visitor's first screen, and
 * only an invite link has anything to say here.
 */

import { useEffect, useState } from 'react';

type Preview = {
  live: boolean;
  reason: string | null;
  project?: { name: string; iconEmoji: string | null; iconUrl: string | null };
  inviter?: string | null;
  memberCount?: number;
};

const DEAD: Record<string, string> = {
  expired: 'This invite link has expired. Ask whoever sent it for a new one.',
  revoked: 'This invite link was turned off. Ask whoever sent it for a new one.',
  used_up: 'This invite link has been used as many times as it allows. Ask whoever sent it for a new one.',
  unknown: 'This invite link does not work. Check it was copied whole.',
};

/** The token of an invite path, or null. Same shape as the server's. */
export function inviteTokenFrom(pathname: string): string | null {
  const m = /^\/invite\/([A-Za-z0-9_-]{22})$/.exec(pathname || '');
  return m ? m[1] : null;
}

/** "@ada invited you to join Game Corner." */
export function invitedLine(preview: Preview): string {
  const name = preview.project?.name || 'a project';
  return preview.inviter ? `@${preview.inviter} invited you to join ${name}.` : `You are invited to join ${name}.`;
}

/** "12 people are in it." or '' for none. */
export function membersLine(count: number | undefined): string {
  if (!count) return '';
  return `${count} ${count === 1 ? 'person is' : 'people are'} in it.`;
}

export function InviteCard({ primaryClass, secondaryClass }: { primaryClass: string; secondaryClass: string }) {
  const [preview, setPreview] = useState<Preview | null>(null);

  useEffect(() => {
    const token = inviteTokenFrom(location.pathname);
    if (!token) return undefined;
    let live = true;
    fetch(`/api/public/invites/${encodeURIComponent(token)}`)
      .then((res) => res.json())
      .then((body: Preview) => { if (live && body && typeof body.live === 'boolean') setPreview(body); })
      .catch(() => { /* the landing still works without the card */ });
    return () => { live = false; };
  }, []);

  if (!preview) return null;
  if (!preview.live) {
    return (
      <section data-landing-invite="dead" className="mx-4 mt-4 rounded-[20px] bg-white/80 dark:bg-zinc-900/80 p-4 text-[15px] text-zinc-600 dark:text-zinc-300">
        {DEAD[preview.reason || 'unknown'] || DEAD.unknown}
      </section>
    );
  }
  const project = preview.project!;
  return (
    <section
      data-landing-invite="live"
      className="mx-4 mt-4 rounded-[20px] bg-white dark:bg-zinc-900 p-4 shadow-[inset_0_0_0_1px_var(--app-sheet-line)]"
    >
      <div className="flex items-center gap-3">
        <span className="app-icon-tile w-12 h-12 shrink-0 rounded-xl overflow-hidden flex items-center justify-center text-2xl" aria-hidden="true">
          {project.iconUrl ? <img src={project.iconUrl} alt="" className="w-full h-full object-cover" /> : (project.iconEmoji || project.name.slice(0, 1))}
        </span>
        <div className="min-w-0">
          <p className="text-[15px] font-[650] leading-snug text-zinc-900 dark:text-zinc-100">{invitedLine(preview)}</p>
          {membersLine(preview.memberCount) ? (
            <p className="text-[13px] text-zinc-500 dark:text-zinc-400">{membersLine(preview.memberCount)}</p>
          ) : null}
        </div>
      </div>
      <div className="mt-4 flex flex-col gap-2.5 md:grid md:grid-cols-2">
        <a href="#signup" data-landing-invite-signup="" className={primaryClass}>Sign up to join</a>
        <a href="#login" className={secondaryClass}>I have an account</a>
      </div>
      <p className="mt-3 text-[13px] text-zinc-500 dark:text-zinc-400">
        {`New to Homeroom? You may join the waitlist first, and ${project.name} when you are let in.`}
      </p>
    </section>
  );
}
