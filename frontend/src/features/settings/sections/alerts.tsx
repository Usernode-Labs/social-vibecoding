import { RichMessage } from "../../../lib/i18n/react";
import { Message, Localized, message as catalogText } from "../../../lib/i18n/react";
import { SectionHeading, StatusLine } from '@/components/ui/field';

import { NotificationPrefsList } from '../notification-prefs-list';
import { SwitchRow } from '@/components/ui/switch';

/**
 * #138: Dev-chat sound & alerts (default ON). Client-only preference
 * (localStorage key devchat_alerts_enabled); wired in settings.js. Plays a
 * chime when an AI dev-chat turn finishes while you're in the app, or a system
 * notification when it's in the background.
 *
 * Below it, the mobile push categories. Those rows are NOT SwitchRows: their
 * shape is the other way round (caption block first, switch right-aligned and
 * top-aligned) and their checkbox writes `type`/`class`/`disabled` in that
 * order, which the primitive's prop order does not produce. They stay literal
 * — the same call alert.tsx makes for the banner with a display conflict.
 *
 * They are also seven WRITTEN-OUT rows rather than a map over a table, which
 * looks like the obvious deduplication and is not one:
 * tests/settings-mobile-push.test.js reads the label and blurb of every
 * category out of this file's SOURCE, and asserts that no internal
 * notification identifier (`mention`, `stale_pr`, `pr_proposed`, …) ever
 * appears between a `>` and a `<`. Hoisting the copy into a table would leave
 * that last check matching nothing at all — green, and no longer testing
 * anything.
 */
