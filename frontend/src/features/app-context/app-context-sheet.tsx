/**
 * #apps-switcher-sheet — the surface behind the header's "app name ⌄" tab
 * (Streamlined Concept).
 *
 * The Figma board's Apps sheet: a title row with "Create New", a horizontal
 * strip of the viewer's apps, and a `Home | Explore` footer. Its connector on
 * the board is labelled "Switching between Apps", which is exactly what this
 * is for — the drawer next to it carries the OPEN app's own views and changes.
 *
 * ── Why this file kept the app-context controller ──────────────────────
 *
 * It used to render the app's rows as a second surface; those moved into the
 * drawer (../app-context/app-context-rows.tsx). What stayed useful is the
 * plumbing: ./app-context-controller.js already presents this element as a kit
 * BOTTOM SHEET on touch — which is the idiom the board draws for this sheet —
 * owns `hidden`, the backdrop dismiss and the ghost-click guard, and is what
 * the title tab already calls. So the controller and store keep their names
 * and this element keeps its lifecycle; only the content is the switcher's.
 *
 * First render is the prerender: closed, target-less, no apps.
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react';

import { PlusWideIcon, XIcon } from '@/components/ui/icons';

import { useStoreState } from '../../lib/use-store-state';
import { improveStore } from '../improve/improve-store.js';
import { appContextStore } from './app-context-store.js';
import { AppContext } from './app-context-controller.js';

type SwitcherApp = { slug: string; name?: string; icon_url?: string | null };

function AppTile({ app, current }: { app: SwitcherApp; current: boolean }) {
  const label = app.name || app.slug;
  return (
    <a
      href={`#app/${app.slug}/app`}
      data-switcher-app={app.slug}
      aria-current={current ? 'page' : undefined}
      className="shrink-0 w-[4.5rem] flex flex-col items-center gap-1.5 un-touch-target"
      onClick={() => AppContext.dismissForNav()}
    >
      {app.icon_url ? (
        <img
          src={app.icon_url}
          alt=""
          className={'w-12 h-12 rounded-2xl object-cover bg-zinc-100 dark:bg-zinc-800'
            + (current ? ' ring-2 ring-violet-500' : '')}
        />
      ) : (
        <span
          className={'w-12 h-12 rounded-2xl flex items-center justify-center text-lg font-semibold '
            + 'bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400'
            + (current ? ' ring-2 ring-violet-500' : '')}
          aria-hidden="true"
        >
          {label.slice(0, 1).toUpperCase()}
        </span>
      )}
      <span className="w-full text-center text-[0.7rem] leading-tight text-zinc-600 dark:text-zinc-300 truncate">
        {label}
      </span>
    </a>
  );
}

export function AppsSwitcherSheet(): ReactNode {
  const { open } = useStoreState(appContextStore);
  const { slug } = useStoreState(improveStore);
  const [apps, setApps] = useState<SwitcherApp[] | null>(null);

  const close = useCallback(() => AppContext.close(), []);

  // The viewer's apps, in the home grid's own "Your apps" order — the one
  // answer to "which apps are mine" the platform already has. Loaded when the
  // sheet opens, never during the first render: the prerender ships an empty
  // strip and a fetch there would be a hydration mismatch.
  useEffect(() => {
    if (!open || apps) return;
    let live = true;
    (async () => {
      try {
        const demo = new URLSearchParams(location.search).get('demo') === '1' ? '?demo=1' : '';
        const res = await fetch(`/api/apps${demo}`);
        if (!res.ok) return;
        const data = await res.json();
        const home = (window as any).Home;
        const mine = home?.partitionApps
          ? home.partitionApps(data.apps || []).yours
          : (data.apps || []);
        if (live) setApps(mine);
      } catch {
        // Offline is a state, not a failure: no strip, the footer still works.
      }
    })();
    return () => { live = false; };
  }, [open, apps]);

  const rows = apps || [];

  return (
    <>
      <div
        id="apps-switcher-overlay"
        aria-hidden="true"
        {...(open ? { 'data-open': '' } : {})}
        className="fixed inset-0 z-40 bg-black/40"
        onClick={close}
      >
      </div>
      <div
        id="apps-switcher-sheet"
        role="dialog"
        aria-label="Switch apps"
        aria-hidden={open ? undefined : 'true'}
        {...(open ? { 'data-open': '' } : {})}
        className="fixed z-50 flex flex-col bg-white dark:bg-zinc-900 border-zinc-200 dark:border-zinc-700 shadow-2xl app-context-transition"
      >
        <div className="flex items-center gap-3 px-4 pt-4 pb-2 shrink-0">
          <span className="flex-1 min-w-0 block text-lg font-bold text-zinc-900 dark:text-zinc-100">
            Apps
          </span>
          <button
            id="apps-switcher-create"
            type="button"
            className="inline-flex items-center gap-1 text-sm font-medium text-violet-600 dark:text-violet-400 hover:underline un-touch-target"
            onClick={() => {
              AppContext.dismissForNav();
              (window as any).Home?.openCreateApp?.();
            }}
          >
            <PlusWideIcon className="w-3.5 h-3.5 shrink-0" strokeWidth="2.5" aria-hidden="true" />
            Create New
          </button>
          <button
            id="apps-switcher-close"
            type="button"
            className="text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 un-touch-target"
            aria-label="Close"
            onClick={close}
          >
            <XIcon className="w-5 h-5" />
          </button>
        </div>
        {/* The apps themselves, as a horizontal strip — the board draws them
            in one row that scrolls rather than a grid that grows. */}
        <div
          id="apps-switcher-list"
          className="shrink-0 flex gap-3 px-4 pb-3 overflow-x-auto overscroll-contain"
        >
          {rows.map((app) => (
            <AppTile key={app.slug} app={app} current={app.slug === slug} />
          ))}
          {apps && rows.length === 0 ? (
            <span className="py-4 text-xs text-zinc-500 dark:text-zinc-400">
              No apps yet — Explore finds the ones you can join.
            </span>
          ) : null}
        </div>
        {/* Home | Explore, the board's two footer buttons. */}
        <div className="shrink-0 flex gap-3 px-4 pb-4 pt-2 border-t border-zinc-100 dark:border-zinc-800 platform-safe-scroll">
          <a
            id="apps-switcher-home"
            href="/"
            className="flex-1 text-center text-sm font-medium rounded-xl bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-200 py-2.5 un-touch-target"
            onClick={(e) => {
              if ((window as any).NavLink?.isNativeClick(e)) return;
              e.preventDefault();
              AppContext.dismissForNav();
              (window as any).App?.navigateHome?.();
            }}
          >
            Home
          </a>
          <a
            id="apps-switcher-explore"
            href="#apps"
            className="flex-1 text-center text-sm font-medium rounded-xl bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-200 py-2.5 un-touch-target"
            onClick={() => AppContext.dismissForNav()}
          >
            Explore
          </a>
        </div>
      </div>
    </>
  );
}
