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
 * Credential-row markup is like-for-like with the DOM the module built — same
 * classes, same order, same two text nodes. The completed empty state is the
 * one deliberate addition: it explains how running a local coding agent
 * creates the first credential, with each terminal command copyable in place.
 */

import { useState, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';

import { useStoreState } from '../../lib/use-store-state';
import { cliTokensStore } from './cli-tokens-store.js';

const REPOSITORY_SETUP = `git clone https://github.com/Usernode-Labs/social-vibecoding.git
cd social-vibecoding`;
const CODEX_COMMAND = 'codex';
const CLAUDE_COMMAND = 'claude';
const PROPOSAL_PROMPT = 'Create a proposal for <app name> that <describe the change you want>.';

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

function ui(): any {
  return (typeof window !== 'undefined' ? (window as any).PlatformUI : null) || null;
}

function CopyableCode({ label, value }: { label: string; value: string }) {
  const [buttonLabel, setButtonLabel] = useState('Copy');
  return (
    <div className="flex items-start gap-2 mt-2">
      <pre className="min-w-0 flex-1 overflow-x-auto whitespace-pre text-xs font-mono text-zinc-700 dark:text-zinc-300 bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-md p-2"><code>{value}</code></pre>
      <Button
        type="button"
        layout="shrink"
        variant="outline"
        size="xsText"
        ink="muted"
        className="inline-flex items-center justify-center min-h-[44px] sm:min-h-[36px]"
        aria-label={`Copy ${label}`}
        onClick={async () => {
          const ok = await ui()?.copyText?.(value);
          setButtonLabel(ok ? 'Copied' : 'Copy failed');
          if (!ok) ui()?.toast?.('Couldn’t copy. Select the text and copy it manually', { error: true });
          setTimeout(() => setButtonLabel('Copy'), 1500);
        }}
      >
        {buttonLabel}
      </Button>
    </div>
  );
}

function SetupStep({ n, title, children }: {
  n: number;
  title: string;
  children: ReactNode;
}) {
  return (
    <li className="flex items-start gap-3">
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-violet-100 dark:bg-violet-950 text-xs font-semibold text-violet-700 dark:text-violet-300" aria-hidden="true">
        {n}
      </span>
      <div className="min-w-0 flex-1">
        <h4 className="text-sm font-medium text-zinc-800 dark:text-zinc-200">{title}</h4>
        {children}
      </div>
    </li>
  );
}

function CliSetupEmptyState() {
  return (
    <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-4">
      <h3 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">No CLI credentials yet</h3>
      <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400 leading-relaxed">
        Set up a local coding agent from your terminal. Your first authorization will add its credential here.
      </p>
      <ol className="mt-4 space-y-4">
        <SetupStep n={1} title="Clone the repository">
          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400 leading-relaxed">
            Clone Social Vibecoding and enter the checkout.
          </p>
          <CopyableCode label="repository setup commands" value={REPOSITORY_SETUP} />
        </SetupStep>
        <SetupStep n={2} title="Start your coding agent">
          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400 leading-relaxed">
            Run either Codex or Claude Code from the repository directory.
          </p>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <div className="min-w-0">
              <div className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Codex</div>
              <CopyableCode label="Codex command" value={CODEX_COMMAND} />
            </div>
            <div className="min-w-0">
              <div className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Claude Code</div>
              <CopyableCode label="Claude Code command" value={CLAUDE_COMMAND} />
            </div>
          </div>
        </SetupStep>
        <SetupStep n={3} title="Ask it to create a proposal">
          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400 leading-relaxed">
            Replace the placeholders with the app and change you have in mind, then send the prompt.
          </p>
          <CopyableCode label="example proposal prompt" value={PROPOSAL_PROMPT} />
          <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400 leading-relaxed">
            Follow the agent&rsquo;s instructions. It will ask you to authorize access on a Social Vibecoding web page; review and approve the request there, then return to your terminal.
          </p>
        </SetupStep>
      </ol>
    </div>
  );
}

export function CliTokensListView({ phase, tokens }: CliTokensState) {
  if (phase === 'idle') return null;
  // A bare text node, as `list.textContent = 'Loading credentials…'` produced.
  if (phase === 'loading') return <>Loading credentials…</>;
  if (!tokens.length) {
    return <CliSetupEmptyState />;
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
                className="shrink-0 rounded border border-red-400 dark:border-red-700 px-2 py-1 text-xs font-medium text-red-700 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950 transition-colors"
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
