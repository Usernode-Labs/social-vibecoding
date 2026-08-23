/**
 * `#cli-tokens-list` — the CLI / coding-agent credential rows, as the only
 * React writer below that host.
 *
 * The host is STATIC in the React tree (sections/cli.tsx), so this is a plain
 * child component rather than a portal: there is nothing to mount, and nothing
 * outside React writes here any more. settings.js keeps the keyset fetch, the
 * DELETE and the status line; this file keeps the markup.
 *
 * `Settings._revokeCliToken` is called BY NAME on `window.Settings` for the
 * reason ./grants-list.tsx gives: settings.js is a classic-shaped module
 * loaded before this bundle and cannot be imported. It already owns its own
 * disable-on-click, its refetch and its status reporting, so the component
 * hands it the id and the button and forgets.
 *
 * Markup is like-for-like with the DOM the module built — same classes, same
 * order, same two text nodes.
 */

import { useStoreState } from '../../lib/use-store-state';
import { cliTokensStore } from './cli-tokens-store.js';

type CliTokenView = {
  id: string | null;
  hint: string;
  detail: string;
  revocable: boolean;
};

type CliTokensState = { phase: 'idle' | 'loading' | 'ready'; tokens: CliTokenView[] };

function controller(): any {
  return (typeof window !== 'undefined' ? (window as any).Settings : null) || null;
}

export function CliTokensListView({ phase, tokens }: CliTokensState) {
  if (phase === 'idle') return null;
  // A bare text node, as `list.textContent = 'Loading credentials…'` produced.
  if (phase === 'loading') return <>Loading credentials…</>;
  if (!tokens.length) {
    return <p className="text-xs text-zinc-500 dark:text-zinc-400">No CLI credentials.</p>;
  }
  return (
    <>
      {tokens.map((token, i) => (
        <div
          // A revoked credential leaves the list on the refetch, so `id` is
          // stable for every row that has one; the demo rows have none and
          // never change, so their index is as stable as they are.
          key={token.id || `demo:${i}`}
          className="rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 px-3 py-2"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-mono text-zinc-800 dark:text-zinc-200">{token.hint}</div>
              <div className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">{token.detail}</div>
            </div>
            {/*
                Demo rows (staging ?demo=1) are fabricated server-side and have
                nothing to revoke — they get no button, the same stance the
                demo agent-files rows take.
            */}
            {token.revocable ? (
              <button
                type="button"
                className="shrink-0 rounded border border-red-400 dark:border-red-700 px-2 py-1 text-xs font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950 transition-colors"
                onClick={(e) => controller()?._revokeCliToken?.(token.id, e.currentTarget)}
              >
                Revoke
              </button>
            ) : null}
          </div>
        </div>
      ))}
    </>
  );
}

export function CliTokensList() {
  return <CliTokensListView {...useStoreState<CliTokensState>(cliTokensStore)} />;
}
