/**
 * Settings → Accessibility: text size and high contrast (#3969), reduce
 * motion (#6510), and whether project cards play their animated previews.
 *
 * A page of one part, right after Appearance in Preferences, so the two
 * reading controls are visible without opening Appearance first. It follows
 * ./theme.tsx in every particular that matters there:
 *
 *  - The persistence lives in the inline `window.Display` block at the top
 *    of frontend/src/head.html — head-blocking, so the stored size and the
 *    contrast attribute land on <html> before first paint. This component
 *    reads and writes through that global and owns nothing but the
 *    highlight.
 *  - It is the second STATEFUL pane (with Theme): nothing in ../settings.js
 *    binds inside it, the segments' onClick and the switch's onChange are
 *    React's, and the active state is derived from storage, which is only
 *    readable on the client.
 *  - The initial render carries no selection: `size` starts null and the
 *    switch starts off, which is exactly the markup the prerender ships.
 *    Reading storage during render would mismatch the prerendered document.
 *  - Text size is a slider of five stops (#6510), a native range input in
 *    the accent, as the photo crop's zoom is. No new colours.
 *  - The page opens with a Preview card (#6510): a sample drawn in the
 *    choices below, with a line saying them in words. It sets nothing.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { SectionHeading } from '@/components/ui/field';
import { Switch } from '@/components/ui/switch';

import { onPreviewsPref, previewsOn, setPreviewsOn } from '../../../lib/card-previews';
import { useMessages } from '../../../lib/i18n/react';
import { useIsomorphicLayoutEffect, useWindowEvent } from '../../../lib/legacy-dom';
import { onReducedMotionChange, reducedMotion } from '../../../lib/reduced-motion';

// The slider's five stops, smallest first, and what each stores: Normal
// removes the key; the others store their name. `large` and `larger` are the
// two presets of #3969, so a size picked before the slider still applies.
const TEXT_SIZES = ['normal', 'large', 'larger', 'xlarge', 'xxlarge'] as const;
type TextSize = (typeof TEXT_SIZES)[number];

// What each stop makes the root font, as app.css sets it; shown rounded.
const SIZE_PERCENT: Record<TextSize, number> = {
  normal: 100,
  large: 112.5,
  larger: 125,
  xlarge: 137.5,
  xxlarge: 150,
};

/**
 * The text size slider (#6510): five stops from 100% to 150%, in place of
 * the Normal / Large / Larger segments. A native range input, so the arrow
 * keys, Home and End move it, and a screen reader hears its name and the
 * size as a percentage (`aria-valuetext`).
 *
 * The size is applied when the browser's own `change` fires: on release for
 * a drag, and on every key press. React's onChange is the `input` event,
 * which fires all through a drag; it only moves the figure beside the
 * slider. Applying mid-drag would resize the page under the pointer, the
 * slider with it.
 *
 * Three things re-read the size, like the theme's: a pick, Display.onChange
 * (another tab, the storage event), and every entry into this section
 * (`usernode:settings-section`).
 */
function TextSizeControl() {
  const t = useMessages('settings');
  const [size, setSize] = useState<TextSize | null>(null);
  // Where the thumb is while it is being dragged; null once applied.
  const [dragAt, setDragAt] = useState<number | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const sync = useCallback(() => {
    const current = window.Display?.getTextSize?.();
    setSize(
      TEXT_SIZES.includes(current as TextSize) ? (current as TextSize) : null,
    );
  }, []);

  useIsomorphicLayoutEffect(() => {
    sync();
    window.Display?.onChange?.(sync);
  }, [sync]);

  useWindowEvent('usernode:settings-section', sync);

  useEffect(() => {
    const el = input.current;
    if (!el) return undefined;
    const apply = () => {
      const next = TEXT_SIZES[Number(el.value)] ?? 'normal';
      window.Display?.setTextSize?.(next);
      setDragAt(null);
      sync();
    };
    el.addEventListener('change', apply);
    return () => el.removeEventListener('change', apply);
  }, [sync]);

  const at = dragAt ?? Math.max(0, TEXT_SIZES.indexOf(size ?? 'normal'));
  const percent = Math.round(SIZE_PERCENT[TEXT_SIZES[at]]);
  const value = t('settings:accessibility.textSize.percent', { percent });

  // `ui-card ui-pad` (looks v2): one padded card under a look, nothing in
  // the standard one.
  return (
    <div id="settings-text-size-track" className="ui-card ui-pad flex items-center gap-3">
      <span aria-hidden="true" className="shrink-0 text-xs font-semibold text-zinc-500 dark:text-zinc-400">
        {t('settings:accessibility.textSize.sample')}
      </span>
      <input
        ref={input}
        type="range"
        min={0}
        max={TEXT_SIZES.length - 1}
        step={1}
        value={at}
        data-text-size-slider=""
        aria-label={t('settings:accessibility.textSize.controlName')}
        aria-valuetext={value}
        className="flex-1 min-w-0 h-11 accent-violet-600"
        onChange={(e) => setDragAt(Number(e.currentTarget.value))}
      />
      <span aria-hidden="true" className="shrink-0 text-xl font-semibold text-zinc-500 dark:text-zinc-400">
        {t('settings:accessibility.textSize.sample')}
      </span>
      <span
        aria-hidden="true"
        data-text-size-value=""
        className="shrink-0 w-12 text-end text-sm tabular-nums text-zinc-800 dark:text-zinc-200"
      >
        {value}
      </span>
    </div>
  );
}

