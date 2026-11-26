/**
 * A PUBLIC PROJECT'S DISCUSSION, FOR A VISITOR (f-so2, f-so3; 26 Nov 2026).
 *
 * The signed-out project page (./guest-project.tsx) draws the project's
 * Discussion as a member's hub does (../dev-board/workshop/hub-discussion.tsx
 * DiscussionCard), read only: its posts, their newest replies, what they
 * carry and how many reacted, read through the public routes
 * (src/routes/public-api.js, public projects only, nothing about the
 * reader). "Start a post…" keeps its place, with "Sign in to post" at its
 * end, and asks the visitor to sign in; a thread has no reply field and a
 * reaction is a count, with no hover bar or long-press sheet to add one.
 *
 * On a phone it is the card of the newest posts (`preview`), which opens to
 * the whole Discussion in place; from 768px it is whole. Both read one feed.
 * The card's styles follow it here through `data-discussion-host`.
 */

import { useMemo, useState, type ReactNode } from 'react';

import { DiscussionCard, visitorData } from '../dev-board/workshop/hub-discussion';
import type { GuestApp } from './guest-data';

export function GuestDiscussion({ app, onSignIn }: { app: GuestApp; onSignIn: () => void }): ReactNode {
  const data = useMemo(() => visitorData(app.slug), [app.slug]);
  const [open, setOpen] = useState(false);
  const visitor = useMemo(() => ({ onSignIn }), [onSignIn]);
  return (
    <div data-discussion-host="" data-guest-discussion="">
      <div className={open ? 'hidden' : 'md:hidden'} data-guest-discussion-preview="">
        <DiscussionCard slug={app.slug} name={app.name} data={data} mode="preview" onOpenPage={() => setOpen(true)} visitor={visitor} />
      </div>
      <div className={open ? 'block' : 'hidden md:block'} data-guest-discussion-full="">
        <DiscussionCard slug={app.slug} name={app.name} data={data} mode="full" visitor={visitor} />
      </div>
    </div>
  );
}
