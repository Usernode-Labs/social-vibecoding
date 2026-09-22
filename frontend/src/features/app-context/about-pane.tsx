/**
 * The app's facts — the second pane of the app-context sheet (#2718).
 *
 * ── Why "About" is a pane and not a row that does something ───────────
 *
 * The menu in front of it holds things you DO to an app: give feedback, open
 * its Workshop, go to its discussion, open a terminal. What was left over
 * after those — the repository, sharing it, which version is running, how to
 * put it on a home screen — is a different kind of thing entirely. They are
 * facts ABOUT the app, and a menu that mixes the two makes every row read as
 * a possible action.
 *
 * The Improve panel had already found that line and drawn it in the wrong
 * place: "View on GitHub" and "Share app" sat in a footer under the session
 * list, because they were "the app as something you point other people at"
 * and nothing else on that surface was. This is that footer, given a name and
 * a level of its own.
 *
 * ── It keeps the two ids the panel had ────────────────────────────────
 *
 * `#improve-row-github` and `#improve-row-share` move here unchanged, with
 * the same gates (`repoUrl`, `canShare`) and the same method behind Share.
 * Their ids are what dapp.json selects and what the panel's own tests name;
 * moving a row should not also rename it, and the id says what the row IS
 * rather than which surface happens to be drawing it.
 *
 * ── Add to home screen is INSTRUCTIONS, not a prompt ──────────────────
 *
 * ../mobile-install/detect.ts already made this call and states the whole
 * argument: iOS Safari exposes no install API at all, and Android's
 * `beforeinstallprompt` fires only when Chrome decides it should, so a
 * control wired to it is a control that is sometimes missing. This reuses
 * A2HS_STEPS rather than writing a second copy of the sentence, and it
 * renders only where there is an OS to name.
 */

import { useMemo, type ReactNode } from 'react';

import {
  ArrowUpTrayIcon,
  GitHubIcon,
  InfoCircleIcon,
  ShareIcon,
} from '@/components/ui/icons';

import { useStoreState } from '../../lib/use-store-state';
import { improveStore } from '../improve/improve-store.js';
import { A2HS_STEPS, detectMobileOs } from '../mobile-install/detect';
import { AppContext } from './app-context-controller.js';

const ROW = 'flex items-center gap-3 px-5 min-h-[44px] text-sm w-full text-left '
  + 'text-zinc-700 dark:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-800 '
  + 'transition-colors';

const NOTE = 'px-5 py-3 text-sm text-zinc-500 dark:text-zinc-400';

function AboutRow({ id, icon, label, href, external, onClick }: {
  id: string;
  icon: ReactNode;
  label: string;
  href?: string;
  external?: boolean;
  onClick?: () => void;
}): ReactNode {
  const body = (
    <>
      <span className="shrink-0 [&>svg]:h-5 [&>svg]:w-5 text-zinc-500 dark:text-zinc-400" aria-hidden="true">
        {icon}
      </span>
      <span className="flex-1 min-w-0 truncate font-medium">{label}</span>
    </>
  );
  if (href) {
    return (
      <a
        id={id}
        href={href}
        {...(external ? { target: '_blank', rel: 'noreferrer' } : {})}
        className={ROW}
        onClick={() => AppContext.dismissForNav()}
      >
        {body}
      </a>
    );
  }
  return (
    <button id={id} type="button" className={ROW} onClick={onClick}>{body}</button>
  );
}

export function AboutPane({ label }: { label: string }): ReactNode {
  const { slug, repoUrl, canShare, version } = useStoreState(improveStore);
  // Read once per mount rather than per render: neither the user agent nor
  // the touch-point count changes while a sheet is open, and this pane is
  // mounted and unmounted by the view switch above it.
  const os = useMemo(() => (typeof navigator === 'undefined'
    ? null
    : detectMobileOs(navigator.userAgent, navigator.maxTouchPoints || 0)), []);

  return (
    <div id="app-about-pane">
      {/*
          THE NAME AND THE ADDRESS, ALWAYS. Every other line here is
          conditional — a repository the app may not have, a share the
          platform may not allow yet, a version it may never have deployed, a
          home screen the device may not have — and all four are absent at
          once often enough that this pane would otherwise open EMPTY. A pane
          that can be empty is a row that sometimes leads nowhere, which is
          the one thing a menu row must never be.

          The slug is the app's address, and it is worth printing rather than
          assuming: it is what a URL says, what a support conversation quotes,
          and the only name two apps called the same thing do not share.
      */}
      <div id="app-about-identity" className="px-5 pt-3 pb-1">
        <div className="text-base font-semibold text-zinc-900 dark:text-zinc-100 truncate">
          {label}
        </div>
        {slug ? (
          <div className="text-sm text-zinc-500 dark:text-zinc-400 truncate">
            {`/app/${slug}`}
          </div>
        ) : null}
      </div>
      {/*
          THE VERSION IS A LINE, NOT A ROW. A row implies somewhere to go and
          there is nowhere: the platform's own version lives in Settings, and
          an app's is a number you read. It renders only when there is one —
          an app that has never deployed has no version to print, and "version
          —" is worse than silence.
      */}
      {version ? (
        <div id="app-about-version" className={NOTE}>
          <span className="shrink-0 inline-flex align-text-bottom mr-2 [&>svg]:h-4 [&>svg]:w-4" aria-hidden="true">
            <InfoCircleIcon />
          </span>
          {`${label} is running version ${version}.`}
        </div>
      ) : null}
      {repoUrl ? (
        <AboutRow
          id="improve-row-github"
          icon={<GitHubIcon />}
          label="View on GitHub"
          href={repoUrl}
          external
        />
      ) : null}
      {/* `canShare` is false for an app that is still creating, errored, or
          waiting on its secrets — the same gate the panel's footer used, and
          the reason Share was never one of the action well's segments. */}
      {canShare ? (
        <AboutRow
          id="improve-row-share"
          icon={<ShareIcon />}
          label="Share app"
          onClick={() => {
            void AppContext.dismissForNav().then(() => {
              (window as unknown as { Improve?: { share?: () => void } })
                .Improve?.share?.();
            });
          }}
        />
      ) : null}
      {/*
          Add to home screen, where there is a home screen to add it to. On a
          desktop browser there is nothing to say, so nothing is said — rather
          than a row that explains it cannot help.
      */}
      {os ? (
        <div id="app-about-a2hs" className={NOTE}>
          <span className="shrink-0 inline-flex align-text-bottom mr-2 [&>svg]:h-4 [&>svg]:w-4" aria-hidden="true">
            <ArrowUpTrayIcon />
          </span>
          {`Add to your home screen: ${A2HS_STEPS[os]}`}
        </div>
      ) : null}
    </div>
  );
}
