/**
 * `#home-repin-notice-section` — the one-time Android launcher re-pin prompt
 * (#1489), directly above the launcher grid.
 *
 * ── Why this exists at all ────────────────────────────────────────────
 *
 * Pins created before #1489 carry the chromed `/app/<slug>` address, so
 * tapping one opens the app inside the platform with two stacked headers.
 * On iOS that is fixable without asking anybody: `Home._healWidgetUrls()`
 * rewrites the widget registry in place. On Android the icon belongs to the
 * LAUNCHER, and the bridge exposes only `addHomeScreenShortcut` there — no
 * readable registry, no removal, no reorder. So the platform can neither see
 * that a pin is stale nor fix one it knows about.
 *
 * This notice is the honest consequence: remember what was pinned
 * (`Home.PIN_LOG_KEY`), and where that memory says an icon is stale, ask.
 * The copy says outright that the old icon stays behind and has to be dragged
 * to Remove, because a re-add cannot replace it and implying otherwise would
 * leave people with two of the same app and no explanation.
 *
 * ── Shape ─────────────────────────────────────────────────────────────
 *
 * Same split as ./widget-strip.tsx: a pure `RePinNoticeBody` the tests call
 * as a plain function, and a store-connected `RePinNotice` that subscribes to
 * `chromeStore`. State lives on `Home` rather than in the component, for the
 * reason the strip's flags do — `Home.render()` repaints this from a dozen
 * places and the flags have to survive every one.
 *
 * The card reuses the widget help panel's idiom verbatim rather than
 * `@/components/ui/alert`, whose only variant is the full-bleed `banner`
 * (`#offline-banner`) — the wrong surface for an in-column notice.
 */

import { useStoreState } from '../../lib/use-store-state';
import { chromeStore, type RePinNoticeState } from './chrome-store';

function controller(): any {
  return (typeof window !== 'undefined' ? (window as any).Home : null) || null;
}

const CARD_CLASS = 'rounded-lg bg-violet-500/5 dark:bg-violet-500/10 border border-violet-500/20 '
  + 'px-3 py-2 text-[0.7rem] leading-relaxed text-zinc-600 dark:text-zinc-300';

const BTN_PRIMARY = 'px-2.5 py-1 rounded-md text-[0.7rem] font-medium bg-violet-500 text-white '
  + 'hover:bg-violet-600 disabled:opacity-50 transition-colors un-pressable un-touch-target';

const BTN_QUIET = 'px-2.5 py-1 rounded-md text-[0.7rem] font-medium text-zinc-500 '
  + 'dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 disabled:opacity-50 '
  + 'transition-colors un-pressable un-touch-target';

/** "Weather", "Weather and Ledger", "Weather, Ledger and Atlas". */
function nameList(apps: { name: string }[]): string {
  const names = apps.map((a) => a.name);
  if (names.length <= 1) return names[0] || '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

export function RePinNoticeBody({ notice }: { notice: RePinNoticeState }) {
  const stale = notice.kind === 'stale';
  return (
    <div id="home-repin-notice" className={CARD_CLASS}>
      <div className="font-medium text-zinc-700 dark:text-zinc-200">
        {'Re-add your home screen icons'}
      </div>
      <div className="mt-0.5">
        {stale ? (
          <>
            {nameList(notice.apps)}
            {notice.apps.length > 1 ? ' were' : ' was'}
            {' added to your home screen before an update, so '}
            {notice.apps.length > 1 ? 'they open' : 'it opens'}
            {' with an extra title bar. Re-add '}
            {notice.apps.length > 1 ? 'them' : 'it'}
            {' to fix that. Your phone will ask you to confirm each icon, and '}
            {'the old one stays put, so drag it to Remove once the new one appears.'}
          </>
        ) : (
          'Usernode apps you added to your home screen before an update open with an '
          + 'extra title bar. Re-adding them fixes it.'
        )}
      </div>
      {notice.helpVisible ? (
        <div id="home-repin-notice-help" className="mt-1.5 text-zinc-500 dark:text-zinc-400">
          {'Open the app’s '}
          <span className="font-medium">{'⋯'}</span>
          {' menu below and tap '}
          <span className="font-medium">Re-pin to phone home screen</span>
          {'. Your phone will ask you to confirm. The old icon stays put, so drag it '}
          {'to Remove once the new one appears.'}
        </div>
      ) : null}
      <div className="mt-2 flex items-center gap-1.5">
        <button
          type="button"
          id="home-repin-notice-action"
          className={BTN_PRIMARY}
          disabled={notice.busy}
          onClick={() => {
            const home = controller();
            if (!home) return;
            // 'unknown' has nothing to loop over, so its action must not
            // pretend to act: it points at the per-app menu instead.
            if (stale) home._rePinStaleShortcuts?.();
            else home._toggleRePinHelp?.();
          }}
        >
          {stale ? (notice.busy ? 'Re-adding…' : 'Re-add now') : 'Show me how'}
        </button>
        <button
          type="button"
          id="home-repin-notice-dismiss"
          className={BTN_QUIET}
          disabled={notice.busy}
          onClick={() => {
            const home = controller();
            if (home) home._dismissRePinNotice?.();
          }}
        >
          {'Not now'}
        </button>
      </div>
    </div>
  );
}

export function RePinNotice() {
  const { rePin } = useStoreState(chromeStore);
  return (
    <section
      id="home-repin-notice-section"
      className={rePin.active ? 'px-3 pt-2' : 'hidden px-3 pt-2'}
    >
      {rePin.active ? <RePinNoticeBody notice={rePin} /> : null}
    </section>
  );
}
