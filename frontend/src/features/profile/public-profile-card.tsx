import { openReport } from '../dialogs/report';
/**
 * The opt-in public profile card (#582) and its report form, as React
 * (#1191 slice 6, conversion 1).
 *
 * Two callers, and the difference between them is the whole reason this takes
 * an `allowReport` prop: `#profile/<username>` renders someone else's page and
 * offers the report affordance, while the owner's own "Preview" button renders
 * the identical card inside `#public-profile-preview` with the affordance off —
 * reporting yourself is not a thing.
 *
 * The avatar keeps its layout trick: the initial sits in the box and the photo
 * is absolutely positioned over it, so a failed load drops the image and
 * reveals the fallback without shifting anything. The legacy code did that by
 * removing the <img> from an error listener; here the listener sets state and
 * React stops rendering it, which is the same result through the owner React
 * has to be for the island rule to hold.
 */

import { useState, type ReactNode } from 'react';

import { publicAvatarView, verifiedSocialLinksView } from './profile-store.js';
function PublicAvatar({ profile }: { profile: any }): ReactNode {
  const { initial, url } = publicAvatarView(profile);
  const [failed, setFailed] = useState(false);
  return (
    <div
      className={
        'w-20 h-20 relative rounded-full overflow-hidden bg-violet-100 '
        + 'dark:bg-violet-950 flex items-center justify-center text-violet-700  dark:text-violet-400'
        + 'dark:text-violet-300 text-2xl font-bold shrink-0'
      }
    >
      {initial}
      {url && !failed ? (
        <img
          className="absolute inset-0 w-full h-full object-cover"
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          src={url}
          onError={() => setFailed(true)}
        />
      ) : null}
    </div>
  );
}

function ReportForm({ username }: { username: string }): ReactNode {
  return <div id="public-profile-report" className="mt-4 text-sm"><button type="button" className="min-h-[44px] text-red-700 dark:text-red-400" onClick={() => openReport({ targetType: 'user', target: username, label: `@${username}` })}>Report user</button></div>;
}

export function PublicProfileCard({
  profile,
  allowReport,
}: {
  profile: any;
  allowReport: boolean;
}): ReactNode {
  const socialLinks = verifiedSocialLinksView(profile);
  return (
    <>
      <article
        id="public-profile-card"
        className="rounded-2xl bg-white dark:bg-zinc-900 p-5"
      >
        <div className="flex items-start gap-4">
          <PublicAvatar profile={profile} />
          <div className="min-w-0 flex-1">
            <h2 className="text-xl font-bold break-words">
              {profile.displayName || profile.username}
            </h2>
            <div className="text-sm text-zinc-500 dark:text-zinc-400 break-all">
              {`@${profile.username}`}
            </div>
            {profile.bio ? (
              <p className="mt-3 text-sm whitespace-pre-wrap break-words">{profile.bio}</p>
            ) : null}
            {socialLinks.length ? (
              <div className="flex flex-wrap items-center gap-2 mt-3">
                {socialLinks.map((link) => (
                  <a
                    key={link.key}
                    className={link.className}
                    href={link.href}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {link.label}
                  </a>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      </article>
      {allowReport ? <ReportForm username={profile.username} /> : null}
    </>
  );
}
