import type { ReactNode } from 'react';

import { AppIconContent, appIconKind } from '../apps/app-card-view';
import type { AiApp } from './model';

/** A project's tile at a one-line row's size, or a project heading's (./lists.tsx, ./project-picker.tsx). */
export function SmallTile({ app, size = 'row' }: { app: AiApp | null; size?: 'row' | 'head' }): ReactNode {
  const box = size === 'head' ? 'w-4 h-4 rounded-[5px] text-[9px]' : 'w-5 h-5 rounded-md text-[11px]';
  if (!app) return <span className={`${box} shrink-0 bg-zinc-200 dark:bg-zinc-700`} aria-hidden="true" />;
  return (
    <span className={`app-icon-tile ${box} shrink-0 overflow-hidden flex items-center justify-center font-bold`} data-icon={appIconKind(app as any)} aria-hidden="true">
      <AppIconContent app={app as any} />
    </span>
  );
}
