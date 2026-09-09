/**
 * Settings → Theme: Light / Dark / System.
 *
 * THE UI OVERHAUL moved this out of the hamburger drawer, where it had been
 * the first row. The drawer is navigation plus notifications now; a live
 * control that changes how the whole product looks is a SETTING, and it is the
 * first one — the section a bare #settings resolves to (Settings
 * .DEFAULT_SECTION), because it is the setting most people come looking for
 * and the only one that needs no explanation.
 *
 * ── What did NOT move ─────────────────────────────────────────────────
 *
 * The persistence. All of it still lives in the inline `window.Theme` block at
 * the top of frontend/src/head.html — head-blocking, so the stored mode is
 * applied before first paint. This component reads and writes through that
 * global and owns nothing but the highlight.
 *
 * The ids are unchanged too (#drawer-theme-track, #drawer-theme-caret-track,
 * #drawer-theme-caret) and so are their class strings, because `app.css` keys
 * the segmented track and its sliding caret off exactly those. Renaming them
 * to match the new home would have been a restyle of the one control the
 * overhaul is not changing the look of.
 *
 * ── Unlike every other section here, this one is STATEFUL ─────────────
 *
 * ./index.tsx's header explains why the panes are static: settings.js binds
 * every control by id, once, and a React re-render of a pane would silently
 * stop those listeners firing. Nothing in settings.js binds anything inside
 * this track — the segments' onClick is React's — so it is the one pane that
 * may hold state, and it needs to: the active segment and the caret index are
 * derived from `Theme.get()`, which is only readable on the client.
 */

import { useCallback, useRef, useState } from 'react';

import { SectionHeading } from '@/components/ui/field';

import { useIsomorphicLayoutEffect, useWindowEvent } from '../../../lib/legacy-dom';

// Order of the three segments in the DOM — also the caret's stop index, so the
// two can never disagree.
const THEME_MODES = ['light', 'dark', 'system'] as const;
type ThemeMode = (typeof THEME_MODES)[number];

const THEME_SEG_CLASS =
  'theme-seg flex-1 basis-0 rounded-md px-1.5 py-1 transition-colors';

const THEME_LABELS: Record<ThemeMode, string> = {
  light: 'Light',
  dark: 'Dark',
  system: 'System',
};

/**
 * The Light / Dark / System segmented control — App.HeaderMenu's
 * _renderThemeButtons(), as state.
 *
 * `mode` starts null, which renders EXACTLY the markup the hand-written shell
 * shipped: no `theme-seg-active`, `aria-checked="false"` on all three, and no
 * `--theme-caret-index` on the track. Theme.get() is only readable on the
 * client (the inline head block owns it), so reading it during render would
 * mismatch the prerender; the layout effect below fills it in on the first
 * client pass instead.
 *
 * The caret index is written through a ref rather than rendered as a `style`
 * prop for the same reason — the shipped track carries no style attribute, and
 * a custom property is not something to reconcile.
 *
 * Three things re-read the mode: a click on a segment, Theme.onChange
 * (another tab, the OS sunset switch), and every entry into this section
 * (`usernode:settings-section`, dispatched by settings.js where the drawer's
 * `usernode:header-menu-open` used to be). The last one covers a value that
 * changed while the viewer was elsewhere in Settings.
 */
function ThemeControl() {
  const [mode, setMode] = useState<ThemeMode | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);

  const sync = useCallback(() => {
    const current = window.Theme?.get?.();
    setMode(
      THEME_MODES.includes(current as ThemeMode) ? (current as ThemeMode) : null,
    );
  }, []);

  useIsomorphicLayoutEffect(() => {
    sync();
    // Storage/OS-driven changes (other tab, OS sunset switch) re-highlight too.
    window.Theme?.onChange?.(sync);
  }, [sync]);

  // Reflect the current mode on every entry into this section — covers
  // cross-tab changes and explicit values that happen to match the OS.
  useWindowEvent('usernode:settings-section', sync);

  useIsomorphicLayoutEffect(() => {
    const track = trackRef.current;
    if (!track || mode === null) return;
    // The caret is moved by writing --theme-caret-index (0|1|2) on the track
    // and letting CSS translate a thirds-width element by index * 100%.
    // Deliberately NOT a pixel measurement. In the drawer this ran before
    // PlatformUI.panel resized the panel from w-60 to the kit drawer's
    // --un-panel-width, so a pixel read was stale the moment the panel
    // presented; here the pane is `hidden` until the section opens, so a
    // pixel read would be taken on a zero-width box. Percentages are correct
    // in every one of those states with no re-measure, and the transition in
    // CSS is what makes the caret slide.
    track.style.setProperty(
      '--theme-caret-index',
      String(Math.max(0, THEME_MODES.indexOf(mode))),
    );
  }, [mode]);

  // Sets the mode and re-highlights in place, so the viewer can see the
  // recolor and switch again without leaving the section.
  const choose = useCallback(
    (next: ThemeMode) => {
      window.Theme?.set?.(next);
      sync();
    },
    [sync],
  );

  return (
    <div
      id="drawer-theme-track"
      ref={trackRef}
      role="radiogroup"
      aria-label="Theme"
      className="relative flex p-0.5 rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 text-xs font-medium"
    >
      {THEME_MODES.map((m) => (
        <button
          key={m}
          type="button"
          role="radio"
          aria-checked={mode === m ? 'true' : 'false'}
          data-theme-mode={m}
          className={mode === m ? `${THEME_SEG_CLASS} theme-seg-active` : THEME_SEG_CLASS}
          onClick={() => choose(m)}
        >
          {THEME_LABELS[m]}
        </button>
      ))}
      <span id="drawer-theme-caret-track" aria-hidden="true">
        <span id="drawer-theme-caret">
        </span>
      </span>
    </div>
  );
}

export function ThemeSection() {
  return (
    <div data-settings-section="theme" className="hidden">
      <div id="settings-theme-section">
        <SectionHeading title="Theme">
          Light, dark, or follow your device. Applies everywhere on this browser.
        </SectionHeading>
        <div className="max-w-xs">
          <ThemeControl />
        </div>
      </div>
    </div>
  );
}
