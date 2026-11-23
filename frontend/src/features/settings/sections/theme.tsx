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
 * The track's id is unchanged too (#drawer-theme-track) and so are the class
 * strings, because `app.css` keys the segmented track off exactly those.
 * Renaming it to match the new home would have been a restyle of the one
 * control the overhaul is not changing the look of. The sliding caret that
 * sat under the chosen segment (#drawer-theme-caret-track,
 * #drawer-theme-caret) is gone: overnight UI audit D10, the owner's decision
 * of 2 Nov 2026. The lit segment says which one is chosen.
 *
 * ── Unlike every other section here, this one is STATEFUL ─────────────
 *
 * ./index.tsx's header explains why the panes are static: settings.js binds
 * every control by id, once, and a React re-render of a pane would silently
 * stop those listeners firing. Nothing in settings.js binds anything inside
 * this track — the segments' onClick is React's — so it is the one pane that
 * may hold state, and it needs to: the active segment is derived from
 * `Theme.get()`, which is only readable on the client.
 */

import { useCallback, useState } from 'react';

import { SectionHeading } from '@/components/ui/field';
import { Switch } from '@/components/ui/switch';

import { useMessages } from '../../../lib/i18n/react';
import { useIsomorphicLayoutEffect, useWindowEvent } from '../../../lib/legacy-dom';
import { radioGroupKeys } from '../../../lib/radio-group';
import { currentSkin } from '../../../lib/skin';

// Order of the three segments in the DOM.
const THEME_MODES = ['light', 'dark', 'system'] as const;
type ThemeMode = (typeof THEME_MODES)[number];

const THEME_SEG_CLASS =
  'theme-seg ui-row ui-row-sm flex-1 basis-0 rounded-md px-1.5 py-1 transition-colors';

const THEME_LABELS: Record<ThemeMode, string> = {
  light: 'settings:theme.mode.light',
  dark: 'settings:theme.mode.dark',
  system: 'settings:theme.mode.system',
};

/**
 * The radio mark a row wears under one of the frame's looks (looks v2: the
 * choices are radio rows in a card there). Never drawn by the standard look
 * (`ui-look-only`, app.css), whose segment says which one is chosen by its own fill.
 */
function RadioMark({ on }: { on: boolean }) {
  return (
    <span aria-hidden="true" className={on ? 'ui-chk ui-chk-on ui-look-only' : 'ui-chk ui-look-only'}>
      {on ? <span className="h-2 w-2 rounded-full bg-[color:var(--accent-ink)]" /> : null}
    </span>
  );
}

/**
 * The Light / Dark / System segmented control — App.HeaderMenu's
 * _renderThemeButtons(), as state.
 *
 * `mode` starts null, which renders EXACTLY the markup the hand-written shell
 * shipped: no `theme-seg-active` and `aria-checked="false"` on all three.
 * Theme.get() is only readable on the
 * client (the inline head block owns it), so reading it during render would
 * mismatch the prerender; the layout effect below fills it in on the first
 * client pass instead.
 *
 * Three things re-read the mode: a click on a segment, Theme.onChange
 * (another tab, the OS sunset switch), and every entry into this section
 * (`usernode:settings-section`, dispatched by settings.js where the drawer's
 * `usernode:header-menu-open` used to be). The last one covers a value that
 * changed while the viewer was elsewhere in Settings.
 */
function ThemeControl() {
  const t = useMessages('settings');
  const [mode, setMode] = useState<ThemeMode | null>(null);

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

  // Sets the mode and re-highlights in place, so the viewer can see the
  // recolor and switch again without leaving the section.
  const choose = useCallback(
    (next: ThemeMode) => {
      window.Theme?.set?.(next);
      sync();
    },
    [sync],
  );
  // One tab stop, and the arrow keys move the pick (#6510).
  const keys = radioGroupKeys(THEME_MODES, mode, choose);

  return (
    <div
      id="drawer-theme-track"
      role="radiogroup"
      aria-label={t('settings:theme.controlName')}
      onKeyDown={keys.onKeyDown}
      className="ui-card ui-radios relative flex p-0.5 rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 text-xs font-medium"
    >
      {THEME_MODES.map((m) => (
        <button
          key={m}
          type="button"
          role="radio"
          aria-checked={mode === m ? 'true' : 'false'}
          tabIndex={keys.tabIndex(m)}
          data-theme-mode={m}
          className={mode === m ? `${THEME_SEG_CLASS} theme-seg-active` : THEME_SEG_CLASS}
          onClick={() => choose(m)}
        >
          <RadioMark on={mode === m} />
          {t(THEME_LABELS[m])}
        </button>
      ))}
    </div>
  );
}

// ── The Template Chooser ───────────────────────────────────────────────
//
// Settings › Appearance (request #6984): the two visual styles a device can
// wear. Standard is today's look and the default. Sunrise draws the same
// pages in a warm cream light or deep plum dark token set (head.html
// window.Skin, 'sunrise'; app.css, THE SUNRISE TEMPLATE).
//
// The pics are fixed pictures of the real Home screen, not live drawings:
// the card is about choosing a whole style at a glance, and two live Homes
// twice over would be a heavier thing than the choice needs. Picking a
// picture APPLIES it at once (no Save button), exactly like the Theme
// control above: Sunrise light sets the light appearance, Sunrise dark the
// dark one, and Standard goes back to today's look without touching the
// appearance. The choice is kept on the device by window.Skin, the same
// place the Theme setting lives.
//
// It starts with nothing checked, which is the prerender: the live look and
// appearance are only readable on the client, so reading them during render
// would mismatch the hydrated document (a console error, which fails the
// proposal checks). The layout effect fills the highlight in on the first
// client pass, and follows a look or appearance changed anywhere else.
const TEMPLATE_CHOICES = ['standard', 'sunrise-light', 'sunrise-dark'] as const;
type TemplateChoice = (typeof TEMPLATE_CHOICES)[number];

const TEMPLATE_LABELS: Record<TemplateChoice, string> = {
  standard: 'settings:theme.template.standard',
  'sunrise-light': 'settings:theme.mode.light',
  'sunrise-dark': 'settings:theme.mode.dark',
};

/** The round mark a choice wears; the lit one is filled with the accent. */
function TemplateDot({ on }: { on: boolean }) {
  return <span aria-hidden="true" className={on ? 'tc-dot tc-dot-on' : 'tc-dot'} />;
}

function TemplateChooser() {
  const t = useMessages('settings');
  const [choice, setChoice] = useState<TemplateChoice | null>(null);

  const sync = useCallback(() => {
    const skin = currentSkin();
    if (skin === 'sunrise') {
      const dark = document.documentElement.classList.contains('dark');
      setChoice(dark ? 'sunrise-dark' : 'sunrise-light');
    } else {
      // Standard is the chooser's other choice. An admin's 'wip' or 'brand'
      // is not on it, so neither row is lit while one of those is on.
      setChoice(skin === 'standard' ? 'standard' : null);
    }
  }, []);

  useIsomorphicLayoutEffect(() => {
    sync();
    // A look or appearance changed anywhere else (the Theme control above,
    // the OS sunset switch, another tab) re-lights the right picture.
    window.Skin?.onChange?.(sync);
    window.Theme?.onChange?.(sync);
  }, [sync]);

  useWindowEvent('usernode:settings-section', sync);

  const choose = useCallback(
    (next: TemplateChoice) => {
      if (next === 'standard') {
        window.Skin?.set?.('standard');
      } else {
        // The appearance first, then the style: the picture keeps what it
        // showed when it was pressed.
        window.Theme?.set?.(next === 'sunrise-dark' ? 'dark' : 'light');
        window.Skin?.set?.('sunrise');
      }
      sync();
    },
    [sync],
  );
  const keys = radioGroupKeys(TEMPLATE_CHOICES, choice, choose);

  const tile = (value: 'sunrise-light' | 'sunrise-dark', src: string, alt: string) => {
    const on = choice === value;
    return (
      <button
        type="button"
        role="radio"
        aria-checked={on ? 'true' : 'false'}
        tabIndex={keys.tabIndex(value)}
        data-template-choice={value}
        className={on ? 'tc-tile tc-tile-on' : 'tc-tile'}
        onClick={() => choose(value)}
      >
        <span className="tc-head">
          <span>{t(TEMPLATE_LABELS[value])}</span>
          <TemplateDot on={on} />
        </span>
        <img className="tc-pic" src={src} width={160} height={190} alt={alt} loading="lazy" />
      </button>
    );
  };

  return (
    <div className="ui-card tc-card mt-6" data-template-chooser="">
      <SectionHeading title={t('settings:theme.template.title')}>
        {t('settings:theme.template.intro')}
      </SectionHeading>
      <div
        role="radiogroup"
        aria-label={t('settings:theme.template.controlName')}
        onKeyDown={keys.onKeyDown}
        className="tc-group"
      >
        <button
          type="button"
          role="radio"
          aria-checked={choice === 'standard' ? 'true' : 'false'}
          tabIndex={keys.tabIndex('standard')}
          data-template-choice="standard"
          className="tc-opt"
          onClick={() => choose('standard')}
        >
          <TemplateDot on={choice === 'standard'} />
          <span>{t('settings:theme.template.standard')}</span>
        </button>
        <div className="tc-style">{t('settings:theme.template.sunrise')}</div>
        <div className="tc-tiles">
          {tile('sunrise-light', '/brand/templates/sunrise-light.webp', t('settings:theme.template.previewLight'))}
          {tile('sunrise-dark', '/brand/templates/sunrise-dark.webp', t('settings:theme.template.previewDark'))}
        </div>
      </div>
    </div>
  );
}

// The key App._railPinned reads (public/js/app.js). Read here too so the
// switch can show the stored value before App exists, and written through
// App.setRailPinned so the router re-decides at once. ON unless '0' is
// stored: nothing stored is the default, and a '1' from when this was
// opt-in still reads as on.
export const RAIL_PINNED_KEY = 'usernode:rail-pinned';

function readRailPinned(): boolean {
  try {
    return window.localStorage.getItem(RAIL_PINNED_KEY) !== '0';
  } catch {
    return true;
  }
}

export function writeRailPinned(on: boolean): void {
  if (window.App?.setRailPinned) {
    window.App.setRailPinned(on);
    return;
  }
  try {
    if (on) window.localStorage.removeItem(RAIL_PINNED_KEY);
    else window.localStorage.setItem(RAIL_PINNED_KEY, '0');
  } catch { /* unwritable storage: the switch does not stick */ }
}

/**
 * "Keep sidebar open in apps" (#3319) — the desktop rail stays docked beside
 * a running app, with the sidebar toggle where the app's ✕ was. ON by
 * default; off gives the app the whole window and its ✕ back.
 *
 * DESKTOP ONLY, and the class string says so (`hidden md:block`): below
 * 768px the bar is the phone's bottom bar, which an app always covers.
 *
 * `pinned` starts true, which is the prerender (a checked switch, the
 * default), and the stored value arrives in an effect — localStorage is
 * client-only, and reading it during render would be a hydration mismatch
 * for anyone who had turned it off. Re-read on every entry into this
 * section, like the theme.
 */
function RailPinnedRow() {
  const t = useMessages('settings');
  const [pinned, setPinned] = useState(true);
  const sync = useCallback(() => setPinned(readRailPinned()), []);
  useIsomorphicLayoutEffect(() => { sync(); }, [sync]);
  useWindowEvent('usernode:settings-section', sync);

  return (
    <div className="hidden md:block ui-card ui-swrow mt-6 pt-6 border-t border-zinc-200 dark:border-zinc-800">
      <label className="flex items-center gap-2 cursor-pointer select-none">
        <Switch
          id="settings-rail-pinned"
          checked={pinned}
          onChange={(e) => {
            const next = e.currentTarget.checked;
            writeRailPinned(next);
            setPinned(next);
          }}
        />
        <span className="text-sm text-zinc-800 dark:text-zinc-200">
          {t('settings:theme.railPinned.label')}
        </span>
      </label>
      <p className="text-xs text-zinc-500 dark:text-zinc-500 mt-2 leading-relaxed">
        {t('settings:theme.railPinned.description')}
      </p>
    </div>
  );
}

export function ThemeSection() {
  const t = useMessages('settings');
  return (
    <div data-settings-section="theme" className="hidden">
      <div id="settings-theme-section">
        <SectionHeading title={t('settings:theme.title')}>
          {t('settings:theme.intro')}
        </SectionHeading>
        <div className="max-w-xs">
          <ThemeControl />
        </div>
        <TemplateChooser />
        <RailPinnedRow />
      </div>
    </div>
  );
}
