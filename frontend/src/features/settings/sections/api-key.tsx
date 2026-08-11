import { Button } from '@/components/ui/button';
import { SectionHeading, StatusLine } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

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
        Bring your own Anthropic API key to keep working past the daily limit. Your platform daily allowance is used first; once it runs out, your key takes over automatically &mdash; even in the middle of a running turn &mdash; and usage bills directly to your Anthropic account.
      </SectionHeading>
      <Label className="mb-1" htmlFor="settings-api-key">
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
        <div className="flex justify-between text-zinc-600 dark:text-zinc-400">
          <span>
            Platform daily limit
          </span>
          <span id="settings-spend-platform" className="font-mono">
          </span>
        </div>
        <div className="flex justify-between text-zinc-600 dark:text-zinc-400">
          <span>
            Your key
          </span>
          <span id="settings-spend-byok" className="font-mono">
          </span>
        </div>
        <div className="text-zinc-500 dark:text-zinc-500 mt-1">
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
            THE ONE LIVE shadcn CONVERSION IN STEP 1.

            <Button>'s default variant + default size emit
            `rounded-lg bg-violet-600 hover:bg-violet-500 px-4 py-2
            text-sm font-medium text-white transition-colors`, so with
            `shrink-0` passed through className this renders the exact
            DOM node the hand-written button did — same tag, same id,
            same class set. settings.js still finds it by
            getElementById and binds its click.

            Step 2 keeps it exactly as step 1 left it. The remaining
            buttons on this screen are NOT converted with it: Button's
            base string leads with `font-medium transition-colors`,
            which none of the hand-written ones do, so routing them
            through the primitive would reorder their class attribute
            — a byte change, on a screen whose whole contract is that
            the rendered document does not change. They convert when
            the primitive's variant table is widened with evidence,
            not as a drive-by here.
        */}
        <Button id="settings-save" className="shrink-0">
          Save
        </Button>
        <button
          id="settings-remove"
          className="hidden shrink-0 rounded-lg border border-red-400 dark:border-red-700 px-3 py-2 text-sm font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950 transition-colors"
        >
          Remove
        </button>
      </div>
      <p className="text-xs text-zinc-500 dark:text-zinc-500 mt-2 leading-relaxed">
        Encrypted at rest, verified against Anthropic before saving, never shown in full after save.
    The server decrypts it in memory to call Anthropic on your behalf &mdash; don't paste keys into services you don't trust with that level of access.
        <a
          href="https://console.anthropic.com/settings/keys"
          target="_blank"
          rel="noopener"
          className="text-violet-500 hover:text-violet-400 underline"
        >
          Set tight spend limits
        </a>
        on the key itself for defense in depth.
      </p>
      <StatusLine id="settings-status" spacing={3} />
    </div>
  );
}
