import { Button } from '@/components/ui/button';
import { SectionHeading, StatusLine } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

import { AiBudgetRow } from '../../header/ai-budget';

/**
 * Bring-your-own Anthropic key. Read and written by Settings._saveKey() /
 * _removeKey() / _refreshSpend() through #settings-api-key, #settings-save,
 * #settings-remove, #settings-key-display, #settings-spend and
 * #settings-status — every one of them bound by id, once, at init.
 */
export function ApiKeySection() {
  return (
    <div data-settings-section="api-key" className="hidden">
      <SectionHeading title="Anthropic API key">
        Bring your own Anthropic API key to keep working past the daily limit. Your platform daily allowance is used first; once it runs out, your key takes over automatically, even in the middle of a running turn, and usage bills directly to your Anthropic account.
      </SectionHeading>
      {/*
          The viewer's own daily AI allowance (#555), used vs. remaining.

          THE UI OVERHAUL took this out of the hamburger drawer, where it was a
          status row nobody acts on from a menu. It landed HERE rather than
          being deleted with the row, because this section is already the page
          about "what happens when your allowance runs out" — the sentence
          above it says so — and the figure is the thing that sentence is
          about.

          The row is `features/header/ai-budget.tsx` now: it renders from a
          store `features/header/ai-credit.js` publishes into, instead of
          being an empty `#ai-budget-slot` that module `innerHTML`ed. It still
          ships EMPTY and VISIBLE — the me-scoped fetch that fills it is what
          confirms there is an audience, and the row hides itself only once
          that fetch has answered with nothing to show.
      */}
      <AiBudgetRow />
      <Label spacing="stacked" htmlFor="settings-api-key">
        Anthropic API key
      </Label>
      <div
        id="settings-key-display"
        className="hidden rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm font-mono text-zinc-700 dark:text-zinc-300 mb-2"
      >
        sk-ant-…
        <span id="settings-key-last4">
        </span>
      </div>
      {/*
          #119 — daily spend breakdown for BYOK users. Filled by
          Settings._refreshSpend() on modal open; hidden while loading,
          on fetch failure, or when no key is saved. Rows are ordered
          limit-first to match the billing order (#212).
      */}
      <div
        id="settings-spend"
        className="hidden rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-xs mb-2"
      >
        <div className="font-medium text-zinc-700 dark:text-zinc-300 mb-1">
          Today's spend
        </div>
        <div className="flex justify-between text-zinc-600 dark:text-zinc-300">
          <span>
            Platform daily limit
          </span>
          <span id="settings-spend-platform" className="font-mono">
          </span>
        </div>
        <div className="flex justify-between text-zinc-600 dark:text-zinc-300">
          <span>
            Your key
          </span>
          <span id="settings-spend-byok" className="font-mono">
          </span>
        </div>
        <div className="text-zinc-500 dark:text-zinc-300 mt-1">
          Resets at midnight UTC.
        </div>
      </div>
      <div className="flex gap-2">
        <Input
          id="settings-api-key"
          type="password"
          placeholder="sk-ant-..."
          autoComplete="off"
          spellCheck="false"
          width="flex"
          className="font-mono"
        />
        {/*
            Both buttons now route through the primitive.

            The widened variant table (button.tsx) declares its groups in
            the order the shell's own strings are written — layout, surface,
            disabled, box, ink — so `layout="shrink"` emits `shrink-0`
            AHEAD of the box, exactly where the hand-written string had it.
            That is what unblocked the rest of these; the note that used to
            stand here said they would convert "when the primitive's variant
            table is widened with evidence", and this is that widening.

            settings.js still finds both by getElementById and binds their
            clicks — same tags, same ids, same class strings.
        */}
        <Button id="settings-save" layout="shrink">
          Save
        </Button>
        <Button
          id="settings-remove"
          layout="hiddenShrink"
          variant="destructive"
          size="narrow"
          ink="danger"
        >
          Remove
        </Button>
      </div>
      <p className="text-xs text-zinc-500 dark:text-zinc-300 mt-2 leading-relaxed">
        Encrypted at rest, verified against Anthropic before saving, never shown in full after save.
    The server decrypts it in memory to call Anthropic on your behalf, so don't paste keys into services you don't trust with that level of access.
        <a
          href="https://console.anthropic.com/settings/keys"
          target="_blank"
          rel="noopener"
          className="text-azure-800 hover:text-azure-900 dark:hover:text-azure-100 underline dark:text-azure-200"
        >
          Set tight spend limits
        </a>
        on the key itself for defense in depth.
      </p>
      <StatusLine id="settings-status" spacing={3} />
    </div>
  );
}