export function AlertsSection() {
  return (
    <div data-settings-section="alerts" className="hidden">
      <div id="settings-alerts-section">
        <SectionHeading title={<><Message id="settings:agent_session_sound_alerts_a3b208e8" /></>}><Message id="settings:get_a_heads_up_when_an_agent_session_finishes_an_4bbe7c09" /></SectionHeading>
        <SwitchRow id="devchat-alerts-toggle"><Message id="settings:play_a_sound_and_notify_me_when_the_app_is_in_th_cdbb5cda" /></SwitchRow>
        <p className="text-xs text-zinc-500 dark:text-zinc-500 mt-2 leading-relaxed"><Message id="settings:when_you_re_in_the_app_a_soft_chime_plays_a_brow_c11cd6df" /></p>
        <button
          id="devchat-alerts-test"
          type="button"
          className="mt-3 rounded-md border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
        ><Message id="settings:send_a_test_alert_38875c4c" /></button>
        <StatusLine
          as="p"
          id="devchat-alerts-test-status"
          size="xs"
          className="text-zinc-500 dark:text-zinc-400"
        />

        <div
          id="settings-mobile-push-preferences"
          className="mt-6 pt-6 border-t border-zinc-200 dark:border-zinc-800"
        >
          <Localized element={<SectionHeading title={catalogText("settings:mobile_push_categories_5299ed95")} blurbClassName="leading-relaxed"><Message id="settings:choose_which_social_activity_can_send_a_phone_no_a89f2a23" /></SectionHeading>} messages={{"title":"settings:mobile_push_categories_5299ed95"}} />
          <div className="space-y-3">
            <label className="flex items-start justify-between gap-4 cursor-pointer select-none" data-mobile-push-category="messages">
              <span><RichMessage id="settings:sentence_cee7cee2e70d" components={[<span className="block text-sm font-medium text-zinc-800 dark:text-zinc-200" />, <span className="block text-xs text-zinc-500 dark:text-zinc-400 mt-0.5" />]} /></span>
              <input type="checkbox" className="un-switch mt-0.5 shrink-0" disabled />
            </label>
            <label className="flex items-start justify-between gap-4 cursor-pointer select-none" data-mobile-push-category="builds">
              <span><RichMessage id="settings:sentence_318137c2d2fc" components={[<span className="block text-sm font-medium text-zinc-800 dark:text-zinc-200" />, <span className="block text-xs text-zinc-500 dark:text-zinc-400 mt-0.5" />]} /></span>
              <input type="checkbox" className="un-switch mt-0.5 shrink-0" disabled />
            </label>
            <label className="flex items-start justify-between gap-4 cursor-pointer select-none" data-mobile-push-category="invite_activity">
              <span><RichMessage id="settings:sentence_4b9375085eb6" components={[<span className="block text-sm font-medium text-zinc-800 dark:text-zinc-200" />, <span className="block text-xs text-zinc-500 dark:text-zinc-400 mt-0.5" />]} /></span>
              <input type="checkbox" className="un-switch mt-0.5 shrink-0" disabled />
            </label>
            <label className="flex items-start justify-between gap-4 cursor-pointer select-none" data-mobile-push-category="direct_interactions">
              <span><RichMessage id="settings:sentence_b1e2be0620ff" components={[<span className="block text-sm font-medium text-zinc-800 dark:text-zinc-200" />, <span className="block text-xs text-zinc-500 dark:text-zinc-400 mt-0.5" />]} /></span>
              <input type="checkbox" className="un-switch mt-0.5 shrink-0" disabled />
            </label>
            <label className="flex items-start justify-between gap-4 cursor-pointer select-none" data-mobile-push-category="invitations">
              <span><RichMessage id="settings:sentence_ad87684c8fd3" components={[<span className="block text-sm font-medium text-zinc-800 dark:text-zinc-200" />, <span className="block text-xs text-zinc-500 dark:text-zinc-400 mt-0.5" />]} /></span>
              <input type="checkbox" className="un-switch mt-0.5 shrink-0" disabled />
            </label>
            <label className="flex items-start justify-between gap-4 cursor-pointer select-none" data-mobile-push-category="shared_work">
              <span><RichMessage id="settings:sentence_5b72a4fbb55d" components={[<span className="block text-sm font-medium text-zinc-800 dark:text-zinc-200" />, <span className="block text-xs text-zinc-500 dark:text-zinc-400 mt-0.5" />]} /></span>
              <input type="checkbox" className="un-switch mt-0.5 shrink-0" disabled />
            </label>
            <label className="flex items-start justify-between gap-4 cursor-pointer select-none" data-mobile-push-category="developer_sessions">
              <span><RichMessage id="settings:sentence_5ecb51f101c3" components={[<span className="block text-sm font-medium text-zinc-800 dark:text-zinc-200" />, <span className="block text-xs text-zinc-500 dark:text-zinc-400 mt-0.5" />]} /></span>
              <input type="checkbox" className="un-switch mt-0.5 shrink-0" disabled />
            </label>
            <label className="flex items-start justify-between gap-4 cursor-pointer select-none" data-mobile-push-category="proposal_alerts">
              <span><RichMessage id="settings:sentence_b4450459876a" components={[<span className="block text-sm font-medium text-zinc-800 dark:text-zinc-200" />, <span className="block text-xs text-zinc-500 dark:text-zinc-400 mt-0.5" />]} /></span>
              <input type="checkbox" className="un-switch mt-0.5 shrink-0" disabled />
            </label>
            <label className="flex items-start justify-between gap-4 cursor-pointer select-none" data-mobile-push-category="app_alerts">
              <span><RichMessage id="settings:sentence_662aefb2eb67" components={[<span className="block text-sm font-medium text-zinc-800 dark:text-zinc-200" />, <span className="block text-xs text-zinc-500 dark:text-zinc-400 mt-0.5" />]} /></span>
              <input type="checkbox" className="un-switch mt-0.5 shrink-0" disabled />
            </label>
            <label className="flex items-start justify-between gap-4 cursor-pointer select-none" data-mobile-push-category="lightweight_activity">
              <span><RichMessage id="settings:sentence_9d130e5f7ab3" components={[<span className="block text-sm font-medium text-zinc-800 dark:text-zinc-200" />, <span className="block text-xs text-zinc-500 dark:text-zinc-400 mt-0.5" />]} /></span>
              <input type="checkbox" className="un-switch mt-0.5 shrink-0" disabled />
            </label>
          </div>
          <p data-mobile-push-status aria-live="polite" className="text-xs mt-3 text-zinc-500 dark:text-zinc-400"><Message id="settings:loading_mobile_push_preferences_21318fa1" /></p>
        </div>
        <div
          id="settings-notification-prefs"
          className="mt-6 pt-6 border-t border-zinc-200 dark:border-zinc-800"
        >
          <Localized element={<SectionHeading title={catalogText("settings:what_apps_tell_you_about_0cb37f87")} blurbClassName="leading-relaxed"><Message id="settings:your_default_for_every_app_and_the_apps_you_have_6b763540" /></SectionHeading>} messages={{"title":"settings:what_apps_tell_you_about_0cb37f87"}} />
          <div id="notification-prefs-list">
            <NotificationPrefsList />
          </div>
          <StatusLine id="notification-prefs-status" />
        </div>
      </div>
    </div>
  );
}