/**
 * Settings → About: the three version rows, in the one place that exists to be
 * consulted rather than acted from.
 *
 * ── Where these have lived, and why they are here ──────────────────────
 *
 * The app's merged main, the platform's deployed commit and the installed
 * mobile release have moved twice already: hamburger footer → an About block
 * in Settings (#1431) → the Improve panel's footer (#1443, on the argument
 * that you are inside the app when that panel is open and should not leave it
 * to read them). They are back, and the reason is the thing #1443 could not
 * fix by moving them: three static rows are a poor answer to the question
 * they were being read for.
 *
 * That question is "is something happening, and is there a new version yet",
 * and the Improve panel answers it directly now — a note while a build is in
 * flight, a reload button when one is ready, and the matching glyph on the
 * Improve button itself. Raw revisions are what is left over once that is
 * said: reference material, which belongs on the reference screen.
 *
 * ── Two owners, and the seam between them ──────────────────────────────
 *
 * Like every pane here this component is STATIC (see ./index.tsx): no state,
 * no props, no effects. The row with a legacy owner keeps it —
 * `App.renderPlatformVersionPill` fills #platform-version-pill-slot by
 * innerHTML — so this file renders the boxes and not what goes in them.
 * <PlatformVersionRow/> is a component only so that it can ask that owner to
 * paint on mount; it still renders an empty host and never the pill.
 *
 * <NativeAppVersionRow/> is the exception and stays a store-fed island: it
 * comes from the native bridge, and a version arriving late should repaint one
 * row rather than the whole screen. It lives in the header feature on purpose
 * — see the note in its own file.
 *
 * `.drawer-ver-row` / `.drawer-ver-*` keep their names. app.css draws all
 * three rows off them, and renaming for tidiness would be a restyle wearing a
 * move's clothes.
 */

import { SectionHeading } from '@/components/ui/field';

import { useIsomorphicLayoutEffect } from '../../../lib/legacy-dom';
import { useStoreState } from '../../../lib/use-store-state';
import { improveStore } from '../../improve/improve-store.js';
import { NativeAppVersionRow } from '../../header/native-app-version-row';

/**
 * The open app's latest merged main, as a store-fed island for the same
 * reason NativeAppVersionRow is one: this pane is static, but a value that
 * arrives when an app opens should repaint one row and not the settings
 * screen.
 *
 * Two gates, both carried over from the Improve panel's copy of this row.
 * `slug` keeps a target-less screen from drawing a dangling label. `selfHosted`
 * removes a real duplicate: on the platform's own app this row IS the platform,
 * so "App version" directly above "Platform version" was the same fact twice.
 * They are not literally the same value — this one is the app's merged main,
 * that one is the commit the running deployment was built from — but they only
 * diverge mid-deploy or on a stale tab, and both of those the platform row
 * already names on its own.
 */
function AppVersionRow() {
  const { slug, selfHosted, version, deploying } = useStoreState(improveStore);
  const show = !!slug && !selfHosted;
  return (
    <div
      id="about-row-app-version"
      className={show
        ? 'drawer-ver-row flex items-center gap-2 px-4'
        : 'hidden drawer-ver-row flex items-center gap-2 px-4'}
    >
      <span className="drawer-ver-label">
        App version
      </span>
      <span
        id="about-app-version-slot"
        className="drawer-ver drawer-ver-value ml-auto min-w-0 justify-end font-mono truncate"
      >{deploying ? 'deploying…' : version || 'unknown'}</span>
    </div>
  );
}

/**
 * The commit this deployment was built from. Filled by
 * App.renderPlatformVersionPill, which also names the update state the Improve
 * panel and button read — so this row and those two are readers of one fact,
 * not of each other.
 *
 * The slot's CONTENT stays app.js's: this renders the empty host and asks its
 * owner to fill it on mount. That ask is what makes the row deterministic.
 * app.js paints from /api/version — once at boot, then on a 10s timer — and
 * since #1504 mounted the panes on first reveal, the boot answer can land
 * before this host is in the document. It did: the paint went nowhere and the
 * row stayed blank until the next tick, for up to ten seconds. Lazy-loading
 * the module widened that window enough to lose the race every time, which is
 * how it was found, but the race is older than the chunk.
 *
 * `_lastVersionInfo` is the answer app.js already has, painted the same way
 * its own prefetch-settled repaint does (see _ensureShellPrefetch). Null only
 * before the first answer arrives, and that paints this host itself.
 */
function PlatformVersionRow() {
  useIsomorphicLayoutEffect(() => {
    const App = window.App;
    if (App?._lastVersionInfo) App.renderPlatformVersionPill?.(App._lastVersionInfo);
  }, []);
  return (
    <div id="drawer-row-platform-version" className="drawer-ver-row flex items-center gap-2 px-4">
      <span className="drawer-ver-label">
        Platform version
      </span>
      <span
        id="platform-version-pill-slot"
        className="drawer-ver-value ml-auto inline-flex min-w-0 justify-end"
      >
      </span>
    </div>
  );
}

export function AboutSection() {
  return (
    <div data-settings-section="about" className="hidden">
      <div id="settings-about-section">
        <SectionHeading title="About">
          Which build of each part of the platform you are running.
        </SectionHeading>

        <AppVersionRow />

        <PlatformVersionRow />

        {/* The installed Flutter release (#1101) — version/build, e.g.
            0.4.0/1223. Independent of the platform commit above and never the
            open app's. Hidden outside the mobile app. */}
        <NativeAppVersionRow />
      </div>
    </div>
  );
}
