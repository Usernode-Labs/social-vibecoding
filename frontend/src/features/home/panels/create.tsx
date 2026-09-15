/**
 * The Create app block.
 *
 * The only one of the three that is NOT drawn in a `PanelShell`: it has no
 * title bar, no ⋮ and no footer, because the whole block is one button. Its
 * `data-create-enabled` is stamped on the block itself and mirrored onto the
 * section host, so `[data-panel-slot="create"][data-create-enabled="true"]`
 * — the way dapp.json and the screenshot assertions write it — matches one
 * element.
 *
 * ── It is on every home screen, for every account ─────────────────────
 *
 * An account with no app quota gets the same block in the same place —
 * dimmed, and tapping it says why — rather than having it silently absent.
 * Two reasons that is the right shape:
 *
 *   1. `canCreateApps` is DERIVED per request (full-admin write access or
 *      `live app count < app_quota`, see /api/auth/me), so it flips without
 *      any user action:
 *      creating your one allowed app, an admin editing your quota, an app
 *      erroring out. A conditional block would turn each of those flips into a
 *      layout change under the user.
 *   2. Reaching the allowance should leave its details and request action
 *      in the same place.
 *
 * The locked treatment belongs to the widget, not to the button: the button's
 * available action is now "open the quota details", so marking that control
 * disabled to assistive technology would be false. `data-create-enabled` and
 * the dimmed class still describe whether app creation itself is available.
 *
 * ── What the conversion retired ───────────────────────────────────────
 *
 * `Home.wireCreateButtons()` bound this button, and is GONE. It did a
 * `cloneNode` + `replaceChild` to clear stale listeners — discipline the
 * string renderer needed because every paint rebuilt the node, and a
 * structural DOM write React must not see under a host it owns. React keeps
 * the element and the handler is a prop, so neither half applies any more; the
 * helper had no other caller and no other matching element, so leaving it
 * would have left a loaded gun pointed at this block.
 */

import { useAppAllowance, quotaHeadline } from '../../dialogs/app-allowance';
import { PlusWideIcon } from '@/components/ui/icons';

import type { CreateView } from '../panels-store';

function win(): any {
  return typeof window !== 'undefined' ? (window as any) : {};
}

// ── The placeholder card's shape ──────────────────────────────────────
//
// The block is drawn the way the Challenges area's locked placeholder is
// (features/leaderboard/locked-challenges-card.tsx): a 24px dashed card with a
// 12px inset, an 80px hatched tile holding one glyph at a concentric 11px, and
// a title over a quieter second line. Two dashed empty slots on one screen say
// one thing, "something goes here", so they share one geometry. What differs
// is the glyph and the ink: a plus where that card has a lock, and while
// creation is available the stroke, the faint fill, the hatch and the title
// all take the blue accent (`violet-*` IS the blue, see tailwind.config.js).
// At the limit it steps down to the placeholder's own neutrals, which is what
// "present but locked" already looks like one section up.
//
// Tailwind's native `border-dashed`, not the SVG outline app.css used to paint
// this tile with: the placeholder is native dashed, and two dash rhythms one
// section apart would be the difference a reader spots first. The classes are
// complete literals, because Tailwind's extractor is a regex over source text.
const BTN = 'home-create-btn home-create-tile flex w-full min-h-[6.5rem] flex-row items-center gap-3 '
  + 'rounded-3xl border border-dashed p-3 text-left transition-colors';
const BTN_ON = 'border-violet-500/50 bg-violet-500/[0.04] hover:border-violet-500/80 hover:bg-violet-500/[0.08] '
  + 'dark:border-violet-400/40 dark:bg-violet-400/[0.06] dark:hover:border-violet-400/70 dark:hover:bg-violet-400/[0.1]';
const BTN_OFF = 'border-zinc-300 bg-white/40 dark:border-zinc-700 dark:bg-white/[0.03]';
const TILE = 'home-create-glyph flex h-20 w-20 shrink-0 items-center justify-center rounded-[0.6875rem]';
const TILE_ON = 'text-violet-600 dark:text-violet-400 '
  + 'bg-[repeating-linear-gradient(135deg,rgb(31_134_255/0.1)_0_6px,rgb(31_134_255/0.04)_6px_12px)] '
  + 'dark:bg-[repeating-linear-gradient(135deg,rgb(90_169_255/0.14)_0_6px,rgb(90_169_255/0.05)_6px_12px)]';
const TILE_OFF = 'text-zinc-500 dark:text-zinc-400 '
  + 'bg-[repeating-linear-gradient(135deg,rgb(24_24_27/0.05)_0_6px,rgb(24_24_27/0.02)_6px_12px)] '
  + 'dark:bg-[repeating-linear-gradient(135deg,rgb(255_255_255/0.07)_0_6px,rgb(255_255_255/0.03)_6px_12px)]';
const TITLE_ON = 'home-create-label truncate text-base font-medium leading-6 text-violet-700 dark:text-violet-400';
const TITLE_OFF = 'home-create-label truncate text-base font-medium leading-6 text-zinc-600 dark:text-zinc-300';
const HINT = 'truncate text-[0.8125rem] leading-5 text-zinc-500 dark:text-zinc-400';

export function CreatePanel({ view }: { view: CreateView }) {
  const { quota } = useAppAllowance();
  const on = view.canCreate;
  const label = on ? 'Create a new app' : `View app quota. ${view.hint}`;
  return (
    // ONE SHAPE, a row at every width: the widget's grid footprint was once
    // 4x1 below 640px and 1x1 at and above it, and the stacked variant existed
    // for a 150px cell that is gone. The block is as tall as the placeholder
    // card it mirrors.
    <div
      // `pt-2` on the heading's `pb-1.5` is the 14px step the Challenges cards
      // sit under their heading at.
      className={on ? 'home-create-widget pt-2' : 'home-create-widget home-create-widget--disabled pt-2'}
      data-panel={view.key}
      data-create-enabled={String(on)}
    >
      <button
        type="button"
        className={`${BTN} ${on ? BTN_ON : BTN_OFF}`}
        title={label}
        aria-label={label}
        onClick={(e) => {
          e.stopPropagation();
          // Both states open the same dialog. At the limit, its quota row
          // explains the lock and its submit button is disabled; hiding the
          // dialog behind a generic toast would make the numbers unreachable
          // precisely when they matter most.
          win().App?.showCreateModal?.();
        }}
      >
        <span className={`${TILE} ${on ? TILE_ON : TILE_OFF}`} aria-hidden="true">
          <PlusWideIcon className="h-[1.625rem] w-[1.625rem]" strokeWidth="2" />
        </span>
        <span className="flex min-w-0 flex-col">
          <span className={on ? TITLE_ON : TITLE_OFF}>Create app</span>
          {quota ? <span className={HINT}>{quotaHeadline(quota)}</span> : null}
        </span>
      </button>
    </div>
  );
}
