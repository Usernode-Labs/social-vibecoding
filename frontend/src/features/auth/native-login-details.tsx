import { t as tr } from "../../lib/i18n/runtime";
import { useMessages as useUiLanguage } from "../../lib/i18n/react";
import { Message, Localized, message as catalogText } from "../../lib/i18n/react";
import { useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { DialogCard } from '@/components/ui/dialog';

import type { NativeLoginFailureDetails } from './shared';

const BRIDGE_EXPLANATIONS: Record<string, string> = {
  get 'blocked-frame'() { return tr("auth:the_app_refused_this_page_s_secure_connection_th_227bfc2c"); },
  get unattached() { return tr("auth:the_app_did_not_answer_the_secure_connection_req_21b48906"); },
  get inconclusive() { return tr("auth:the_app_s_connection_check_did_not_return_a_conc_95f5588f"); },
  get unsupported() { return tr("auth:this_app_build_does_not_support_the_secure_conne_55826606"); },
  get ready() { return tr("auth:the_bridge_connected_but_native_login_preparatio_b7168f7d"); },
  get unknown() { return tr("auth:the_bridge_has_not_reported_a_connection_result_423aec06"); },
};

function known(value: string | number | null): string {
  return value === null ? tr("auth:unknown_b764cdc0") : String(value);
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
  useUiLanguage();
  const dialog = useRef<HTMLDialogElement>(null);
  const [copyStatus, setCopyStatus] = useState('');
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(nativeLoginDetailsText(details));
      setCopyStatus(tr("auth:details_copied_e2acabb2"));
    } catch {
      setCopyStatus(tr("auth:could_not_copy_you_can_select_the_details_below_805af1d3"));
    }
  };

  return (
    <Localized element={<dialog
      ref={dialog} aria-label={catalogText("auth:secure_sign_in_details_4148b81e")}
      className="m-auto w-[calc(100%-2rem)] max-w-md max-h-[85dvh] overflow-y-auto rounded-xl border-0 bg-transparent p-0 text-zinc-900 dark:text-zinc-100 backdrop:bg-black/60"
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <DialogCard size="md" className="max-w-none space-y-4">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-bold"><Message id="auth:secure_sign_in_details_4148b81e" /></h2>
          <Button type="button" variant="neutral" ink="neutral" onClick={onClose}><Message id="auth:close_7d9eb7ac" /></Button>
        </div>
        <p className="text-sm text-zinc-600 dark:text-zinc-300">
          {BRIDGE_EXPLANATIONS[details.bridgeState || 'unknown']}
        </p>
        <pre className="whitespace-pre-wrap break-words rounded-lg bg-zinc-100 p-3 text-xs text-zinc-800 select-text dark:bg-zinc-800 dark:text-zinc-100">
          {nativeLoginDetailsText(details)}
        </pre>
        <div className="flex items-center gap-3">
          <Button type="button" variant="neutral" ink="neutral" onClick={() => { void copy(); }}><Message id="auth:copy_details_ec7ee282" /></Button>
          <span role="status" className="text-xs text-zinc-500 dark:text-zinc-400">{copyStatus}</span>
        </div>
      </DialogCard>
    </dialog>} messages={{"aria-label":"auth:secure_sign_in_details_4148b81e"}} />
  );
}

export function NativeLoginDetailsLink({ details }: { details: NativeLoginFailureDetails | null }) {
  useUiLanguage();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  if (!details) return null;
  return <>
    <button
      ref={trigger}
      type="button"
      className="mt-1 block min-h-11 text-sm font-medium text-violet-700 underline underline-offset-2 dark:text-violet-400"
      onClick={() => setOpen(true)}
    ><Message id="auth:more_details_b5eff1db" /></button>
    {open ? <NativeLoginDetailsDialog details={details} onClose={() => {
      setOpen(false);
      requestAnimationFrame(() => trigger.current?.focus());
    }} /> : null}
  </>;
}
