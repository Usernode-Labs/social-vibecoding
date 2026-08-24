/**
 * The drawer's "Your apps" section (Streamlined Concept).
 *
 * Leads the drawer, above the navigation rows: one row per app the viewer
 * belongs to (the home screen's own "Your apps" partition — see
 * ./drawer-apps-store.js), each a REAL anchor onto `#app/<slug>/app` so
 * modified clicks stay browser-native (the tests/nav-new-tab.test.js
 * convention), with the open app's row highlighted.
 *
 * Fully React-owned; ships as the empty `#drawer-your-apps` container
 * (`apps: null`) for prerender parity, and fills when
 * `HeaderMenu.open()` triggers the store's loader.
 */

import type { ReactNode } from 'react';

import { useStoreState } from '../../lib/use-store-state';
import { drawerAppsStore } from './drawer-apps-store.js';

type DrawerApp = {
  slug: string;
  name?: string;
  icon_url?: string | null;
};

function AppIcon({ app }: { app: DrawerApp }): ReactNode {
  if (app.icon_url) {
    return (
      <img
        src={app.icon_url}
        alt=""
        loading="lazy"
        draggable={false}
        className="w-5 h-5 shrink-0 rounded-md object-cover bg-zinc-100 dark:bg-zinc-800"
      />
    );
  }
  const initial = (app.name || app.slug || '?').charAt(0).toUpperCase();
  return (
    <span
      aria-hidden="true"
      className={'w-5 h-5 shrink-0 rounded-md bg-violet-500/10 text-violet-500 '
        + 'flex items-center justify-center text-[0.65rem] font-semibold'}
    >
      {initial}
    </span>
  );
}

export function DrawerApps() {
  const { apps, current } = useStoreState(drawerAppsStore) as {
    apps: DrawerApp[] | null;
    current: string | null;
  };
  const rows = apps || [];

  return (
    <div id="drawer-your-apps" className="flex-1 min-h-0 overflow-y-auto border-b border-zinc-100 dark:border-zinc-800">
      {rows.length ? (
        <div className="px-4 py-2 text-[0.7rem] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          Your apps
        </div>
      ) : null}
      {rows.map((app) => {
        const selected = current === app.slug;
        return (
          <a
            key={app.slug}
            href={`#app/${app.slug}/app`}
            data-drawer-app={app.slug}
            aria-current={selected ? 'page' : undefined}
            className={'flex items-center gap-3 px-4 min-h-[44px] text-sm font-medium '
              + (selected
                ? 'bg-violet-500/10 text-violet-600 dark:text-violet-400'
                : 'text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800')}
          >
            <AppIcon app={app} />
            <span className="truncate">
              {app.name || app.slug}
            </span>
          </a>
        );
      })}
    </div>
  );
}
