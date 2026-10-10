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

import { useMessages } from '../../../lib/i18n/react';
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
  const t = useMessages('settings');
  const c = s.connection;
  if (!c) return null;
  return (
    <UnSection
      id="settings-usernode-connection"
      title={t('settings:usernode.connection.title')}
      description={t('settings:usernode.connection.intro')}
    >
      {c.demo ? <UnP note={{ text: t('settings:usernode.demoNote'), tone: 'demo' }} /> : null}
      <UnRow row={c.row} />
      <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-2">{c.reason}</p>
      <UnP note={{ text: c.build, tone: 'mono' }} />
      {c.message ? (
        <p className="text-xs font-mono text-zinc-500 dark:text-zinc-500 mt-1 break-words">{c.message}</p>
      ) : null}
      {c.walletRecovery ? (
        <div id="settings-usernode-wallet-recovery" className={NOTICE_TONE.warn}>
          <p>
            {t('settings:usernode.connection.walletRecovery')}
          </p>
          <UnBtn btn={c.walletRecovery} />
        </div>
      ) : null}
      <div>
        <UnBtn btn={{
          id: 'settings-usernode-connection-retry', label: t('core:common.tryAgain'),
          action: '_retryUsernodeConnection', disabled: c.retryDisabled,
        }} />
        <UnBtn btn={{
          id: 'settings-usernode-connection-copy', label: t('settings:usernode.connection.copyDiagnostics'),
          action: '_copyUsernodeDiagnostics', disabled: c.retryDisabled,
        }} />
      </div>
    </UnSection>
  );
}

