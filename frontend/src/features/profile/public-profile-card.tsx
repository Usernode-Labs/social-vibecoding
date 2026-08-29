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

import { publicAvatarView } from './profile-store.js';
import { Profile } from './profile.js';

const REPORT_REASONS: Array<[string, string]> = [
  ['impersonation', 'Impersonation'],
  ['harassment', 'Harassment'],
  ['spam', 'Spam'],
  ['unsafe_avatar', 'Unsafe avatar'],
  ['other', 'Other'],
];

function PublicAvatar({ profile }: { profile: any }): ReactNode {
  const { initial, url } = publicAvatarView(profile);
  const [failed, setFailed] = useState(false);
  return (
    <div
      className={
        'w-20 h-20 relative rounded-full overflow-hidden bg-zinc-200 '
        + 'dark:bg-zinc-700 flex items-center justify-center text-zinc-700 dark:text-zinc-200 '
        + 'text-2xl font-bold shrink-0'
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
  const [reason, setReason] = useState('impersonation');
  const [detail, setDetail] = useState('');
  const [status, setStatus] = useState('');
  const [sending, setSending] = useState(false);

  const send = async (): Promise<void> => {
    setSending(true);
    setStatus('Sending…');
    const result = await Profile.sendReport(username, reason, detail);
    setStatus(result.status);
    if (!result.ok) setSending(false);
  };

  return (
    <details id="public-profile-report" className="mt-4 text-sm">
      <summary className="cursor-pointer text-zinc-500 dark:text-zinc-300">Report profile</summary>
      <label className="block mt-3 text-xs font-medium">
        Reason
        <select
          className={
            'mt-1 w-full rounded-lg border border-zinc-300 dark:border-zinc-700 '
            + 'bg-transparent p-2 min-h-[44px]'
          }
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        >
          {REPORT_REASONS.map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
      </label>
      <label className="block mt-3 text-xs font-medium">
        Details (optional)
        <textarea
          className={
            'mt-1 w-full rounded-lg border border-zinc-300 dark:border-zinc-700 '
            + 'bg-transparent p-2'
          }
          maxLength={500}
          rows={3}
          value={detail}
          onChange={(e) => setDetail(e.target.value)}
        >
        </textarea>
      </label>
      <button
        type="button"
        className={
          'mt-3 px-3 min-h-[44px] rounded-lg border border-zinc-300 '
          + 'dark:border-zinc-700 font-medium'
        }
        disabled={sending}
        onClick={() => { void send(); }}
      >
        Send report
      </button>
      <div className="mt-2 text-xs text-zinc-500 dark:text-zinc-300" role="status" aria-live="polite">{status}</div>
    </details>
  );
}

export function PublicProfileCard({
  profile,
  allowReport,
}: {
  profile: any;
  allowReport: boolean;
}): ReactNode {
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
            <div className="text-sm text-zinc-500 dark:text-zinc-300 break-all">
              {`@${profile.username}`}
            </div>
            {profile.bio ? (
              <p className="mt-3 text-sm whitespace-pre-wrap break-words">{profile.bio}</p>
            ) : null}
          </div>
        </div>
      </article>
      {allowReport ? <ReportForm username={profile.username} /> : null}
    </>
  );
}
