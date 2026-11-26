/**
 * A change's before & after shots, read for the one viewer that draws them
 * (./shots-viewer.tsx, on the Needs you page's slider, ./compare.tsx).
 *
 * The server sends one sanitised view model for a change's shots
 * (src/services/shots-view.js): its declared changes (`claims`), the stills
 * and clips (`artifacts`), the screens the run worked out (`screens`), how
 * each change came out (`shotResults`) and what the shots agent noticed
 * besides (`shotNotices`). This turns it into what the viewer draws:
 *
 *   - the screens, each one picture for the slider. They are shaped by
 *     `AppView._workshopVisuals`, the reading Needs you draws from, passed in
 *     as `shape` so this stays testable. A run with no worked-out screens (a
 *     new app's first version, which has no before; a run from before the
 *     screens were worked out) gets one picture per change and screen size,
 *     drawn whole;
 *   - the declared changes, numbered, each with what its shots leave out,
 *     what the shots agent did to both builds to reach it, and its clips;
 *   - the changes no screen shows (skipped, failed, or only a clip at a size
 *     no screen has), listed under the picture;
 *   - the problems noticed on the after build.
 *
 * Every address is checked again here: a still or clip is drawn only from
 * this change's own shots route, never from an absolute URL.
 */

import type { ReviewScreen } from './model';

export type ShotsTheme = 'light' | 'dark';
/** `AppView._workshopVisuals`: the screens Needs you draws, in a mode. */
export type ShotsShape = (visuals: unknown, shots: unknown, theme?: ShotsTheme) => { screens?: ReviewScreen[] } | null;

export type ShotsPersona = 'member' | 'readOnlyAdmin' | 'fullAdmin' | 'guest';
export type ShotStatus = 'ready' | 'unchanged' | 'skipped' | 'failed';

export interface ShotCondition {
  kind: 'request_held' | 'request_failed' | 'sample_file';
  request: string | null;
  files: string[];
}

export interface ShotClip {
  viewport: string;
  /** A motion change's clip of each side, with the side's still as its poster. */
  before: { url: string; poster: string | null } | null;
  after: { url: string; poster: string | null } | null;
  /** An older run's one paired recording, when it has no clip per side. */
  paired: string | null;
  /** A before player is drawn (a new app's first version has no before). */
  beforeShown: boolean;
  /** The change is declared as motion (else the paired recording is an interaction). */
  motion: boolean;
}

export interface ShotClaim {
  /** Its number: 1 is the first declared change. */
  n: number;
  id: string;
  text: string;
  steps: string[];
  viewports: string[];
  persona: ShotsPersona;
  /** The thing it adds was not on the before build. */
  absentBefore: boolean;
  status: ShotStatus | null;
  /** Why it was skipped or failed, in the shots agent's words. */
  reason: string;
  /** What its shots leave out ("Not in these shots: …"). */
  note: string;
  conditions: ShotCondition[];
  clips: ShotClip[];
}

export interface ShotScreen {
  key: string;
  viewport: string;
  /** The slider's screen: both sides and where they differ. */
  screen: ReviewScreen | null;
  /** A screen drawn whole, with one side or both, when there is no `screen`. */
  pair: { before: string | null; after: string | null; width: number; height: number } | null;
  /** The small copy a tile loads. */
  thumb: string | null;
  /** The declared changes it shows, by number. */
  claims: number[];
  /** Its size in CSS pixels, when the stills say. */
  size: { width: number; height: number } | null;
  seenAs: ShotsPersona[];
}

export interface ShotNotice {
  text: string;
  /** The declared change it was seen on, by number (0 when it does not say). */
  n: number;
  screen: string;
  alsoBefore: 'true' | 'false' | 'unknown';
}

export interface ShotsModel {
  previousVersion: boolean;
  afterOnly: boolean;
  /** The run took dark shots too, so the viewer offers both modes. */
  themes: boolean;
  withClips: boolean;
  takenByAgent: boolean;
  claims: ShotClaim[];
  screens: ShotScreen[];
  /** The changes listed under the picture, by number, and the clips each still needs there. */
  rest: { n: number; clips: ShotClip[] }[];
  notices: ShotNotice[];
  baseSha: string | null;
  headSha: string | null;
  planHash: string | null;
  /** Nothing to draw at all: no screen and no skipped or failed change. */
  missing: boolean;
}

type Raw = Record<string, any>;

