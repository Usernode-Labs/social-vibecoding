import { useMessages as useUiLanguage } from "../../../lib/i18n/react";
import { RichMessage } from "../../../lib/i18n/react";
import { LocalizedValue, LocalizedDynamic } from "../../../lib/i18n/react";
import { t as tr } from "../../../lib/i18n/runtime";
import { Message } from "../../../lib/i18n/react";
/**
 * `#llm-consent-modal` — "Allow <app> to use AI?".
 *
 * Reached from the bridge relay, not from the board: an app in the iframe
 * asks for LLM access and this is the shell's answer. Same seam as its two
 * neighbours (see ./model.ts) — app-view.js owns the scrim, its `hidden`
 * class and its dismissal; React owns the card.
 *
 * ── Validation stays in the module ─────────────────────────────────────
 *
 * `#llm-consent-error` is app-view.js's line: the Allow handler parses the
 * cap, compares it against the account's own limit and writes the message
 * there, three checks deep. That is not view state — it is the decision the
 * dialog resolves with — so the error line is a controller host, rendered
 * once, empty and `hidden`, exactly as the hand-written card shipped it.
 * The field keeps its id for the same reason: the handler reads `.value` off
 * it, and an uncontrolled number input is what lets a half-typed "0." stay
 * on screen while it is being typed.
 */

import type { ReactNode } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { DialogCard } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

import { useStoreState } from '../../../lib/use-store-state';
import { llmConsentModalStore } from './modals-store';
import type { LlmConsentModalView } from './model';

function call(fn: string, ...args: unknown[]): void {
  const av = typeof window !== 'undefined' ? (window as any).AppView : null;
  if (av && typeof av[fn] === 'function') av[fn](...args);
}

export function LlmConsentCard({ view }: { view: LlmConsentModalView }): ReactNode {
  const blocked = view.capacity.t === 'blocked';
  return (
    <DialogCard size="md" relative>
      <h2 className="text-lg font-bold mb-2 text-zinc-900 dark:text-zinc-100">
        <LocalizedValue render={() => (tr("workshop:allow_value1_to_use_ai_041ad25f", { value1: view.appName }))} />
      </h2>
      {view.purpose ? (
        <p className="text-sm text-zinc-600 dark:text-zinc-400 mb-3 italic">{`“${view.purpose}”`}</p>
      ) : null}
      <p className="text-sm text-zinc-600 dark:text-zinc-400 mb-3">{view.intro}</p>
      {view.capacity.t === 'blocked' ? (
        <Alert variant="notice" density="compact">
          <LocalizedValue render={() => (view.capacity.t === 'blocked' && view.capacity.eligibilityUnavailable
            ? tr("workshop:credit_eligibility_could_not_be_checked_close_th_aafb44f0")
            : (
              <><RichMessage id="workshop:sentence_f6dfed19c5f7" components={[<a className="underline font-medium" href="#settings/linked-accounts" />, <a className="underline font-medium" href="#settings/api-key" />]} /></>
            ))} />
        </Alert>
      ) : (
        <>
          <Label htmlFor="llm-consent-cap" className="mb-1"><Message id="workshop:daily_cap_for_this_app_per_day_f19ab801" /></Label>
          <Input
            id="llm-consent-cap"
            type="number"
            min="0.01"
            step="0.01"
            defaultValue={view.capacity.prefill}
            width="w32"
            className="font-mono"
          />
          <p className="text-xs text-zinc-500 dark:text-zinc-500 mt-1">{view.capacity.suggestedNote}</p>
          {view.capacity.byok ? (
            <label className="flex items-start gap-2 cursor-pointer select-none mt-4">
              <input
                id="llm-consent-byok"
                type="checkbox"
                defaultChecked={view.capacity.byok.checked}
                className="accent-violet-500 w-4 h-4 mt-0.5"
              />
              <span className="text-xs text-zinc-700 dark:text-zinc-300">{view.capacity.byok.label}</span>
            </label>
          ) : null}
        </>
      )}
      {/* app-view.js's line — see the header. Rendered once, empty, hidden. */}
      <div id="llm-consent-error" className="hidden text-sm text-red-700 mt-3 dark:text-red-400"></div>
      <div className="flex justify-end gap-2 mt-5">
        <Button
          type="button"
          id="llm-consent-decline"
          variant="neutral"
          ink="neutral"
          onClick={() => call('_llmConsentDecline')}
        ><Message id="workshop:not_now_a0e63d7c" /></Button>
        <Button
          type="button"
          id="llm-consent-allow"
          disabled={blocked}
          disabledStyle="block"
          onClick={() => call('_llmConsentAllow')}
        >
          <LocalizedValue render={() => (blocked ? tr("workshop:unavailable_ca184496") : tr("workshop:allow_e213c161"))} />
        </Button>
      </div>
    </DialogCard>
  );
}

export function LlmConsentModal(): ReactNode {
  useUiLanguage();
  const { view } = useStoreState<{ view: LlmConsentModalView | null }>(llmConsentModalStore);
  if (!view) return null;
  return (
    <div data-modal-backdrop="" className="flex min-h-full items-center justify-center p-4">
      <LlmConsentCard view={view} />
    </div>
  );
}
