import { t as tr } from "../../../lib/i18n/runtime";
import { Message, Localized, message as catalogText } from "../../../lib/i18n/react";
import { Button } from '@/components/ui/button';
import { SectionHeading, StatusLine } from '@/components/ui/field';
import { PasswordInput } from '@/components/ui/password-input';
import { Label } from '@/components/ui/label';

/**
 * Bring-your-own Anthropic key. Read and written by Settings._saveKey() /
 * _removeKey() through #settings-api-key, #settings-save, #settings-remove,
 * #settings-key-display and #settings-status — every one of them bound by id,
 * once, at init. The spend card _refreshSpend() fills (#settings-spend) and
 * the allowance row moved to ./usage.tsx, the part that leads this page.
 */
export function ApiKeySection() {
  return (
    <div data-settings-section="api-key" className="hidden">
      <Localized element={<SectionHeading title={catalogText("settings:anthropic_api_key_97d1086e")}><Message id="settings:bring_your_own_anthropic_api_key_to_keep_working_5b0792bc" /></SectionHeading>} messages={{"title":"settings:anthropic_api_key_97d1086e"}} />
      {/* The saved key, as the one row of its own card. It shared a card with
          the allowance until the settings restructure lifted the allowance
          into the Usage part at the head of this page. */}
      <div className="rounded-2xl bg-white dark:bg-zinc-900 overflow-hidden mb-3">
        <div
          id="settings-key-display"
          className="hidden px-4 py-3 [&:not(:last-child)]:border-b [&:not(:last-child)]:border-zinc-200 dark:[&:not(:last-child)]:border-zinc-800 flex items-center gap-3 text-[17px]"
        >
          <span className="text-zinc-500 dark:text-zinc-400"><Message id="settings:key_99a52df3" /></span>
          <span className="ml-auto font-mono text-[15px] text-zinc-700 dark:text-zinc-300"><Message id="settings:sk_ant_6c52ace5" /><span id="settings-key-last4"></span></span>
        </div>
      </div>
      <Label className="sr-only" htmlFor="settings-api-key"><Message id="settings:anthropic_api_key_97d1086e" /></Label>
      <div className="rounded-2xl bg-white dark:bg-zinc-900 overflow-hidden">
        <div className="px-4 py-3 [&:not(:last-child)]:border-b [&:not(:last-child)]:border-zinc-200 dark:[&:not(:last-child)]:border-zinc-800">
        {/*
            The width moves to the wrapper because the wrapper is what the
            flex row now lays out; the field fills it. settings.js keeps
            writing this element's `value` and `placeholder` by id, and both
            survive a toggle: the field is uncontrolled, and React rewrites
            only the props that CHANGED between renders — here, the `type`.
        */}
        <Localized element={<PasswordInput
          id="settings-api-key" placeholder={catalogText("settings:sk_ant_dda59792")}
          autoComplete="off"
          spellCheck="false"
          wrapperClassName="flex-1 min-w-0"
          className="font-mono"
          box="card"
          ring="bare"
          hint="dim"
        />} messages={{"placeholder":"settings:sk_ant_dda59792"}} />
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
        <Button id="settings-save" layout="shrink" variant="pillAccent" size="pill"><Message id="settings:save_1509f561" /></Button>
        <Button
          id="settings-remove"
          layout="hiddenShrink"
          variant="pillDanger"
          size="pill"
          ink="dangerTint"
        ><Message id="settings:remove_c3812fc4" /></Button>
        </div>
      </div>
      <p className="text-[15px] text-zinc-500 dark:text-zinc-500 mt-3 leading-snug px-1">
        {/* QA 2026-09-24 Q34: JSX drops the line break between text and a
            tag, which ran "access." into the link and the link into "on".
            The spaces ride inside the neighbouring strings, not as
            whitespace-only children, which cannot survive hydration (React
            #418; the same rule as notifications-list.tsx). */}
        {tr("settings:encrypted_at_rest_verified_against_anthropic_bef_a5748651")}
        <a
          href="https://console.anthropic.com/settings/keys"
          target="_blank"
          rel="noopener"
          className="text-violet-700 hover:text-violet-400 underline dark:text-violet-400"
        ><Message id="settings:set_tight_spend_limits_9faa0b10" /></a>
        <Message id="settings:on_the_key_itself_for_defense_in_depth_39b04ecd" />
      </p>
      <StatusLine id="settings-status" spacing={3} />
    </div>
  );
}
