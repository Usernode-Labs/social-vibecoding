/**
 * The connector's server URL with its own Copy, above the steps that say to
 * paste it (./connector-setup-steps). Same control as Settings'
 * #connector-url row: a read-only field rather than a <pre>, because on a
 * phone this is the one value somebody may need to select by hand. A new
 * thread's setup steps draw it (../messages/thread-builder.tsx).
 *
 * The URL is the live `${origin}/mcp`, passed in rather than written into
 * the prose, for the reason sections/connectors.tsx gives: a host spelled
 * out in copy goes stale on a fork or a config change.
 */

import { useState } from 'react';

import { Button } from '@/components/ui/button';

import { useMessages } from '../../lib/i18n/react';

function ui(): any {
  return (typeof window !== 'undefined' ? (window as any).PlatformUI : null) || null;
}

export function ConnectorUrl({ url }: { url: string }) {
  const t = useMessages('devchat');
  // What the last press came to; the label is read from it when it renders.
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  return (
    <div className="mt-2 flex min-w-0 items-stretch overflow-hidden rounded-md border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900">
      <input
        readOnly
        data-connector-setup-url="1"
        value={url}
        aria-label={t('devchat:connector.urlLabel')}
        className="min-w-0 flex-1 text-ellipsis bg-transparent px-3 py-2 text-xs font-mono text-zinc-700 dark:text-zinc-300 outline-none"
      />
      <Button
        type="button"
        layout="shrink"
        variant="unstyled"
        size="none"
        ink="none"
        className="inline-flex min-h-[44px] min-w-[88px] items-center justify-center border-s border-zinc-200 dark:border-zinc-800 px-3 text-xs font-medium text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
        aria-label={t('devchat:connector.copyUrl')}
        onClick={async () => {
          const ok = await ui()?.copyText?.(url);
          setCopyState(ok ? 'copied' : 'failed');
          if (!ok) ui()?.toast?.(t('devchat:connector.copyFailedToast'), { error: true });
          setTimeout(() => setCopyState('idle'), 1500);
        }}
      >
        {copyState === 'copied'
          ? t('core:common.copied')
          : copyState === 'failed' ? t('devchat:connector.copyFailed') : t('core:common.copy')}
      </Button>
    </div>
  );
}
