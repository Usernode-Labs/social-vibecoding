import { Button } from '@/components/ui/button';
import { SectionHeading, StatusLine } from '@/components/ui/field';
import { PasswordInput } from '@/components/ui/password-input';
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
      {/* The allowance and the saved key, as the rows of one card. */}
      <div className="rounded-2xl bg-white dark:bg-zinc-900 overflow-hidden mb-3">
        <div className="px-4 py-3 [&:not(:last-child)]:border-b [&:not(:last-child)]:border-zinc-200 dark:[&:not(:last-child)]:border-zinc-800">
          <AiBudgetRow />
        </div>
        <div
          id="settings-key-display"
          className="hidden px-4 py-3 [&:not(:last-child)]:border-b [&:not(:last-child)]:border-zinc-200 dark:[&:not(:last-child)]:border-zinc-800 flex items-center gap-3 text-[17px]"
        >
          <span className="text-zinc-500 dark:text-zinc-400">Key</span>
          <span className="ml-auto font-mono text-[15px] text-zinc-700 dark:text-zinc-300">sk-ant-…<span id="settings-key-last4"></span></span>
        </div>
      </div>
      {/*
          #119 — daily spend breakdown for BYOK users. Filled by
          Settings._refreshSpend() on modal open; hidden while loading,
          on fetch failure, or when no key is saved. Rows are ordered
          limit-first to match the billing order (#212).
      */}
      <div id="settings-spend" className="hidden mb-3">
        <div className="px-1 pb-1 text-[15px] text-zinc-500 dark:text-zinc-500">
          Today's spend
        </div>
        <div className="rounded-2xl bg-white dark:bg-zinc-900 overflow-hidden">
          <div className="px-4 py-3 [&:not(:last-child)]:border-b [&:not(:last-child)]:border-zinc-200 dark:[&:not(:last-child)]:border-zinc-800 flex justify-between gap-3 text-[17px] text-zinc-900 dark:text-zinc-100">
            <span>
              Platform daily limit
            </span>
            <span id="settings-spend-platform" className="tabular-nums text-zinc-500 dark:text-zinc-400">
            </span>
          </div>
          <div className="px-4 py-3 [&:not(:last-child)]:border-b [&:not(:last-child)]:border-zinc-200 dark:[&:not(:last-child)]:border-zinc-800 flex justify-between gap-3 text-[17px] text-zinc-900 dark:text-zinc-100">
            <span>
              Your key
            </span>
            <span id="settings-spend-byok" className="tabular-nums text-zinc-500 dark:text-zinc-400">
            </span>
          </div>
          <div className="px-4 py-3 [&:not(:last-child)]:border-b [&:not(:last-child)]:border-zinc-200 dark:[&:not(:last-child)]:border-zinc-800 text-[15px] text-zinc-500 dark:text-zinc-500">
            Resets at midnight UTC.
          </div>
        </div>
      </div>
      <Label className="sr-only" htmlFor="settings-api-key">
        Anthropic API key
      </Label>
      <div className="rounded-2xl bg-white dark:bg-zinc-900 overflow-hidden">
        <div className="px-4 py-3 [&:not(:last-child)]:border-b [&:not(:last-child)]:border-zinc-200 dark:[&:not(:last-child)]:border-zinc-800">
        {/*
            The width moves to the wrapper because the wrapper is what the
            flex row now lays out; the field fills it. settings.js keeps
            writing this element's `value` and `placeholder` by id, and both
            survive a toggle: the field is uncontrolled, and React rewrites
            only the props that CHANGED between renders — here, the `type`.
        */}
        <PasswordInput
          id="settings-api-key"
          placeholder="sk-ant-..."
          autoComplete="off"
          spellCheck="false"
          wrapperClassName="flex-1 min-w-0"
          className="font-mono"
          box="card"
          ring="bare"
          hint="dim"
        />
        </div>
        <div className="flex gap-2 px-4 py-3">
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
        <Button id="settings-save" layout="shrink" variant="pillAccent" size="pill">
          Save
        </Button>
        <Button
          id="settings-remove"
          layout="hiddenShrink"
          variant="pillDanger"
          size="pill"
          ink="dangerTint"
        >
          Remove
        </Button>
        </div>
      </div>
      <p className="text-[15px] text-zinc-500 dark:text-zinc-500 mt-3 leading-snug px-1">
        Encrypted at rest, verified against Anthropic before saving, never shown in full after save.
    The server decrypts it in memory to call Anthropic on your behalf, so don't paste keys into services you don't trust with that level of access.
        <a
          href="https://console.anthropic.com/settings/keys"
          target="_blank"
          rel="noopener"
          className="text-violet-700 hover:text-violet-400 underline dark:text-violet-400"
        >
          Set tight spend limits
        </a>
        on the key itself for defense in depth.
      </p>
      <StatusLine id="settings-status" spacing={3} />
    </div>
  );
}
