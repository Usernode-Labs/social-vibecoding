import { SectionHeading, StatusLine } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';

/**
 * OpenRouter/Codex as an alternative coding agent, billed to the user's own
 * OpenRouter key. #settings-openrouter-model's `<option>` list is BUILT by
 * settings.js from the catalogue response, which is the clearest reason the
 * Select primitive is a native `<select>` rather than a Radix combobox — see
 * the header of @/components/ui/select.
 */
export function OpenRouterSection() {
  return (
    <div data-settings-section="openrouter" className="hidden">
      <SectionHeading title={<>OpenRouter &amp; Codex</>}>
        Use Codex (via OpenRouter) as your coding agent, billed to your own OpenRouter API key. Your platform Claude allowance is not consumed for Codex turns (though the surrounding Mayor/wrap-up still use Claude credits). Your key is stored encrypted by the platform, is injected into the per-turn worker environment where the code running in your worker can see it, and is fully deleted when you remove it below &mdash; it is never persisted in the worker's warm environment or filesystem.
      </SectionHeading>
      <div id="settings-openrouter-beta-gated" className="hidden rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-xs text-zinc-600 dark:text-zinc-400 mb-3">
        Codex/OpenRouter is being rolled out gradually and isn't available for your account yet.
      </div>
      <Label className="mb-1" htmlFor="settings-openrouter-key">
        OpenRouter API key
      </Label>
      <div id="settings-openrouter-key-display" className="hidden rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm font-mono text-zinc-700 dark:text-zinc-300 mb-2">
        sk-or-&hellip;<span id="settings-openrouter-key-last4"></span>
      </div>
      <div id="settings-openrouter-key-info" className="hidden rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-xs mb-2 text-zinc-600 dark:text-zinc-400"></div>
      <div className="flex gap-2">
        <Input id="settings-openrouter-key" type="password" placeholder="sk-or-..." autoComplete="off" spellCheck={false} width="flex" className="font-mono" />
        <button id="settings-openrouter-save" className="shrink-0 rounded-lg bg-violet-600 hover:bg-violet-500 px-4 py-2 text-sm font-medium text-white transition-colors">
          Test &amp; save
        </button>
        <button id="settings-openrouter-remove" className="hidden shrink-0 rounded-lg border border-red-400 dark:border-red-700 px-3 py-2 text-sm font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950 transition-colors">
          Remove
        </button>
      </div>
      <div id="settings-openrouter-models-wrap" className="hidden mt-4">
        <Label className="mb-1" htmlFor="settings-openrouter-model">
          Codex model
        </Label>
        <Select id="settings-openrouter-model"></Select>
        <Label className="mt-2 mb-1" htmlFor="settings-openrouter-reasoning">
          Reasoning effort
        </Label>
        <Select id="settings-openrouter-reasoning">
          <option value="">Default</option>
          <option value="minimal">Minimal</option>
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
          <option value="xhigh">Extra high</option>
        </Select>
        <button id="settings-openrouter-set-default" className="mt-3 rounded-lg bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 px-4 py-2 text-sm font-medium transition-colors">
          Save as my default coding agent
        </button>
        <button id="settings-claude-set-default" className="mt-2 rounded-lg border border-zinc-300 dark:border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors">
          Use Claude Code as my default instead
        </button>
      </div>
      <StatusLine id="settings-openrouter-status" spacing={3} />
    </div>
  );
}
