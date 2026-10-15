import { useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { DialogCard } from '@/components/ui/dialog';

import { useMessages } from '../../lib/i18n/react';

import type { NativeLoginFailureDetails } from './shared';

// Message ids, read when the dialog renders.
const BRIDGE_EXPLANATIONS: Record<string, string> = {
  'blocked-frame': 'auth:nativeDetails.bridge.blockedFrame',
  unattached: 'auth:nativeDetails.bridge.unattached',
  inconclusive: 'auth:nativeDetails.bridge.inconclusive',
  unsupported: 'auth:nativeDetails.bridge.unsupported',
  ready: 'auth:nativeDetails.bridge.ready',
  unknown: 'auth:nativeDetails.bridge.unknown',
};

function known(value: string | number | null): string {
  return value === null ? 'Unknown' : String(value);
}

/** Safe, fixed failure snapshot only: never read live form fields or full URLs. */
export function nativeLoginDetailsText(details: NativeLoginFailureDetails): string {
  return [
    'Homeroom secure sign-in diagnostics',
    `Stage: ${details.stage}`,
    `Bridge state: ${known(details.bridgeState)}`,
    `Native code: ${known(details.code)}`,
    `Bridge kind: ${known(details.kind)}`,
    `Native message: ${known(details.nativeMessage)}`,
    `Page origin: ${known(details.pageOrigin)}`,
    `App version: ${known(details.appVersion)}`,
    `Build number: ${known(details.buildNumber)}`,
    `Bridge version: ${known(details.bridgeVersion)}`,
  ].join('\n');
}

/** A client-only modal; the anonymous shell prerenders no extra dialog root. */
function NativeLoginDetailsDialog({
  details,
  onClose,
}: {
  details: NativeLoginFailureDetails;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [copyStatus, setCopyStatus] = useState('');
  const t = useMessages('auth');
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(nativeLoginDetailsText(details));
      setCopyStatus(t('auth:nativeDetails.copied'));
    } catch {
      setCopyStatus(t('auth:nativeDetails.copyFailed'));
    }
  };

  return (
    <dialog
      ref={dialog}
      aria-label={t('auth:nativeDetails.title')}
      className="m-auto w-[calc(100%-2rem)] max-w-md max-h-[85dvh] overflow-y-auto rounded-xl border-0 bg-transparent p-0 text-zinc-900 dark:text-zinc-100 backdrop:bg-black/60"
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <DialogCard size="md" className="max-w-none space-y-4">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-bold">{t('auth:nativeDetails.title')}</h2>
          <Button type="button" variant="neutral" ink="neutral" onClick={onClose}>{t('core:common.close')}</Button>
        </div>
        <p className="text-sm text-zinc-600 dark:text-zinc-300">
          {t(BRIDGE_EXPLANATIONS[details.bridgeState || 'unknown'])}
        </p>
        <pre className="whitespace-pre-wrap break-words rounded-lg bg-zinc-100 p-3 text-xs text-zinc-800 select-text dark:bg-zinc-800 dark:text-zinc-100">
          {nativeLoginDetailsText(details)}
        </pre>
        <div className="flex items-center gap-3">
          <Button type="button" variant="neutral" ink="neutral" onClick={() => { void copy(); }}>
            {t('auth:nativeDetails.copy')}
          </Button>
          <span role="status" className="text-xs text-zinc-500 dark:text-zinc-400">{copyStatus}</span>
        </div>
      </DialogCard>
    </dialog>
  );
}

export function NativeLoginDetailsLink({ details }: { details: NativeLoginFailureDetails | null }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const t = useMessages('auth');
  if (!details) return null;
  return <>
    <button
      ref={trigger}
      type="button"
      className="mt-1 block min-h-11 text-sm font-medium text-violet-700 underline underline-offset-2 dark:text-violet-400"
      onClick={() => setOpen(true)}
    >
      {t('auth:nativeDetails.open')}
    </button>
    {open ? <NativeLoginDetailsDialog details={details} onClose={() => {
      setOpen(false);
      requestAnimationFrame(() => trigger.current?.focus());
    }} /> : null}
  </>;
}
