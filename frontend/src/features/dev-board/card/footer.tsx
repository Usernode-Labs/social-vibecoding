import { LocalizedValue, LocalizedDynamic } from "../../../lib/i18n/react";
import { t as tr } from "../../../lib/i18n/runtime";
import { Message } from "../../../lib/i18n/react";
/**
 * The trailing pager / truncation affordance under a kanban column. It lived
 * in the Activity feed's module (card/dev-feed.tsx) until the feed retired
 * in favour of the Workshop; the kanban was its other reader.
 *
 * The buttons dispatch by name: showAllDone, loadMoreMerged.
 */

import type { ReactNode } from 'react';

import type { FooterSpec } from './model';

function callAppView(fn: string): void {
  const av = typeof window !== 'undefined' ? (window as any).AppView : null;
  if (av && typeof av[fn] === 'function') av[fn]();
}

export function FooterView({ f }: { f: FooterSpec }): ReactNode {
  if (f.kind === 'showAll') {
    return (
      <button className="gc-vote-btn" onClick={() => callAppView('showAllDone')}><LocalizedValue render={() => (tr("workshop:show_all_value1_5e27d63e", { value1: f.n }))} /></button>
    );
  }
  if (f.kind === 'loadMerged') {
    return (
      <button className="gc-vote-btn" disabled={f.loading} onClick={() => callAppView('loadMoreMerged')}>
        <LocalizedValue render={() => (f.loading ? tr("workshop:loading_ba3bbbe1") : (f.n != null ? tr("workshop:load_more_value1_2b81d0af", { value1: f.n }) : tr("workshop:load_more_ac8991ef")))} />
      </button>
    );
  }
  if (f.kind === 'github') {
    return (
      <a href={f.href} target="_blank" rel="noopener" className="text-xs text-violet-700 hover:underline dark:text-violet-400">
        <Message id="workshop:more_open_requests_dfe5f14e" />
      </a>
    );
  }
  return <span className="text-xs text-zinc-500 dark:text-zinc-500 italic"><LocalizedValue render={() => (tr("workshop:value1_more_completed_d3be0455", { value1: f.n }))} /></span>;
}