/**
 * The Preview card (#6510): a sample of the app (a heading with a dot, a
 * sentence and a button) so a choice made below is seen where it is made.
 *
 * It sets nothing. Text size and contrast restyle it with the rest of the
 * page, through the attributes the head module writes on <html>; the dot
 * pulses under `motion-safe:`, so it stops for the Reduce motion switch and
 * for the device's own prefers-reduced-motion alike. The card reads the
 * settings only to say them in words on its last line, which a screen
 * reader hears too.
 *
 * The first render has no last line: storage is client-only, as for the
 * controls. The sample is a picture (aria-hidden), and its button is a span,
 * so nobody tabs to it or takes it for a real vote.
 */
function PreviewCard() {
  const t = useMessages('settings');
  const [shown, setShown] = useState<{ percent: number; contrast: boolean; still: boolean } | null>(null);

  const sync = useCallback(() => {
    const current = window.Display?.getTextSize?.();
    const size = TEXT_SIZES.includes(current as TextSize) ? (current as TextSize) : 'normal';
    setShown({
      percent: Math.round(SIZE_PERCENT[size]),
      contrast: !!window.Display?.getContrast?.(),
      still: reducedMotion(),
    });
  }, []);

  useIsomorphicLayoutEffect(() => {
    sync();
    window.Display?.onChange?.(sync);
    // The device's own setting changing, which Display.onChange does not see.
    return onReducedMotionChange(sync);
  }, [sync]);

  useWindowEvent('usernode:settings-section', sync);

  return (
    <div
      id="settings-accessibility-preview"
      className="ui-card mb-6 rounded-[20px] bg-[color:var(--dc-sheet-solid)] p-4 shadow-[inset_0_0_0_1px_var(--app-sheet-line)]"
    >
      <div aria-hidden="true">
        <div className="flex items-center gap-2.5">
          <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-violet-600 motion-safe:animate-pulse" />
          <span className="text-[0.9375rem] font-[650] text-zinc-900 dark:text-zinc-100">
            {t('settings:accessibility.preview.sampleTitle')}
          </span>
        </div>
        <p className="mt-1.5 text-[0.8125rem] text-zinc-500 dark:text-zinc-500">
          {t('settings:accessibility.preview.sampleText')}
        </p>
        <span className="mt-3 inline-flex items-center justify-center rounded-full bg-violet-600 px-4 py-1.5 text-[0.8125rem] font-semibold text-white">
          {t('settings:accessibility.preview.sampleButton')}
        </span>
      </div>
      <p
        id="settings-accessibility-preview-summary"
        aria-live="polite"
        className="mt-3 text-xs text-zinc-500 dark:text-zinc-500"
      >
        {/* Three whole sentences as one text child: a bare {' '} between
            them would not survive hydration. */}
        {shown == null ? null : [
          t('settings:accessibility.preview.summary.size', {
            size: t('settings:accessibility.textSize.percent', { percent: shown.percent }),
          }),
          shown.contrast
            ? t('settings:accessibility.preview.summary.contrastOn')
            : t('settings:accessibility.preview.summary.contrastOff'),
          shown.still
            ? t('settings:accessibility.preview.summary.motionReduced')
            : t('settings:accessibility.preview.summary.motionPlays'),
        ].join(' ')}
      </p>
    </div>
  );
}

/**
 * The High contrast switch — the same switch-with-explanation row as
 * "Keep sidebar open in apps", minus the desktop-only class: contrast
 * matters at every width. It does not follow the device's own
 * "increase contrast" setting; it is off until turned on.
 */
function HighContrastRow() {
  const t = useMessages('settings');
  const [on, setOn] = useState(false);

  const sync = useCallback(() => setOn(!!window.Display?.getContrast?.()), []);

  useIsomorphicLayoutEffect(() => {
    sync();
    window.Display?.onChange?.(sync);
  }, [sync]);

  useWindowEvent('usernode:settings-section', sync);

  return (
    <div className="mt-6 pt-6 border-t border-zinc-200 dark:border-zinc-800">
      {/* A neutral wrapper (looks v2): one card's switch row under a look. */}
      <div className="ui-card ui-swrow">
      <label className="flex items-center gap-2 cursor-pointer select-none">
        <Switch
          id="settings-high-contrast"
          aria-describedby="settings-high-contrast-note"
          checked={on}
          onChange={(e) => {
            const next = e.currentTarget.checked;
            window.Display?.setContrast?.(next);
            setOn(next);
          }}
        />
        <span className="text-sm text-zinc-800 dark:text-zinc-200">
          {t('settings:accessibility.contrast.label')}
        </span>
      </label>
      {/* Read with the switch (#6510). */}
      <p id="settings-high-contrast-note" className="text-xs text-zinc-500 dark:text-zinc-500 mt-2 leading-relaxed">
        {t('settings:accessibility.contrast.description')}
      </p>
      </div>
    </div>
  );
}

