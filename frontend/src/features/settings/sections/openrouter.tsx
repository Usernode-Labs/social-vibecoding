import { Button } from '@/components/ui/button';
import { SectionHeading, StatusLine } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';

/**
 * OpenRouter/Codex as the preferred coding agent. Each account may claim a
 * limited company key once by default; deployments may require a verified
 * GitHub or X identity. Everyone may still use a personal OpenRouter key.
 * #settings-openrouter-model's `<option>` list is BUILT by
 * settings.js from the catalogue response, which is the clearest reason the
 * Select primitive is a native `<select>` rather than a Radix combobox — see
 * the header of @/components/ui/select.
 */
export function OpenRouterSection() {
  return (
    <div data-settings-section="openrouter" className="hidden">
      <SectionHeading title={<>OpenRouter &amp; Codex</>}>
        OpenRouter is the default coding-agent option after you add or claim a key. GLM 5.3 is preferred when your OpenRouter catalog exposes it, and you can select any other available model. Keys are encrypted at rest and injected only for a turn.
      </SectionHeading>
      <div id="settings-openrouter-beta-gated" className="hidden rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-xs text-zinc-600 dark:text-zinc-400 mb-3">
        Codex/OpenRouter is being rolled out gradually and isn't available for your account yet.
      </div>
      <div id="settings-openrouter-managed-card" className="hidden rounded-lg border border-violet-200 dark:border-violet-900 bg-violet-50 dark:bg-violet-950/30 px-3 py-3 mb-3">
        <div className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Included OpenRouter key</div>
        <div id="settings-openrouter-managed-message" className="mt-1 text-xs text-zinc-600 dark:text-zinc-400"></div>
        <Button id="settings-openrouter-claim" className="hidden mt-3" size="narrow">
          Create my included key
        </Button>
      </div>
      <div id="settings-openrouter-reveal" className="hidden rounded-lg border-2 border-amber-400 bg-amber-50 dark:bg-amber-950/30 px-3 py-3 mb-3">
        <div className="text-sm font-semibold text-amber-900 dark:text-amber-100">Save this key now. It is shown only once</div>
        <p className="mt-1 text-xs text-amber-800 dark:text-amber-200">It is already encrypted and selected for your Usernode sessions. Copy it if you also want your own backup.</p>
        <div className="mt-2 flex gap-2">
          <Input id="settings-openrouter-revealed-key" type="text" readOnly width="flex" className="font-mono" />
          <Button id="settings-openrouter-copy" layout="shrink" size="narrow">Copy</Button>
          <Button id="settings-openrouter-dismiss-reveal" layout="shrink" variant="neutral" ink="neutral" size="narrow">Done</Button>
        </div>
      </div>
      <div id="settings-openrouter-key-display" className="hidden rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm font-mono text-zinc-700 dark:text-zinc-300 mb-2">
        sk-or-&hellip;<span id="settings-openrouter-key-last4"></span>
      </div>
      <div id="settings-openrouter-key-info" className="hidden rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-xs mb-2 text-zinc-600 dark:text-zinc-400"></div>
      <div id="settings-openrouter-personal-controls">
        <Label className="mb-1" htmlFor="settings-openrouter-key">
          Or use your personal OpenRouter API key
        </Label>
        <div className="flex gap-2">
          <Input id="settings-openrouter-key" type="password" placeholder="sk-or-..." autoComplete="off" spellCheck={false} width="flex" className="font-mono" />
          <Button id="settings-openrouter-save" layout="shrink">
            Test &amp; save
          </Button>
          <Button id="settings-openrouter-remove" layout="hiddenShrink" variant="destructive" size="narrow" ink="danger">
            Remove
          </Button>
        </div>
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
