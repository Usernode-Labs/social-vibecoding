import { useMessages as useUiLanguage } from "../../../lib/i18n/react";
import { t as tr } from "../../../lib/i18n/runtime";
import { Message, Localized, message as catalogText } from "../../../lib/i18n/react";
/**
 * "Homeroom app" — the mobile app's native App Settings, absorbed into this
 * modal. See ./usernode-store.ts for why this host had to convert at once and
 * what stays settings.js's.
 *
 * ── What the conversion simplified, rather than moved ─────────────────
 *
 * Three things the imperative version did by hand stop existing here:
 *
 *   - `box.isConnected` guards. The activity-notifications section listened
 *     for `usernode:social-push-state` and checked, on every event, whether
 *     its own host was still in the document before writing to it. A publish
 *     to an unmounted component is a no-op by construction.
 *   - `holder.textContent = ''` before each in-place repaint, in four local
 *     `render(state)` closures.
 *   - `box.remove()` — the activity section deleted itself from the document
 *     when `SocialPush.isSupported()` resolved false. It is a model state now
 *     (`{ kind: 'absent' }`), which is also the only version of that fact the
 *     rest of the screen can read.
 *
 * The retry ladders, the staleness tokens and every bridge call stay in
 * settings.js, where they were.
 */

import { type ReactNode } from 'react';

import { useStoreState } from '../../../lib/use-store-state';
import { faqTiles } from './usernode-faq';
import { UnBtn, UnP, UnRow, UnSection, UnSwitch } from './usernode-ui';
import { usernodeSectionStore, type UsernodeSectionState } from './usernode-store';

/**
 * #2443 looked at `warn` and left this table alone.
 *
 * It is already ONE spelling in three tones — the three strings differ only
 * in hue — and `Alert`'s `notice` variant is amber and only amber, because
 * amber is the only tone the consistency audit found in the wild. Routing
 * `warn` through it would leave `ok` and `plain` on this geometry (`rounded-md
 * text-xs`) and `warn` on the primitive's (`rounded-lg text-sm`), so three
 * notices that sit inches apart in one settings section would stop matching
 * each other — a worse inconsistency than the one being fixed. Fixing all
 * three instead means adding an emerald and a fill-less neutral variant that
 * nothing else in the tree asks for.
 *
 * When a second surface needs a non-amber notice, move all three at once.
 */
const NOTICE_TONE = {
  warn: 'mt-2 rounded-md border px-3 py-2 text-xs border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-300',
  ok: 'mt-2 rounded-md border px-3 py-2 text-xs border-emerald-300 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300',
  plain: 'mt-2 rounded-md border px-3 py-2 text-xs border-zinc-300 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300',
} as const;

function Connection({ s }: { s: UsernodeSectionState }): ReactNode {
  const c = s.connection;
  if (!c) return null;
  return (
    <Localized element={<UnSection
      id="settings-usernode-connection" title={catalogText("settings:homeroom_app_connection_c357b0c7")} description={catalogText("settings:what_this_screen_can_reach_in_the_app_and_what_t_57ae84f7")}
    >
      {c.demo ? <UnP note={{ get text() { return tr("settings:staging_demo_sample_data_4d544e0a"); }, tone: 'demo' }} /> : null}
      <UnRow row={c.row} />
      <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-2">{c.reason}</p>
      <UnP note={{ text: c.build, tone: 'mono' }} />
      {c.message ? (
        <p className="text-xs font-mono text-zinc-500 dark:text-zinc-500 mt-1 break-words">{c.message}</p>
      ) : null}
      {c.walletRecovery ? (
        <div id="settings-usernode-wallet-recovery" className={NOTICE_TONE.warn}>
          <p><Message id="settings:no_new_mobile_wallet_is_available_for_this_accou_ed9a4b53" /></p>
          <UnBtn btn={c.walletRecovery} />
        </div>
      ) : null}
      <div>
        <UnBtn btn={{
          id: 'settings-usernode-connection-retry', get label() { return tr("settings:try_again_d8b8392e"); },
          action: '_retryUsernodeConnection', disabled: c.retryDisabled,
        }} />
        <UnBtn btn={{
          id: 'settings-usernode-connection-copy', get label() { return tr("settings:copy_diagnostics_46fa69e5"); },
          action: '_copyUsernodeDiagnostics', disabled: c.retryDisabled,
        }} />
      </div>
    </UnSection>} messages={{"title":"settings:homeroom_app_connection_c357b0c7","description":"settings:what_this_screen_can_reach_in_the_app_and_what_t_57ae84f7"}} />
  );
}