/**
 * Reduce motion (#6510): the same switch row as High contrast, through the
 * same head module. On, it writes data-motion="reduce" on <html>, which every
 * reduced-motion rule in app.css and native.css has a twin for, Tailwind's
 * motion-reduce:/motion-safe: variants read (scripts/build-tailwind.js), and
 * ../../../lib/reduced-motion.ts answers for script. Off is not "allow": the
 * device's own prefers-reduced-motion still applies, which the description
 * says.
 */
function ReduceMotionRow() {
  const t = useMessages('settings');
  const [on, setOn] = useState(false);

  const sync = useCallback(() => setOn(!!window.Display?.getMotion?.()), []);

  useIsomorphicLayoutEffect(() => {
    sync();
    window.Display?.onChange?.(sync);
  }, [sync]);

  useWindowEvent('usernode:settings-section', sync);

  return (
    <div className="mt-6 pt-6 border-t border-zinc-200 dark:border-zinc-800">
      {/* The same neutral wrapper as High contrast (looks v2): one card's switch row under a look. */}
      <div className="ui-card ui-swrow">
      <label className="flex items-center gap-2 cursor-pointer select-none">
        <Switch
          id="settings-reduce-motion"
          aria-describedby="settings-reduce-motion-note"
          checked={on}
          onChange={(e) => {
            const next = e.currentTarget.checked;
            window.Display?.setMotion?.(next);
            setOn(next);
          }}
        />
        <span className="text-sm text-zinc-800 dark:text-zinc-200">
          {t('settings:accessibility.motion.label')}
        </span>
      </label>
      {/* Read with the switch (#6510). */}
      <p id="settings-reduce-motion-note" className="text-xs text-zinc-500 dark:text-zinc-500 mt-2 leading-relaxed">
        {t('settings:accessibility.motion.description')}
      </p>
      </div>
    </div>
  );
}

/**
 * "Play previews": a project card's short, silent loop plays when you point
 * at the card (../../../lib/card-previews.ts). On by default, kept on this
 * device, and
 * never playing anyway under reduced motion or Data Saver. Like the switch
 * above it, the first render is off and storage is read in an effect, so the
 * prerendered markup matches.
 */
function CardPreviewsRow() {
  const t = useMessages('settings');
  const [on, setOn] = useState(false);

  const sync = useCallback(() => setOn(previewsOn()), []);

  useIsomorphicLayoutEffect(() => {
    sync();
    return onPreviewsPref(sync);
  }, [sync]);

  useWindowEvent('usernode:settings-section', sync);

  return (
    <div className="mt-6 pt-6 border-t border-zinc-200 dark:border-zinc-800">
      {/* The same neutral wrapper as High contrast (looks v2): one card's switch row under a look. */}
      <div className="ui-card ui-swrow">
      <label className="flex items-center gap-2 cursor-pointer select-none">
        <Switch
          id="settings-card-previews"
          aria-describedby="settings-card-previews-note"
          checked={on}
          onChange={(e) => {
            const next = e.currentTarget.checked;
            setPreviewsOn(next);
            setOn(next);
          }}
        />
        <span className="text-sm text-zinc-800 dark:text-zinc-200">
          {t('settings:accessibility.previews.label')}
        </span>
      </label>
      {/* Read with the switch (#6510). */}
      <p id="settings-card-previews-note" className="text-xs text-zinc-500 dark:text-zinc-500 mt-2 leading-relaxed">
        {t('settings:accessibility.previews.description')}
      </p>
      </div>
    </div>
  );
}

export function AccessibilitySection() {
  const t = useMessages('settings');
  return (
    <div data-settings-section="accessibility" className="hidden">
      <div id="settings-accessibility-section">
        <SectionHeading title={t('settings:accessibility.preview.title')}>
          {t('settings:accessibility.preview.intro')}
        </SectionHeading>
        <PreviewCard />
        <SectionHeading title={t('settings:accessibility.textSize.title')}>
          {t('settings:accessibility.textSize.intro')}
        </SectionHeading>
        <div className="max-w-sm">
          <TextSizeControl />
        </div>
        <HighContrastRow />
        <ReduceMotionRow />
        <CardPreviewsRow />
      </div>
    </div>
  );
}