const SHOTS_ROUTE = /^\/api\/apps\/[^/?#]+\/proposals\/(\d+)\/shots\/[0-9a-f]{32}(?:\?density=device|\?size=(?:thumb|screen))?$/;

/** A still's or clip's address, when it is this change's own shots route; else ''. */
export function shotUrl(url: unknown, sessionId: number | null | undefined): string {
  const value = String(url || '');
  const match = SHOTS_ROUTE.exec(value);
  if (!match) return '';
  if (Number.isInteger(sessionId) && Number(sessionId) > 0 && Number(match[1]) !== Number(sessionId)) return '';
  return value;
}

const MAX_SCREENS = 6;
const MAX_CLAIMS = 3;
const CONDITION_KINDS = new Set(['request_held', 'request_failed', 'sample_file']);

function personaOf(value: unknown): ShotsPersona {
  return value === 'read_only_admin' ? 'readOnlyAdmin'
    : value === 'full_admin' ? 'fullAdmin'
      : value === 'guest' ? 'guest' : 'member';
}

function viewportsOf(claim: Raw): string[] {
  return Array.isArray(claim.viewports) && claim.viewports.length
    ? claim.viewports.slice(0, 2).map(String)
    : ['desktop'];
}

/** The verified run a change shows: its own, or the previous version's while this one has none. */
export function shownShots(shots: unknown): Raw | null {
  if (!shots || typeof shots !== 'object') return null;
  const raw = shots as Raw;
  if (String(raw.state || '') === 'verified') return raw;
  const prev = raw.previous;
  if (!prev || typeof prev !== 'object' || prev.state !== 'verified'
    || !Array.isArray(prev.artifacts) || !prev.artifacts.length) return null;
  return { ...prev, previous: null, previousVersion: true };
}

/**
 * The viewer's reading of a verified run, or null for any other state (the
 * run's state card, ./shots-run.tsx, says where those stand).
 */
export function readShots(
  shots: unknown,
  { sessionId = null, shape = null, theme = 'light' }: {
    sessionId?: number | null; shape?: ShotsShape | null; theme?: ShotsTheme;
  } = {},
): ShotsModel | null {
  if (!shots || typeof shots !== 'object') return null;
  const raw = shots as Raw;
  if (String(raw.state || '') !== 'verified') return null;
  const artifacts: Raw[] = (Array.isArray(raw.artifacts) ? raw.artifacts : []).filter((a: unknown) => a && typeof a === 'object');
  const results: Raw[] = (Array.isArray(raw.shotResults) ? raw.shotResults : []).filter((r: unknown) => r && typeof r === 'object');
  const declared: Raw[] = (Array.isArray(raw.claims) ? raw.claims : []).filter((c: unknown) => c && typeof c === 'object').slice(0, MAX_CLAIMS);
  const afterOnly = raw.afterOnly === true;
  const themes = artifacts.some((a) => (a.theme || 'light') === 'dark');
  const mode: ShotsTheme = themes && theme === 'dark' ? 'dark' : 'light';
  const url = (a: Raw | null | undefined) => (a ? shotUrl(a.url, sessionId) : '');
  const by = (storyId: unknown, viewport: string, side: string, variant: string, media: string | null = null, look: ShotsTheme = 'light') => artifacts.find((a) => (
    a.storyId === storyId && a.viewport === viewport && a.side === side && a.variant === variant
    && (!media || a.media === media) && (a.theme || 'light') === look && url(a)
  )) || null;
  // A side in the viewer's mode, else its light shot.
  const still = (storyId: unknown, viewport: string, side: string) => (mode === 'dark'
    ? by(storyId, viewport, side, 'context', null, 'dark') || by(storyId, viewport, side, 'context')
    : by(storyId, viewport, side, 'context'));

  const claims: ShotClaim[] = declared.map((claim, index) => {
    const id = String(claim.id || '');
    const result = results.find((r) => r.id === claim.id) || null;
    const status = result && ['ready', 'unchanged', 'skipped', 'failed'].includes(result.status) ? result.status as ShotStatus : null;
    const shown = status === 'ready' || status === 'unchanged';
    const conditions: ShotCondition[] = shown && Array.isArray(result!.conditions)
      ? result!.conditions.slice(0, 4).flatMap((entry: Raw) => {
        if (!entry || !CONDITION_KINDS.has(entry.kind)) return [];
        const files = entry.kind === 'sample_file' && Array.isArray(entry.files)
          ? entry.files.filter((name: unknown) => typeof name === 'string' && name) as string[] : [];
        const request = entry.kind !== 'sample_file' && typeof entry.request === 'string' && entry.request ? entry.request : null;
        return files.length || request ? [{ kind: entry.kind, request, files }] : [];
      })
      : [];
    const viewports = viewportsOf(claim);
    const clips: ShotClip[] = viewports.flatMap((viewport): ShotClip[] => {
      // A motion change has a clip per side; older runs stored one paired
      // before/after recording instead.
      const base = by(claim.id, viewport, 'base', 'animation', 'webm');
      const head = by(claim.id, viewport, 'head', 'animation', 'webm');
      const paired = by(claim.id, viewport, 'paired', 'animation', 'webm');
      const poster = (side: string) => url(by(claim.id, viewport, side, 'context')) || null;
      if (base || head) {
        return [{
          viewport,
          before: base && !afterOnly ? { url: url(base), poster: poster('base') } : null,
          after: head ? { url: url(head), poster: poster('head') } : null,
          paired: null,
          beforeShown: !afterOnly,
          motion: claim.animation === 'motion',
        }];
      }
      if (paired) return [{ viewport, before: null, after: null, paired: url(paired), beforeShown: false, motion: claim.animation === 'motion' }];
      return [];
    });
    return {
      n: index + 1,
      id,
      text: String(claim.claim || ''),
      steps: Array.isArray(claim.steps) ? claim.steps.slice(0, 40).map(String) : [],
      viewports,
      persona: personaOf(claim.persona),
      absentBefore: claim.baseState === 'not_present',
      status,
      reason: result && typeof result.reason === 'string' ? result.reason : '',
      note: shown && typeof result!.note === 'string' ? result!.note : '',
      conditions,
      clips,
    };
  });
  const numberOf = (storyId: unknown) => claims.findIndex((c) => c.id === storyId) + 1;
  const off = (c: ShotClaim) => c.status === 'skipped' || c.status === 'failed';
  const onScreen = (numbers: number[]) => numbers.filter((n) => n > 0 && claims[n - 1] && !off(claims[n - 1]));
  const seenAs = (numbers: number[]) => [...new Set(numbers.map((n) => claims[n - 1].persona))];

  // The screens the run worked out, as Needs you shapes them, in the mode.
  const shaped = shape ? shape(null, raw, mode) : null;
  let screens: ShotScreen[] = (shaped && Array.isArray(shaped.screens) ? shaped.screens : []).map((screen, index) => {
    const numbers = onScreen(Array.isArray(screen.changes) ? screen.changes : []);
    return {
      key: `${screen.viewport}:${index}:${screen.after.url}`,
      viewport: screen.viewport,
      screen,
      pair: null,
      thumb: screen.after.thumb || screen.after.url,
      claims: numbers,
      size: screen.width > 0 && screen.after.height > 0 ? { width: Math.round(screen.width), height: Math.round(screen.after.height) } : null,
      seenAs: seenAs(numbers),
    };
  });
  if (!screens.length) {
    // One whole picture per change and screen size.
    for (const claim of claims.filter((c) => !off(c))) {
      for (const viewport of claim.viewports) {
        const before = afterOnly ? null : still(claim.id, viewport, 'base');
        const after = still(claim.id, viewport, 'head');
        if (!before && !after) continue;
        const lead = after || before!;
        const density = Number(lead.density) >= 1 ? Number(lead.density) : 1;
        const width = Number(lead.width) > 0 ? Number(lead.width) / density : 0;
        const height = Number(lead.height) > 0 ? Number(lead.height) / density : 0;
        screens.push({
          key: `${viewport}:${claim.id}`,
          viewport,
          screen: null,
          pair: { before: url(before) || null, after: url(after) || null, width, height },
          thumb: url(after) || url(before) || null,
          claims: [claim.n],
          size: width > 0 && height > 0 ? { width: Math.round(width), height: Math.round(height) } : null,
          seenAs: [claim.persona],
        });
      }
    }
  }
  // Grouped by screen size, phone after desktop as the run lists them.
  const sizes = [...new Set(screens.map((s) => s.viewport))];
  screens = sizes.flatMap((size) => screens.filter((s) => s.viewport === size)).slice(0, MAX_SCREENS);

  // What no screen describes: a change skipped or failed, one with no screen
  // of its own, and its clips at a size no screen shows.
  const shownAt = new Set(screens.flatMap((s) => s.claims.map((n) => `${n}|${s.viewport}`)));
  const rest = claims.flatMap((claim) => {
    if (off(claim)) return [{ n: claim.n, clips: [] }];
    const unseen = claim.viewports.filter((viewport) => !shownAt.has(`${claim.n}|${viewport}`));
    const clips = claim.clips.filter((clip) => unseen.includes(clip.viewport));
    if (unseen.length < claim.viewports.length && !clips.length) return [];
    return [{ n: claim.n, clips }];
  });

  const notices: ShotNotice[] = (Array.isArray(raw.shotNotices) ? raw.shotNotices : [])
    .filter((entry: Raw) => entry && typeof entry.text === 'string' && entry.text.trim())
    .slice(0, 5)
    .map((entry: Raw) => ({
      text: entry.text.trim(),
      n: numberOf(entry.change),
      screen: String(entry.screen || ''),
      alsoBefore: entry.alsoBefore === true ? 'true' : entry.alsoBefore === false ? 'false' : 'unknown',
    }));

  const sha = (value: unknown) => (typeof value === 'string' && value ? value : null);
  return {
    previousVersion: raw.previousVersion === true,
    afterOnly,
    themes,
    withClips: artifacts.some((a) => a.variant === 'animation'),
    takenByAgent: results.length > 0,
    claims,
    screens,
    rest,
    notices,
    baseSha: sha(raw.baseSha),
    headSha: sha(raw.headSha),
    planHash: sha(raw.planHash),
    missing: !screens.length && !claims.some(off),
  };
}

/** A commit as the card prints it: its first eight characters, or null when it is not one. */
export function shortSha(sha: string | null | undefined): string | null {
  return /^[0-9a-f]{40}$/i.test(String(sha || '')) ? String(sha).slice(0, 8) : null;
}
