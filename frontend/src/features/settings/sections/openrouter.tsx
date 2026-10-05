import { Message, Localized, message as catalogText } from "../../../lib/i18n/react";
import { Button } from '@/components/ui/button';
import { SectionHeading, StatusLine } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { PasswordInput } from '@/components/ui/password-input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';

import { pressButton, returnKeyHandler } from '../../../lib/return-to-next';

/**
 * OpenRouter as the preferred coding agent. The heading, description and
 * model label are ALSO written at runtime by settings.js
 * `_normalizeOpenRouterCopy()`, so the text here must be that text word for
 * word: #3296's first cut edited only this copy, and the page never showed
 * it. tests/openrouter-harness.test.js holds the two equal. The description
 * names Claude Code, the one CLI a model can run in besides the unnamed
 * default, because the model list tags those models. #2568: every account is
 * created with its included company key, so there is nothing to claim and no
 * identity to prove first — #settings-openrouter-included is a STATUS line,
 * not a card with a button. Everyone may still use a personal OpenRouter key
 * instead. #settings-openrouter-model's `<option>` list is BUILT by
 * settings.js from the catalogue response, which is the clearest reason the
 * Select primitive is a native `<select>` rather than a Radix combobox — see
 * the header of @/components/ui/select.
 *
 * Return (#3907: the iOS keyboard's chevrons are gone): in the personal key
 * it runs Test & save, the key's own button, rather than walking on to the
 * model filter, which is a separate choice with its own save; in the filter
 * it goes on to the model list it just narrowed.
 */
function saveKey(): void {
  pressButton(document.getElementById('settings-openrouter-save'));
}