function Body({ s }: { s: UsernodeSectionState }): ReactNode {
  const b = s.body;
  if (!b) return null;
  if (b.kind === 'loading') {
    return (
      <div id="settings-usernode-error" className="mt-6 pt-5 border-t border-zinc-200 dark:border-zinc-800">
        <p className="text-xs text-zinc-500 dark:text-zinc-400"><Message id="settings:loading_homeroom_app_settings_ed4ab34f" /></p>
      </div>
    );
  }
  if (b.kind === 'error') {
    return (
      <div id="settings-usernode-error" className="mt-6 pt-5 border-t border-zinc-200 dark:border-zinc-800">
        {/* Headline unchanged so existing reports stay recognisable. */}
        <p className="text-sm font-bold text-red-700 dark:text-red-400"><Message id="settings:could_not_load_homeroom_app_settings_6ee3adf9" /></p>
        <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">{b.reason}</p>
        {b.message ? (
          <p className="text-xs font-mono text-zinc-500 dark:text-zinc-500 mt-1 break-words">{b.message}</p>
        ) : null}
        <UnBtn btn={{ id: 'settings-usernode-retry', get label() { return tr("settings:try_again_d8b8392e"); }, action: '_retryUsernodeRead' }} />
      </div>
    );
  }
  return (
    <UnSection title={b.heading} description={b.description}>
      {b.demo ? <UnP note={{ get text() { return tr("settings:staging_demo_sample_data_4d544e0a"); }, tone: 'demo' }} /> : null}
      <UnRow row={b.row} />
      {b.button ? <UnBtn btn={b.button} /> : null}
      {b.notice ? (
        <>
          <div id="settings-notif-notice" className={NOTICE_TONE[b.notice.tone]}>{b.notice.text}</div>
          {b.notice.settings ? (
            <UnBtn btn={{ get label() { return tr("settings:open_notification_settings_c6885c8e"); }, action: '_openNotifSettings' }} />
          ) : null}
        </>
      ) : null}
      {b.android ? (
        <>
          <UnRow row={b.android.row} />
          {b.android.button ? <UnBtn btn={b.android.button} /> : null}
          {b.android.device ? (
            <p className="text-xs text-zinc-500 dark:text-zinc-500 mt-2">{b.android.device}</p>
          ) : null}
        </>
      ) : null}
    </UnSection>
  );
}

function SocialPush({ s }: { s: UsernodeSectionState }): ReactNode {
  const p = s.socialPush;
  if (p.kind === 'absent') return null;
  return (
    <Localized element={<UnSection title={catalogText("settings:homeroom_app_activity_notifications_fba10fe5")} description={catalogText("settings:get_a_device_notification_when_an_agent_session__c0dbd22f")}
    >
      {p.kind === 'checking' ? <UnP note={{ get text() { return tr("settings:checking_status_c8e79f30"); } }} /> : null}
      {p.kind === 'unavailable' ? (
        <>
          <UnP note={{ text: p.reason }} />
          {p.failure ? (
            <p className="text-xs font-mono text-zinc-500 dark:text-zinc-500 mt-1 break-words">{p.failure}</p>
          ) : null}
          {p.retry ? <UnBtn btn={{ get label() { return tr("settings:try_again_d8b8392e"); }, action: '_retrySocialPush' }} /> : null}
        </>
      ) : null}
      {p.kind === 'ready' ? (
        <>
          <UnSwitch toggle={{
            get label() { return tr("settings:activity_notifications_5d01c890"); }, checked: p.enabled,
            action: '_setSocialPushEnabled', includeErrorDetail: true,
          }} />
          <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">{p.status}</p>
        </>
      ) : null}
    </UnSection>} messages={{"title":"settings:homeroom_app_activity_notifications_fba10fe5","description":"settings:get_a_device_notification_when_an_agent_session__c0dbd22f"}} />
  );
}

