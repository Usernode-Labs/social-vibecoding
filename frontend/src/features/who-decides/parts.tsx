/**
 * #4666: the pieces the Who can see & change it sheet and the Make it step's
 * presets (./make-rule.tsx) share: the four preset tiles, how a preset plays out, and a face.
 * Drawn from the shell's primitives in its one accent (AGENTS.md, "Type and
 * colour"): the picked tile wears the accent ring; the one in force today
 * says "Now" and gets no fill.
 */

import type { ReactNode } from 'react';

import { GroupedList, ListRow } from '@/components/ui/grouped-list';
import {
  BallotIcon, BoltIcon, CheckIcon, HandRaisedIcon, SparklesIcon, UserGroupIcon,
} from '@/components/ui/icons';
import { IconTile } from '@/components/ui/icon-tile';

import { useMessages } from '../../lib/i18n/react';
import { swatchFor } from '../messages/format';
import { PRESET_KEYS, playsOut, presetLine, presetName, type PresetKey } from './model';

export interface Viewer {
  /** Whether the person reading made the project. */
  isCreator: boolean;
  /** The creator's username, or null (the platform's own project has none). */
  creator: string | null;
}

const PRESET_ICONS: Record<PresetKey, ReactNode> = {
  you_or_the_group: <BoltIcon aria-hidden="true" />,
  two_yeses: <HandRaisedIcon aria-hidden="true" />,
  open_floor: <SparklesIcon aria-hidden="true" />,
  group_vote: <BallotIcon aria-hidden="true" />,
};

export function presetIcon(key: PresetKey): ReactNode {
  return PRESET_ICONS[key];
}

/** A person's first letter on their swatch, as the chat draws them. */
export function Face({ name, size = 28 }: { name: string; size?: number }) {
  return (
    <span
      aria-hidden="true"
      className="inline-flex shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white"
      style={{ width: size, height: size, background: swatchFor(name) }}
    >
      {(name || '?').charAt(0).toUpperCase()}
    </span>
  );
}

export function Picked({ on }: { on: boolean }) {
  const t = useMessages('dialogs');
  return on
    ? <CheckIcon className="h-5 w-5 shrink-0 text-violet-600 dark:text-violet-400" aria-label={t('dialogs:whoDecides.picked')} />
    : <span className="h-5 w-5 shrink-0" aria-hidden="true" />;
}

const TILE = 'relative flex min-h-[44px] flex-col items-start gap-2 rounded-2xl bg-white p-3 text-left dark:bg-zinc-900';
const TILE_ON = 'shadow-[inset_0_0_0_2px_var(--accent)]';
const TILE_OFF = 'shadow-[inset_0_0_0_1px_var(--app-sheet-line)]';

/**
 * The four presets as tiles, two by two. `now` is the one in force (marked
 * "Now"); `picked` the one chosen on this screen (the accent ring).
 */
export function PresetTiles({ picked, now, viewer, onPick, labelId }: {
  picked: PresetKey | null;
  now: PresetKey | null;
  viewer: Viewer;
  onPick: (key: PresetKey) => void;
  labelId?: string;
}) {
  const t = useMessages('dialogs');
  return (
    <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-labelledby={labelId} data-who-presets="">
      {PRESET_KEYS.map((key) => (
        <button
          key={key}
          type="button"
          role="radio"
          aria-checked={picked === key}
          data-who-preset={key}
          onClick={() => onPick(key)}
          className={`${TILE} ${picked === key ? TILE_ON : TILE_OFF}`}
        >
          {now === key ? (
            <span className="absolute right-3 top-3 rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] font-semibold text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
              {t('dialogs:whoDecides.now')}
            </span>
          ) : null}
          <IconTile size="xs">{PRESET_ICONS[key]}</IconTile>
          <span className="text-[15px] font-[650] leading-tight">{presetName(key, viewer)}</span>
          <span className="text-[12.5px] leading-[1.35] text-zinc-500 dark:text-zinc-400">{presetLine(key, viewer)}</span>
        </button>
      ))}
    </div>
  );
}

/** The group's tile, beside a row about a change anyone (else) makes. */
const GROUP_TILE = <IconTile size="xs"><UserGroupIcon aria-hidden="true" /></IconTile>;

/**
 * How a preset, or a project's own rules (`preset` null), plays out. Two
 * yeses, Open floor, Group vote and a project's own rules say it in one row,
 * for anyone (#4894); You or the group says it for the person reading and
 * for anyone else.
 */
export function PlaysOut({ preset, viewer }: { preset: PresetKey | null; viewer: Viewer }) {
  const t = useMessages('dialogs');
  const lines = playsOut(preset, viewer);
  if ('anyone' in lines) {
    return (
      <GroupedList tone="plane" className="mx-0" data-who-plays="">
        <ListRow
          leading={GROUP_TILE}
          title={t('dialogs:whoDecides.plays.anyoneTitle')}
          subtitle={lines.anyone}
          chevron={false}
          subtitleClassName="whitespace-normal"
        />
      </GroupedList>
    );
  }
  return (
    <GroupedList tone="plane" className="mx-0" data-who-plays="">
      <ListRow
        leading={<Face name={viewer.creator && viewer.isCreator ? viewer.creator : 'you'} />}
        title={t('dialogs:whoDecides.plays.youTitle')}
        subtitle={lines.you}
        chevron={false}
        subtitleClassName="whitespace-normal"
      />
      <ListRow
        leading={GROUP_TILE}
        title={t('dialogs:whoDecides.plays.anyoneElseTitle')}
        subtitle={lines.other}
        chevron={false}
        subtitleClassName="whitespace-normal"
      />
    </GroupedList>
  );
}