export function OpenRouterSection() {
  return (
    <div data-settings-section="openrouter" className="hidden">
      <SectionHeading title={<><Message id="settings:openrouter_eb70c3bc" /></>}><Message id="settings:use_any_compatible_model_for_all_chat_and_coding_227eef10" /></SectionHeading>
      <div id="settings-openrouter-included" className="hidden rounded-lg border border-violet-200 dark:border-violet-900 bg-violet-50 dark:bg-violet-950/30 px-3 py-3 mb-3">
        <div className="text-sm font-medium text-zinc-900 dark:text-zinc-100"><Message id="settings:included_openrouter_key_f33fea5d" /></div>
        <div id="settings-openrouter-included-status" className="mt-1 text-xs text-zinc-600 dark:text-zinc-400"></div>
      </div>
      <div id="settings-openrouter-key-display" className="hidden rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm font-mono text-zinc-700 dark:text-zinc-300 mb-2"><Message id="settings:sk_or_8939d26e" /><span id="settings-openrouter-key-last4"></span>
      </div>
      <div id="settings-openrouter-key-info" className="hidden rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-xs mb-2 text-zinc-600 dark:text-zinc-400"></div>
      <div id="settings-openrouter-personal-controls" onKeyDown={returnKeyHandler({ submit: saveKey })}>
        <Label className="px-1 pb-1 text-[15px] font-normal text-zinc-500 dark:text-zinc-500" htmlFor="settings-openrouter-key"><Message id="settings:or_use_your_personal_openrouter_api_key_95b84abf" /></Label>
        <div className="rounded-2xl bg-white dark:bg-zinc-900 overflow-hidden">
          <div className="px-4 py-3 [&:not(:last-child)]:border-b [&:not(:last-child)]:border-zinc-200 dark:[&:not(:last-child)]:border-zinc-800">
            {/* Same shape as #settings-api-key above — see the note there. */}
            <Localized element={<PasswordInput id="settings-openrouter-key" placeholder={catalogText("settings:sk_or_51efae34")} autoComplete="off" spellCheck={false} enterKeyHint="done" wrapperClassName="flex-1 min-w-0" className="font-mono" box="card" ring="bare" hint="dim" />} messages={{"placeholder":"settings:sk_or_51efae34"}} />
          </div>
          <div className="flex gap-2 px-4 py-3">
            <Button id="settings-openrouter-save" layout="shrink" variant="pillAccent" size="pill"><Message id="settings:test_save_634dbaab" /></Button>
            <Button id="settings-openrouter-remove" layout="hiddenShrink" variant="pillDanger" size="pill" ink="dangerTint"><Message id="settings:remove_c3812fc4" /></Button>
          </div>
        </div>
      </div>
      <div id="settings-openrouter-models-wrap" className="hidden mt-4" onKeyDown={returnKeyHandler()}>
        <Label className="mb-1" htmlFor="settings-openrouter-model"><Message id="settings:openrouter_model_dd24ac61" /></Label>
        <div className="flex flex-wrap gap-2 mb-2">
          <Localized element={<Input
            id="settings-openrouter-model-search"
            type="search"
            autoComplete="off"
            enterKeyHint="next"
            placeholder={catalogText("settings:filter_by_model_or_provider_19c5643b")}
            aria-label={catalogText("settings:filter_openrouter_models_75d3b31c")}
            width="flex"
          />} messages={{"placeholder":"settings:filter_by_model_or_provider_19c5643b","aria-label":"settings:filter_openrouter_models_75d3b31c"}} />
          <button
            id="settings-openrouter-favorites-only"
            type="button"
            aria-pressed="false"
            className="shrink-0 rounded-lg bg-zinc-100 hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 px-3 py-2 text-sm font-medium text-zinc-700 dark:text-zinc-300"
          ><Message id="settings:favorites_c2a2f40a" /></button>
          <button
            id="settings-openrouter-refresh-models"
            type="button"
            className="shrink-0 rounded-lg bg-zinc-100 hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 px-3 py-2 text-sm font-medium text-zinc-700 dark:text-zinc-300 disabled:opacity-50"
          ><Message id="settings:refresh_0e916101" /></button>
        </div>
        <div className="flex items-stretch gap-2">
          <Select id="settings-openrouter-model" className="min-w-0 flex-1"></Select>
          <Localized element={<button
            id="settings-openrouter-star-model"
            type="button"
            aria-pressed="false" aria-label={catalogText("settings:add_selected_model_to_favorites_a079bd1c")} title={catalogText("settings:add_selected_model_to_favorites_a079bd1c")}
            className="shrink-0 rounded-lg bg-zinc-100 hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 px-3 py-2 text-lg leading-none text-zinc-700 dark:text-zinc-300 disabled:opacity-50"
          >
            ☆
          </button>} messages={{"aria-label":"settings:add_selected_model_to_favorites_a079bd1c","title":"settings:add_selected_model_to_favorites_a079bd1c"}} />
        </div>
        <p id="settings-openrouter-catalog-meta" className="mt-1 text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400"></p>
        <p className="mt-1 text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400"><Message id="settings:platform_recommendations_start_starred_your_chan_b9be668d" /></p>
        <Label className="mt-2 mb-1" htmlFor="settings-openrouter-reasoning"><Message id="settings:reasoning_effort_3236aeec" /></Label>
        <Select id="settings-openrouter-reasoning">
          <option value=""><Message id="settings:default_21b111cb" /></option>
          <option value="minimal"><Message id="settings:minimal_057b5de4" /></option>
          <option value="low"><Message id="settings:low_f793de20" /></option>
          <option value="medium"><Message id="settings:medium_8e588cd1" /></option>
          <option value="high"><Message id="settings:high_c4ebc6d4" /></option>
          <option value="xhigh"><Message id="settings:extra_high_70eb321d" /></option>
        </Select>
        <button id="settings-openrouter-set-default" className="mt-3 rounded-full bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 px-5 py-2.5 text-[15px] font-semibold transition-colors"><Message id="settings:save_as_my_default_coding_agent_37aaed49" /></button>
        <button id="settings-claude-set-default" className="mt-2 rounded-full bg-zinc-100 dark:bg-zinc-800 px-5 py-2.5 text-[15px] font-semibold text-zinc-900 dark:text-zinc-100 hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-colors"><Message id="settings:use_claude_code_as_my_default_instead_24738538" /></button>
      </div>
      <StatusLine id="settings-openrouter-status" spacing={3} />
    </div>
  );
}