function BlockProduction({ s }: { s: UsernodeSectionState }): ReactNode {
  const bp = s.blockProduction;
  return (
    <Localized element={<UnSection title={catalogText("settings:homeroom_app_block_production_7ea23d77")} description={catalogText("settings:producing_blocks_earns_points_access_is_released_2ea7e4f9")}
    >
      <div>
        {bp.kind === 'checking' ? <UnP note={{ get text() { return tr("settings:checking_status_c8e79f30"); } }} /> : null}
        {bp.kind === 'note' ? <UnP note={{ text: bp.text }} /> : null}
        {bp.kind === 'ask' ? (
          <UnBtn btn={{ get label() { return tr("settings:ask_to_produce_blocks_f152c128"); }, action: '_askForBlockProduction' }} />
        ) : null}
      </div>
    </UnSection>} messages={{"title":"settings:homeroom_app_block_production_7ea23d77","description":"settings:producing_blocks_earns_points_access_is_released_2ea7e4f9"}} />
  );
}

function WidgetIcons({ s }: { s: UsernodeSectionState }): ReactNode {
  const w = s.widgetIcons;
  if (!w) return null;
  return (
    <Localized element={<UnSection title={catalogText("settings:homeroom_app_widget_icons_346d1bf0")} description={catalogText("settings:what_the_homescreen_widget_was_told_to_show_and__9f735388")}
    >
      {w.demo ? <UnP note={{ get text() { return tr("settings:staging_demo_sample_data_4d544e0a"); }, tone: 'demo' }} /> : null}
      {w.rows.map((row, index) => <UnRow key={row.id || index} row={row} />)}
      {w.notes.map((n, i) => <UnP key={`${n.tone || 'muted'}-${i}`} note={n} />)}
      {w.entries.length === 1 && w.entries[0].empty ? (
        <p className="text-xs text-zinc-500 dark:text-zinc-500 mt-2">{w.entries[0].empty}</p>
      ) : (
        <div id="settings-widget-icon-entries" className="mt-3 space-y-1">
          {w.entries.map((e) => (
            <div key={e.key} className="flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-400">
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${e.ok ? 'bg-emerald-500' : 'bg-amber-500'}`}></span>
              <span className="text-zinc-700 dark:text-zinc-300">{e.name}</span>
              <span className="ml-auto">{e.note}</span>
            </div>
          ))}
        </div>
      )}
      {w.recheck ? <UnBtn btn={{ get label() { return tr("settings:re_check_icons_3725c28c"); }, action: '_recheckWidgetIcons' }} /> : null}
    </UnSection>} messages={{"title":"settings:homeroom_app_widget_icons_346d1bf0","description":"settings:what_the_homescreen_widget_was_told_to_show_and__9f735388"}} />
  );
}

function Tail({ s }: { s: UsernodeSectionState }): ReactNode {
  return (
    <>
      <BlockProduction s={s} />
      {s.privacy ? (
        <Localized element={<UnSection title={catalogText("settings:homeroom_app_privacy_identity_ca2e0596")} description={catalogText("settings:controls_for_the_zk_passport_identity_flow_47ad3148")}
        >
          <UnSwitch toggle={s.privacy.facematch} />
          {s.privacy.open ? <UnBtn btn={s.privacy.open} /> : null}
          <UnBtn btn={s.privacy.reset} />
        </UnSection>} messages={{"title":"settings:homeroom_app_privacy_identity_ca2e0596","description":"settings:controls_for_the_zk_passport_identity_flow_47ad3148"}} />
      ) : null}
      <WidgetIcons s={s} />
      {s.diagnostics ? (
        <Localized element={<UnSection title={catalogText("settings:homeroom_app_diagnostics_842cdb62")} description={catalogText("settings:debugging_tools_for_the_app_and_its_embedded_nod_946251c5")}
        >
          {s.diagnostics.debugMode ? <UnSwitch toggle={s.diagnostics.debugMode} /> : null}
          <div>{s.diagnostics.actions.map((a) => <UnBtn key={a.action} btn={a} />)}</div>
        </UnSection>} messages={{"title":"settings:homeroom_app_diagnostics_842cdb62","description":"settings:debugging_tools_for_the_app_and_its_embedded_nod_946251c5"}} />
      ) : null}
      {s.about ? (
        <Localized element={<UnSection title={catalogText("settings:homeroom_app_about_legal_2d6d2182")}>
          {s.about.notes.map((n, i) => (
            <p key={i} className="text-xs text-zinc-500 dark:text-zinc-400 font-mono">{n.text}</p>
          ))}
          <div>{s.about.actions.map((a) => <UnBtn key={a.action} btn={a} />)}</div>
          <Faq s={s} />
        </UnSection>} messages={{"title":"settings:homeroom_app_about_legal_2d6d2182"}} />
      ) : null}
      {s.account ? (
        <Localized element={<UnSection title={catalogText("settings:homeroom_app_account_a397f7be")}>
          <p className="text-xs text-zinc-500 dark:text-zinc-400"><Message id="settings:the_app_signs_in_automatically_with_your_platfor_87ffde5d" /></p>
        </UnSection>} messages={{"title":"settings:homeroom_app_account_a397f7be"}} />
      ) : null}
    </>
  );
}

function Faq({ s }: { s: UsernodeSectionState }): ReactNode {
  const perms = s.body && s.body.kind === 'permissions' ? s.body : null;
  const isAndroid = !!(perms && perms.android);
  const device = perms && perms.android ? perms.android.device : null;
  return (
    <div className="mt-3">
      <div className="text-xs font-semibold text-zinc-500 dark:text-zinc-400 mb-1"><Message id="settings:help_info_59a661da" /></div>
      {faqTiles(isAndroid, device).map((tile, index) => (
        <details key={index} className="rounded-lg border border-zinc-200 dark:border-zinc-800 px-3 py-2 mb-2">
          <summary className="text-sm font-medium cursor-pointer select-none">{tile.title}</summary>
          {tile.paragraphs.map((p, i) => (
            <p key={i} className="text-xs text-zinc-500 dark:text-zinc-400 mt-2 leading-relaxed">{p}</p>
          ))}
        </details>
      ))}
    </div>
  );
}

export function UsernodeSectionBody({ s }: { s: UsernodeSectionState }): ReactNode {
  return (
    <>
      {/* First, so a refused handshake explains itself ABOVE the failures it
          causes rather than below them. */}
      <Connection s={s} />
      <Body s={s} />
      {/* The demo link renders the permissions rows and stops: everything
          below reads the live bridge, which a browser does not have. */}
      {s.belowDemoCut ? <><SocialPush s={s} /><Tail s={s} /></> : null}
    </>
  );
}

export function UsernodeSection(): ReactNode {
  useUiLanguage();
  const s = useStoreState(usernodeSectionStore);
  return (
    <div data-settings-section="usernode" className="hidden">
      {/* #settings-usernode-section's `hidden` is a CAPABILITY GATE, separate
          from the wrapper's routing `hidden` above, and
          Settings._visibleSections() reads it back to decide menu membership. */}
      <div id="settings-usernode-section" className={s.gated ? '' : 'hidden'}>
        <UsernodeSectionBody s={s} />
      </div>
    </div>
  );
}