function Body({ s }: { s: UsernodeSectionState }): ReactNode {
  const t = useMessages('settings');
  const b = s.body;
  if (!b) return null;
  if (b.kind === 'loading') {
    return (
      <div id="settings-usernode-error" className="mt-6 pt-5 border-t border-zinc-200 dark:border-zinc-800">
        <p className="text-xs text-zinc-500 dark:text-zinc-400">{t('settings:usernode.body.loading')}</p>
      </div>
    );
  }
  if (b.kind === 'error') {
    return (
      <div id="settings-usernode-error" className="mt-6 pt-5 border-t border-zinc-200 dark:border-zinc-800">
        {/* Headline unchanged so existing reports stay recognisable. */}
        <p className="text-sm font-bold text-red-700 dark:text-red-400">
          {t('settings:usernode.body.loadFailed')}
        </p>
        <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">{b.reason}</p>
        {b.message ? (
          <p className="text-xs font-mono text-zinc-500 dark:text-zinc-500 mt-1 break-words">{b.message}</p>
        ) : null}
        <UnBtn btn={{ id: 'settings-usernode-retry', label: t('core:common.tryAgain'), action: '_retryUsernodeRead' }} />
      </div>
    );
  }
  return (
    <UnSection title={b.heading} description={b.description}>
      {b.demo ? <UnP note={{ text: t('settings:usernode.demoNote'), tone: 'demo' }} /> : null}
      <UnRow row={b.row} />
      {b.button ? <UnBtn btn={b.button} /> : null}
      {b.notice ? (
        <>
          <div id="settings-notif-notice" className={NOTICE_TONE[b.notice.tone]}>{b.notice.text}</div>
          {b.notice.settings ? (
            <UnBtn btn={{ label: t('settings:usernode.body.openNotificationSettings'), action: '_openNotifSettings' }} />
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
  const t = useMessages('settings');
  const p = s.socialPush;
  if (p.kind === 'absent') return null;
  return (
    <UnSection
      title={t('settings:usernode.socialPush.title')}
      description={t('settings:usernode.socialPush.intro')}
    >
      {p.kind === 'checking' ? <UnP note={{ text: t('settings:usernode.socialPush.checking') }} /> : null}
      {p.kind === 'unavailable' ? (
        <>
          <UnP note={{ text: p.reason }} />
          {p.failure ? (
            <p className="text-xs font-mono text-zinc-500 dark:text-zinc-500 mt-1 break-words">{p.failure}</p>
          ) : null}
          {p.retry ? <UnBtn btn={{ label: t('core:common.tryAgain'), action: '_retrySocialPush' }} /> : null}
        </>
      ) : null}
      {p.kind === 'ready' ? (
        <>
          <UnSwitch toggle={{
            label: t('settings:usernode.socialPush.toggle'), checked: p.enabled,
            action: '_setSocialPushEnabled', includeErrorDetail: true,
          }} />
          <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">{p.status}</p>
        </>
      ) : null}
    </UnSection>
  );
}

function BlockProduction({ s }: { s: UsernodeSectionState }): ReactNode {
  const t = useMessages('settings');
  const bp = s.blockProduction;
  return (
    <UnSection
      title={t('settings:usernode.blockProduction.title')}
      description={t('settings:usernode.blockProduction.intro')}
    >
      <div>
        {bp.kind === 'checking' ? <UnP note={{ text: t('settings:usernode.blockProduction.checking') }} /> : null}
        {bp.kind === 'note' ? (
          <>
            <UnP note={{ text: bp.text }} />
            {bp.action ? <UnBtn btn={bp.action} /> : null}
          </>
        ) : null}
        {bp.kind === 'ask' ? (
          <UnBtn btn={{ label: t('settings:usernode.blockProduction.ask'), action: '_askForBlockProduction' }} />
        ) : null}
      </div>
    </UnSection>
  );
}

function WidgetIcons({ s }: { s: UsernodeSectionState }): ReactNode {
  const t = useMessages('settings');
  const w = s.widgetIcons;
  if (!w) return null;
  return (
    <UnSection
      title={t('settings:usernode.widgetIcons.title')}
      description={t('settings:usernode.widgetIcons.intro')}
    >
      {w.demo ? <UnP note={{ text: t('settings:usernode.demoNote'), tone: 'demo' }} /> : null}
      {w.rows.map((row) => <UnRow key={row.id || row.label} row={row} />)}
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
      {w.recheck ? <UnBtn btn={{ label: t('settings:usernode.widgetIcons.recheck'), action: '_recheckWidgetIcons' }} /> : null}
    </UnSection>
  );
}

function Tail({ s }: { s: UsernodeSectionState }): ReactNode {
  const t = useMessages('settings');
  return (
    <>
      <BlockProduction s={s} />
      {s.privacy ? (
        <UnSection
          title={t('settings:usernode.privacy.title')}
          description={t('settings:usernode.privacy.intro')}
        >
          <UnSwitch toggle={s.privacy.facematch} />
          {s.privacy.open ? <UnBtn btn={s.privacy.open} /> : null}
          <UnBtn btn={s.privacy.reset} />
        </UnSection>
      ) : null}
      <WidgetIcons s={s} />
      {s.diagnostics ? (
        <UnSection
          title={t('settings:usernode.diagnostics.title')}
          description={t('settings:usernode.diagnostics.intro')}
        >
          {s.diagnostics.debugMode ? <UnSwitch toggle={s.diagnostics.debugMode} /> : null}
          <div>{s.diagnostics.actions.map((a) => <UnBtn key={a.action} btn={a} />)}</div>
        </UnSection>
      ) : null}
      {s.about ? (
        <UnSection title={t('settings:usernode.about.title')}>
          {s.about.notes.map((n, i) => (
            <p key={i} className="text-xs text-zinc-500 dark:text-zinc-400 font-mono">{n.text}</p>
          ))}
          <div>{s.about.actions.map((a) => <UnBtn key={a.action} btn={a} />)}</div>
          <Faq s={s} />
        </UnSection>
      ) : null}
      {s.account ? (
        <UnSection title={t('settings:usernode.account.title')}>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            {t('settings:usernode.account.autoSignIn')}
          </p>
        </UnSection>
      ) : null}
    </>
  );
}

function Faq({ s }: { s: UsernodeSectionState }): ReactNode {
  const t = useMessages('settings');
  const perms = s.body && s.body.kind === 'permissions' ? s.body : null;
  const isAndroid = !!(perms && perms.android);
  const device = perms && perms.android ? perms.android.device : null;
  return (
    <div className="mt-3">
      <div className="text-xs font-semibold text-zinc-500 dark:text-zinc-400 mb-1">{t('settings:usernode.faq.heading')}</div>
      {faqTiles(isAndroid, device).map((tile) => (
        <details key={tile.title} className="rounded-lg border border-zinc-200 dark:border-zinc-800 px-3 py-2 mb-2">
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
