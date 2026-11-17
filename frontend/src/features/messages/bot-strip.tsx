import { t as translate } from '../../lib/i18n/runtime';
import { requestHue } from './bot-request';
import { ENDED_STAGES, trackLine, trackShort, trackStateWord } from './bot-track';
import type { BotTrack, HomeroomBotWork } from './types';
import { dayNumber } from '../../lib/time-zone';

/*
 * Where each of the viewer's requests stands now, read from their tracks
 * (./bot-work.tsx: each request's stored work state, services/work-state.js),
 * counted in words ("1 needs you · 2 in progress", ./index.tsx), with how a
 * request ended in words and a request's number in its colour.
 *
 * 5 Nov 2026 (docs/plans/bot-one-model.md): the activity drawer this module
 * drew under the bot chat's header is gone. 14 Nov 2026: so are the one-line
 * news rows of the chat's own stream, which no screen draws since every
 * conversation with the bot became a thread, and with them the tiles and
 * small squares those rows were drawn with. The chat lives on the Homeroom
 * bot tab, whose list is where each request stands (features/ai/).
 */

export type StripGroup = 'needs' | 'ready' | 'progress' | 'done';

/** One request, where it stands now. */
export interface StripRow {
  key: string;
  group: StripGroup;
  /** What its line says under the title. */
  state: string;
  track: BotTrack;
}

export interface StripModel {
  needs: StripRow[];
  ready: StripRow[];
  progress: StripRow[];
  done: StripRow[];
}

/**
 * Pure: midnight of `now`'s local day, where "today" starts. #5392: what
 * "Finished today" counts is what ended since then, on the viewer's own
 * device, which is also where the chat starts its "Today" divider.
 */
export function startOfDay(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

/** Pure: how a track ended, as one of the endings below (ENDINGS), or null for one that has not ended. */
export function trackEnding(track: Pick<BotTrack, 'work' | 'doneBy'>): string | null {
  const { stage, reason } = track.work;
  if (stage === 'live') return 'live';
  if (stage === 'going_live') return 'going_live';
  if (stage === 'closed') return track.doneBy ? 'done_elsewhere' : 'closed';
  if (stage === 'stopped') return reason === 'build_failed' ? 'build_failed' : reason === 'look_failed' ? 'failed' : 'stopped';
  return null;
}

/**
 * Pure (17 Oct 2026): each request once, by its stage. Needs you is what
 * waits on the person (its stage waits for them, or stopped); Ready to try,
 * a change up for a vote; In progress, everything under way, a hold among
 * it; what ended today, since midnight, Finished today.
 */
export function stripGroups(work: HomeroomBotWork | null, now: Date = new Date()): StripModel {
  const model: StripModel = { needs: [], ready: [], progress: [], done: [] };
  const seen = new Set<string>();
  for (const track of work?.tracks || []) {
    if (seen.has(track.key)) continue;
    seen.add(track.key);
    const row = (group: StripGroup, state: string): StripRow => ({ key: track.key, group, state, track });
    const { stage } = track.work;
    const held = track.held && (track.held.limit === 'builds' || track.held.limit === 'slots');
    if (stage === 'waiting_for_you' || stage === 'stopped') model.needs.push(row('needs', trackLine(track)));
    else if (stage === 'up_for_vote') model.ready.push(row('ready', trackStateWord(track)));
    else if (held) model.progress.push(row('progress', [trackStateWord(track), trackShort(track)].join(' · ')));
    else if (ENDED_STAGES.has(stage)) {
      const at = Date.parse(track.since || '');
      // #6479: today in the zone picked in Settings › Language, as the chat's
      // own Today divider reads it (else the device's, as startOfDay).
      if (!Number.isFinite(at) || dayNumber(new Date(at)) < dayNumber(now)) continue;
      model.done.push(row('done', endedWords(trackEnding(track), track, trackLine(track))));
    } else model.progress.push(row('progress', trackLine(track)));
  }
  return model;
}

/** Pure: a model's counts in words, zeros left out ("1 needs you · 2 in progress"). */
export function summaryParts(model: StripModel): Array<{ group: StripGroup; text: string }> {
  const parts: Array<{ group: StripGroup; text: string }> = [];
  if (model.needs.length) parts.push({ group: 'needs', text: translate('messages:bot.strip.summary.needs', { count: model.needs.length }) });
  if (model.ready.length) parts.push({ group: 'ready', text: translate('messages:bot.strip.summary.ready', { count: model.ready.length }) });
  if (model.progress.length) parts.push({ group: 'progress', text: translate('messages:bot.strip.summary.progress', { count: model.progress.length }) });
  if (model.done.length) parts.push({ group: 'done', text: translate('messages:bot.strip.summary.done', { count: model.done.length }) });
  return parts;
}

const TAG = 'inline-flex shrink-0 items-center rounded-[6px] px-1.5 font-semibold tabular-nums bg-[hsl(var(--req-h)_80%_92%)] text-[hsl(var(--req-h)_70%_26%)] dark:bg-[hsl(var(--req-h)_35%_25%)] dark:text-[hsl(var(--req-h)_80%_82%)]';

/** A request's number, "#18", in its own colour: the same in the chat and its thread. */
export function RequestTag({ number, size = 'row' }: { number: number | null | undefined; size?: 'row' | 'line' | 'head' }) {
  if (!number || number <= 0) return null;
  const text = size === 'head' ? 'text-[13px] leading-5' : 'text-[12px] leading-[18px]';
  return (
    <span className={`${TAG} ${text}`} style={{ ['--req-h' as string]: String(requestHue(number)) }} data-request-tag={number}>
      {`#${number}`}
    </span>
  );
}

// ── How a request ended ──

type EndingTone = 'good' | 'ended' | 'trouble';
interface Ending { key: string; tone: EndingTone }

/**
 * A settled request's ending, by what its last run came to (the activity
 * cards' tones, ./bot-activity.tsx): made it in, ended without a change, or
 * went wrong. `person` is the bot stepping back (homeroom-bot.js handOff): a
 * call for a person to make, a change it may revise no further, failures it
 * cannot fix safely; a person. Endings that still wait on somebody are never
 * settled, so they are not here.
 */
const ENDINGS: Record<string, Ending> = {
  live: { key: 'messages:bot.final.live', tone: 'good' },
  going_live: { key: 'messages:bot.final.goingLive', tone: 'good' },
  done_elsewhere: { key: 'messages:bot.final.doneElsewhere', tone: 'good' },
  closed: { key: 'messages:bot.final.closed', tone: 'ended' },
  person: { key: 'messages:bot.final.person', tone: 'ended' },
  held: { key: 'messages:bot.final.held', tone: 'ended' },
  stopped: { key: 'messages:bot.final.stopped', tone: 'ended' },
  build_failed: { key: 'messages:bot.final.failed', tone: 'trouble' },
  failed: { key: 'messages:bot.final.failed', tone: 'trouble' },
};

/**
 * Pure: how a request ended, in words, on a Finished today row: the
 * ending's own word ("Live", "Closed"), and for a build that
 * went wrong the reason with it ("Couldn’t build · Its build didn't
 * finish"), the dot joining two whole sentences so each can be translated
 * on its own. No record of how it ended: `fallback`, the words the row last
 * said.
 */
export function endedWords(outcome: string | null | undefined, track: BotTrack | null, fallback: string): string {
  const ending = outcome ? ENDINGS[outcome] : undefined;
  if (!ending) return fallback;
  const word = translate(ending.key);
  return ending.tone === 'trouble' && track ? `${word} · ${trackLine(track)}` : word;
}
