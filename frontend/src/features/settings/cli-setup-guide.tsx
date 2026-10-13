/**
 * Shared local coding-agent setup for Settings and the own-tools launchpad.
 *
 * This guide is static section content, not a credential-list state. Keeping
 * it outside `#cli-tokens-list` means it remains visible while capability
 * detection is pending, when staging deliberately disables the real token
 * API, and when the account already has credentials.
 */

import { useState, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';

import { useMessages } from '../../lib/i18n/react';

const REPOSITORY_SETUP = `git clone https://github.com/Usernode-Labs/social-vibecoding.git
cd social-vibecoding`;
const CODEX_COMMAND = 'codex';
const CLAUDE_COMMAND = 'claude';

/**
 * The example prompt as it is shown and copied. The catalog marks its two
 * fill-in parts with numbered tags; on screen they are in angle brackets.
 */
function examplePrompt(message: string): string {
  return message.replace(/<\d+>/g, '<').replace(/<\/\d+>/g, '>');
}

function ui(): any {
  return (typeof window !== 'undefined' ? (window as any).PlatformUI : null) || null;
}

/** What the Copy button says, by the outcome of the last press. */
const COPY_STATE_LABEL = {
  idle: 'core:common.copy',
  copied: 'core:common.copied',
  failed: 'settings:cli.guide.copyFailed',
} as const;

function CopyableCode({ label, copyLabel, value }: { label: string; copyLabel: string; value: string }) {
  const t = useMessages('settings');
  const [copyState, setCopyState] = useState<keyof typeof COPY_STATE_LABEL>('idle');
  return (
    <div className="mt-2 flex min-w-0 items-stretch overflow-hidden rounded-md border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900">
      {/* Focusable, and named (QA 2026-09-24 Q20): a long line scrolls
          sideways, and a region that scrolls must be reachable by keyboard. */}
      <pre
        tabIndex={0}
        role="region"
        aria-label={label}
        className="min-w-0 flex-1 overflow-x-auto whitespace-pre px-3 py-2 text-xs font-mono text-zinc-700 dark:text-zinc-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-violet-500"
      ><code>{value}</code></pre>
      <Button
        type="button"
        layout="shrink"
        variant="unstyled"
        size="none"
        ink="none"
        className="inline-flex min-h-[44px] min-w-[88px] items-center justify-center border-l border-zinc-200 dark:border-zinc-700 px-3 text-xs font-medium text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
        aria-label={copyLabel}
        onClick={async () => {
          const ok = await ui()?.copyText?.(value);
          setCopyState(ok ? 'copied' : 'failed');
          if (!ok) ui()?.toast?.(t('settings:cli.guide.copyFailedToast'), { error: true });
          setTimeout(() => setCopyState('idle'), 1500);
        }}
      >
        {t(COPY_STATE_LABEL[copyState])}
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

export function CliSetupGuide({
  id = 'cli-setup-guide',
  proposalPrompt,
  promptHelp,
}: { id?: string; proposalPrompt?: string; promptHelp?: string } = {}) {
  const t = useMessages('settings');
  return (
    <div id={id} className="mb-4 rounded-lg border border-zinc-200 dark:border-zinc-800 p-4">
      <h3 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">{t('settings:cli.guide.title')}</h3>
      <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400 leading-relaxed">
        {t('settings:cli.guide.intro')}
      </p>
      <ol className="mt-4 space-y-4">
        <SetupStep n={1} title={t('settings:cli.guide.clone.title')}>
          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400 leading-relaxed">
            {t('settings:cli.guide.clone.body')}
          </p>
          <CopyableCode label={t('settings:cli.guide.clone.codeLabel')} copyLabel={t('settings:cli.guide.clone.copyAria')} value={REPOSITORY_SETUP} />
        </SetupStep>
        <SetupStep n={2} title={t('settings:cli.guide.start.title')}>
          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400 leading-relaxed">
            {t('settings:cli.guide.start.body')}
          </p>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <div className="min-w-0">
              <div className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Codex</div>
              <CopyableCode label={t('settings:cli.guide.start.codexLabel')} copyLabel={t('settings:cli.guide.start.codexCopyAria')} value={CODEX_COMMAND} />
            </div>
            <div className="min-w-0">
              <div className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Claude Code</div>
              <CopyableCode label={t('settings:cli.guide.start.claudeLabel')} copyLabel={t('settings:cli.guide.start.claudeCopyAria')} value={CLAUDE_COMMAND} />
            </div>
          </div>
        </SetupStep>
        <SetupStep n={3} title={t('settings:cli.guide.ask.title')}>
          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400 leading-relaxed">
            {promptHelp ?? t('settings:cli.guide.ask.promptHelp')}
          </p>
          <CopyableCode label={t('settings:cli.guide.ask.promptLabel')} copyLabel={t('settings:cli.guide.ask.promptCopyAria')} value={proposalPrompt ?? examplePrompt(t('settings:cli.guide.ask.examplePrompt'))} />
          <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400 leading-relaxed">
            {t('settings:cli.guide.ask.follow')}
          </p>
        </SetupStep>
      </ol>
    </div>
  );
}
