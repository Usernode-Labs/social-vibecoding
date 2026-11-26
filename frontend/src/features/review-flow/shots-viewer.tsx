/**
 * The one before & after viewer: a change's shots drawn with the Needs you
 * page's slider (./compare.tsx), wherever they are shown. A change's page
 * (its card, and that card expanded beside the thread), the change's section
 * on its request's page, Details, the preview's Before & after tab, the
 * About sheet and the admin Screenshot gallery all draw this, from the same
 * data (./shots-model.ts).
 *
 * One picture with a seam you drag between the two sides, the small switch
 * that flips it, each side's name printed on it, and press-and-hold to
 * magnify. Under it:
 *
 *   - the run's screens as tiles, when it has more than one (each screen size
 *     is a screen of its own), with "Screen 2 of 3";
 *   - the declared changes the screen shows, numbered, each with what its
 *     shots leave out, what the shots agent did to both builds to reach it,
 *     and its before and after clips when it is motion;
 *   - the changes no screen shows: skipped or failed, with the reason, or
 *     only a clip at a size no screen has;
 *   - "Also noticed": problems the shots agent saw on the after build.
 *
 * A run that took dark shots too offers the other mode (a moon or a sun at
 * the picture's foot); it starts in the page's mode. Expand, where the page
 * has somewhere to open it, opens the same viewer larger in the detail
 * column.
 */

import { useMemo, useRef, useState, type ReactNode } from 'react';

import { CrescentIcon, ExpandIcon, SunIcon } from '@/components/ui/icons';

import { RichMessage, useMessages } from '../../lib/i18n/react';
import { listText } from '../../lib/i18n/runtime';
// The preview's tab draws this in the prerendered shell (staging-overlay.tsx).
import { useIsomorphicLayoutEffect } from '../../lib/legacy-dom';
import { usePageDark } from '../../lib/page-theme';
import { shotThumb } from '../../lib/shot-img';
import { CAP_STRIP, CompareSlider, FOOT_STRIP, withinStrips } from './compare';
import { focusBox, placeBox, type Placement, type ReviewScreen } from './model';
import { readShots, type ShotClaim, type ShotClip, type ShotScreen, type ShotsModel, type ShotsPersona, type ShotsShape, type ShotsTheme } from './shots-model';

/** A change's shots, as every surface hands them to the viewer. */
export interface ShotsSource {
  /** The server's shots view model for the change (row.shots). */
  shots: unknown;
  /** The change (session) the shots are of: their addresses must be its own. */
  sessionId: number;
}

/** The tallest the picture gets, in px, on a card and expanded. */
export const PICTURE_MAX = 560;
export const PICTURE_MAX_EXPANDED = 820;

/**
 * Pure: how tall the picture is for a screen in a box `width` wide, and
 * where the screen sits in it. The changed area is framed, as on the Needs
 * you page, never drawn larger than life; a small change keeps some of the
 * screen round it, and a tall one is fitted to the room.
 */
export function pictureFrame(screen: ReviewScreen, width: number, max = PICTURE_MAX): { height: number; place: Placement } {
  const focus = focusBox(screen, ['before', 'after'], 24);
  const whole = Math.max(screen.before.height, screen.after.height);
  const scale = Math.min(1, width / focus.w);
  // The strips (#27) are inside the most, so the picture is no taller than that.
  const most = Math.min(max - CAP_STRIP - FOOT_STRIP, Math.max(240, width * 1.1));
  const least = Math.min(300, width * 0.62);
  const room = Math.max(1, Math.round(Math.min(whole * scale, most, Math.max(focus.h * scale, least))));
  // #27: the caption's strip over the screen and the switch's under it are
  // added to the picture, so the screen keeps all of its room.
  return { height: room + CAP_STRIP + FOOT_STRIP, place: withinStrips(placeBox(screen, focus, { w: width, h: room }, 1)) };
}

/** Pure: how tall a screen drawn whole is, at its own shape, within the most. */
export function wholeFrame(pair: NonNullable<ShotScreen['pair']>, width: number, max = PICTURE_MAX): number {
  const both = !!pair.before && !!pair.after;
  const shape = pair.width > 0 && pair.height > 0 ? pair.height / pair.width : 10 / 16;
  const strips = both ? CAP_STRIP + FOOT_STRIP : 0;
  return Math.max(120, Math.round(Math.min(width * shape, max - strips))) + strips;
}

const SIZE_NAME_IDS: Record<string, string> = {
  desktop: 'changes:shots.size.desktop',
  phone: 'changes:shots.size.phone',
  screen: 'changes:shots.size.screen',
};
const SIZE_WORD_IDS: Record<string, string> = {
  desktop: 'changes:shots.sizeWord.desktop',
  phone: 'changes:shots.sizeWord.phone',
};
const PICK_IDS: Record<string, string> = {
  desktop: 'changes:shots.viewer.pickDesktop',
  phone: 'changes:shots.viewer.pickPhone',
};
const PERSONA_IDS: Record<ShotsPersona, string> = {
  member: 'changes:shots.persona.member',
  readOnlyAdmin: 'changes:shots.persona.readOnlyAdmin',
  fullAdmin: 'changes:shots.persona.fullAdmin',
  guest: 'changes:shots.persona.guest',
};
const CONDITION_IDS = {
  request_held: 'changes:shots.claim.requestHeld',
  request_failed: 'changes:shots.claim.requestFailed',
  sample_file: 'changes:shots.claim.sampleFile',
} as const;

/**
 * "seen as …" under a screen, whole, by the people its changes were viewed
 * as, in the order they come up (persona keys joined with '+').
 */
const SEEN_AS_IDS: Record<string, string> = {
  'member': 'changes:shots.seenAs.member',
  'readOnlyAdmin': 'changes:shots.seenAs.readOnlyAdmin',
  'fullAdmin': 'changes:shots.seenAs.fullAdmin',
  'guest': 'changes:shots.seenAs.guest',
  'member+readOnlyAdmin': 'changes:shots.seenAs.memberReadOnlyAdmin',
  'member+fullAdmin': 'changes:shots.seenAs.memberFullAdmin',
  'member+guest': 'changes:shots.seenAs.memberGuest',
  'readOnlyAdmin+member': 'changes:shots.seenAs.readOnlyAdminMember',
  'readOnlyAdmin+fullAdmin': 'changes:shots.seenAs.readOnlyAdminFullAdmin',
  'readOnlyAdmin+guest': 'changes:shots.seenAs.readOnlyAdminGuest',
  'fullAdmin+member': 'changes:shots.seenAs.fullAdminMember',
  'fullAdmin+readOnlyAdmin': 'changes:shots.seenAs.fullAdminReadOnlyAdmin',
  'fullAdmin+guest': 'changes:shots.seenAs.fullAdminGuest',
  'guest+member': 'changes:shots.seenAs.guestMember',
  'guest+readOnlyAdmin': 'changes:shots.seenAs.guestReadOnlyAdmin',
  'guest+fullAdmin': 'changes:shots.seenAs.guestFullAdmin',
  'member+readOnlyAdmin+fullAdmin': 'changes:shots.seenAs.memberReadOnlyAdminFullAdmin',
  'member+readOnlyAdmin+guest': 'changes:shots.seenAs.memberReadOnlyAdminGuest',
  'member+fullAdmin+readOnlyAdmin': 'changes:shots.seenAs.memberFullAdminReadOnlyAdmin',
  'member+fullAdmin+guest': 'changes:shots.seenAs.memberFullAdminGuest',
  'member+guest+readOnlyAdmin': 'changes:shots.seenAs.memberGuestReadOnlyAdmin',
  'member+guest+fullAdmin': 'changes:shots.seenAs.memberGuestFullAdmin',
  'readOnlyAdmin+member+fullAdmin': 'changes:shots.seenAs.readOnlyAdminMemberFullAdmin',
  'readOnlyAdmin+member+guest': 'changes:shots.seenAs.readOnlyAdminMemberGuest',
  'readOnlyAdmin+fullAdmin+member': 'changes:shots.seenAs.readOnlyAdminFullAdminMember',
  'readOnlyAdmin+fullAdmin+guest': 'changes:shots.seenAs.readOnlyAdminFullAdminGuest',
  'readOnlyAdmin+guest+member': 'changes:shots.seenAs.readOnlyAdminGuestMember',
  'readOnlyAdmin+guest+fullAdmin': 'changes:shots.seenAs.readOnlyAdminGuestFullAdmin',
  'fullAdmin+member+readOnlyAdmin': 'changes:shots.seenAs.fullAdminMemberReadOnlyAdmin',
  'fullAdmin+member+guest': 'changes:shots.seenAs.fullAdminMemberGuest',
  'fullAdmin+readOnlyAdmin+member': 'changes:shots.seenAs.fullAdminReadOnlyAdminMember',
  'fullAdmin+readOnlyAdmin+guest': 'changes:shots.seenAs.fullAdminReadOnlyAdminGuest',
  'fullAdmin+guest+member': 'changes:shots.seenAs.fullAdminGuestMember',
  'fullAdmin+guest+readOnlyAdmin': 'changes:shots.seenAs.fullAdminGuestReadOnlyAdmin',
  'guest+member+readOnlyAdmin': 'changes:shots.seenAs.guestMemberReadOnlyAdmin',
  'guest+member+fullAdmin': 'changes:shots.seenAs.guestMemberFullAdmin',
  'guest+readOnlyAdmin+member': 'changes:shots.seenAs.guestReadOnlyAdminMember',
  'guest+readOnlyAdmin+fullAdmin': 'changes:shots.seenAs.guestReadOnlyAdminFullAdmin',
  'guest+fullAdmin+member': 'changes:shots.seenAs.guestFullAdminMember',
  'guest+fullAdmin+readOnlyAdmin': 'changes:shots.seenAs.guestFullAdminReadOnlyAdmin',
  'member+readOnlyAdmin+fullAdmin+guest': 'changes:shots.seenAs.memberReadOnlyAdminFullAdminGuest',
  'member+readOnlyAdmin+guest+fullAdmin': 'changes:shots.seenAs.memberReadOnlyAdminGuestFullAdmin',
  'member+fullAdmin+readOnlyAdmin+guest': 'changes:shots.seenAs.memberFullAdminReadOnlyAdminGuest',
  'member+fullAdmin+guest+readOnlyAdmin': 'changes:shots.seenAs.memberFullAdminGuestReadOnlyAdmin',
  'member+guest+readOnlyAdmin+fullAdmin': 'changes:shots.seenAs.memberGuestReadOnlyAdminFullAdmin',
  'member+guest+fullAdmin+readOnlyAdmin': 'changes:shots.seenAs.memberGuestFullAdminReadOnlyAdmin',
  'readOnlyAdmin+member+fullAdmin+guest': 'changes:shots.seenAs.readOnlyAdminMemberFullAdminGuest',
  'readOnlyAdmin+member+guest+fullAdmin': 'changes:shots.seenAs.readOnlyAdminMemberGuestFullAdmin',
  'readOnlyAdmin+fullAdmin+member+guest': 'changes:shots.seenAs.readOnlyAdminFullAdminMemberGuest',
  'readOnlyAdmin+fullAdmin+guest+member': 'changes:shots.seenAs.readOnlyAdminFullAdminGuestMember',
  'readOnlyAdmin+guest+member+fullAdmin': 'changes:shots.seenAs.readOnlyAdminGuestMemberFullAdmin',
  'readOnlyAdmin+guest+fullAdmin+member': 'changes:shots.seenAs.readOnlyAdminGuestFullAdminMember',
  'fullAdmin+member+readOnlyAdmin+guest': 'changes:shots.seenAs.fullAdminMemberReadOnlyAdminGuest',
  'fullAdmin+member+guest+readOnlyAdmin': 'changes:shots.seenAs.fullAdminMemberGuestReadOnlyAdmin',
  'fullAdmin+readOnlyAdmin+member+guest': 'changes:shots.seenAs.fullAdminReadOnlyAdminMemberGuest',
  'fullAdmin+readOnlyAdmin+guest+member': 'changes:shots.seenAs.fullAdminReadOnlyAdminGuestMember',
  'fullAdmin+guest+member+readOnlyAdmin': 'changes:shots.seenAs.fullAdminGuestMemberReadOnlyAdmin',
  'fullAdmin+guest+readOnlyAdmin+member': 'changes:shots.seenAs.fullAdminGuestReadOnlyAdminMember',
  'guest+member+readOnlyAdmin+fullAdmin': 'changes:shots.seenAs.guestMemberReadOnlyAdminFullAdmin',
  'guest+member+fullAdmin+readOnlyAdmin': 'changes:shots.seenAs.guestMemberFullAdminReadOnlyAdmin',
  'guest+readOnlyAdmin+member+fullAdmin': 'changes:shots.seenAs.guestReadOnlyAdminMemberFullAdmin',
  'guest+readOnlyAdmin+fullAdmin+member': 'changes:shots.seenAs.guestReadOnlyAdminFullAdminMember',
  'guest+fullAdmin+member+readOnlyAdmin': 'changes:shots.seenAs.guestFullAdminMemberReadOnlyAdmin',
  'guest+fullAdmin+readOnlyAdmin+member': 'changes:shots.seenAs.guestFullAdminReadOnlyAdminMember',
};

type T = ReturnType<typeof useMessages>;

/** A screen size's name ("Desktop"); one this build has no name for is shown as the server named it. */
export function sizeName(t: T, size: string): string {
  const id = SIZE_NAME_IDS[size];
  if (id) return t(id);
  const value = String(size || 'screen');
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** The same size inside a line of text ("desktop"). */
export function sizeWord(t: T, size: string): string {
  const id = SIZE_WORD_IDS[size];
  return id ? t(id) : String(size);
}

/**
 * "seen as …": the people a screen's changes were viewed as, in the order
 * they come up (the catalog has one whole message per order).
 */
export function seenAsText(t: T, people: ShotsPersona[]): string {
  return t(SEEN_AS_IDS[people.length ? people.join('+') : 'member'] || SEEN_AS_IDS.member);
}

export function personaText(t: T, persona: ShotsPersona): string {
  return t(PERSONA_IDS[persona]);
}

/** The default shape: the reading Needs you draws from. */
function legacyShape(): ShotsShape | null {
  const av = typeof window !== 'undefined' ? (window as any).AppView : null;
  return av && typeof av._workshopVisuals === 'function'
    ? (visuals, shots, theme) => av._workshopVisuals(visuals, shots, theme)
    : null;
}

const lead = <span className="font-medium text-zinc-700 dark:text-zinc-300" />;

/** What the shots leave out of a change, and what the shots agent did to both builds to reach it. */
function ClaimNotes({ claim }: { claim: ShotClaim }): ReactNode {
  return (
    <>
      {claim.note ? (
        <p data-shots-shot-note="1" className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
          <RichMessage id="changes:shots.claim.notInShots" values={{ note: claim.note }} components={[lead]} />
        </p>
      ) : null}
      {claim.conditions.map((entry, i) => (
        <p key={`${entry.kind}:${i}`} data-shots-condition={entry.kind} className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
          <RichMessage
            id={CONDITION_IDS[entry.kind]}
            values={entry.files.length ? { files: listText(entry.files) } : { request: `GET ${entry.request}` }}
            components={[lead]}
          />
        </p>
      ))}
    </>
  );
}

/** A motion change's clips at the given sizes: a before and an after player, or an older run's one recording. */
function Clips({ claim, clips }: { claim: ShotClaim; clips: ShotClip[] }): ReactNode {
  const t = useMessages('changes');
  if (!clips.length) return null;
  return (
    <>
      {clips.map((clip) => {
        if (clip.paired) {
          const motion = clip.motion;
          return (
            <details key={`${clip.viewport}:paired`} className="mt-2 shots-clip-paired">
              <summary className="cursor-pointer text-xs font-medium text-violet-700 dark:text-violet-400">
                {t(motion ? 'changes:shots.clip.playAnimation' : 'changes:shots.clip.playInteraction')}
              </summary>
              <video
                className="shots-clip-video"
                src={clip.paired}
                controls
                preload="none"
                muted
                playsInline
                aria-label={t(motion ? 'changes:shots.clip.animationLabel' : 'changes:shots.clip.interactionLabel', { claim: claim.text })}
              />
            </details>
          );
        }
        const side = (which: 'before' | 'after') => {
          const media = clip[which];
          return (
            <figure key={which} className="shots-clip">
              <figcaption className="shots-clip-caption">
                {t(which === 'before' ? 'changes:shots.clip.beforeCaption' : 'changes:shots.clip.afterCaption', { size: sizeWord(t, clip.viewport) })}
              </figcaption>
              {media ? (
                <video
                  className="shots-clip-video"
                  src={media.url}
                  poster={media.poster || undefined}
                  controls
                  preload="none"
                  muted
                  playsInline
                  aria-label={t(which === 'before' ? 'changes:shots.clip.beforeLabel' : 'changes:shots.clip.afterLabel', { claim: claim.text })}
                />
              ) : <div className="shots-clip-none">{t('changes:shots.clip.none')}</div>}
            </figure>
          );
        };
        return (
          <div key={clip.viewport} data-shots-clips="1" className="shots-clips">
            {clip.beforeShown ? side('before') : null}
            {side('after')}
          </div>
        );
      })}
    </>
  );
}

/** How a change is reached, step by step. */
function Flow({ steps, className }: { steps: string[]; className: string }): ReactNode {
  if (!steps.length) return null;
  return (
    <div className={className}>
      {steps.map((step, i) => (
        <span key={i}>{i ? <span aria-hidden="true"> → </span> : null}{step}</span>
      ))}
    </div>
  );
}

/** What the shots agent noticed broken on the after build besides the declared changes. */
function Noticed({ model }: { model: ShotsModel }): ReactNode {
  const t = useMessages('changes');
  if (!model.notices.length) return null;
  const title = t('changes:shots.noticed.title');
  return (
    <section className="shots-noticed" data-shots-noticed={model.notices.length} aria-label={title}>
      <h3 className="shots-noticed-head">{title}</h3>
      <ul className="shots-noticed-list">
        {model.notices.map((entry, i) => {
          const meta = [
            model.claims.length > 1 && entry.n > 0 ? t('changes:shots.noticed.change', { number: entry.n }) : '',
            entry.screen ? sizeName(t, entry.screen) : '',
            entry.alsoBefore === 'true' ? t('changes:shots.noticed.alsoBefore') : entry.alsoBefore === 'false' ? t('changes:shots.noticed.notBefore') : '',
          ].filter(Boolean);
          const line = meta.length ? meta.reduce((first, second) => t('changes:facts.pair', { first, second })) : '';
          const change = entry.n > 0 ? model.claims[entry.n - 1].id : '';
          return (
            <li key={i} className="shots-noticed-item" data-shots-notice={change} data-also-before={entry.alsoBefore}>
              <p className="shots-noticed-text">{entry.text}</p>
              {line ? <div className="shots-noticed-meta">{line}</div> : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** The changes no screen shows: skipped or failed with the reason, or a clip at a size no screen has. */
function RestClaims({ model, steps }: { model: ShotsModel; steps: boolean }): ReactNode {
  const t = useMessages('changes');
  if (!model.rest.length) return null;
  return (
    <ol className="shots-claims">
      {model.rest.map(({ n, clips }) => {
        const claim = model.claims[n - 1];
        const failed = claim.status === 'failed';
        const skipped = claim.status === 'skipped';
        return (
          <li key={claim.id || n} className="shots-claim" data-shots-story={claim.id} data-shots-shot-status={failed ? 'failed' : skipped ? 'skipped' : 'ready'}>
            <span className="shots-claim-n">{n}</span>
            <div className="min-w-0 flex-1">
              <div className="flex items-start justify-between gap-3">
                <strong className="text-sm leading-snug">{claim.text}</strong>
                {failed ? <span className="dev-badge bg-red-500/10 text-red-700 dark:text-red-400">{t('changes:shots.claim.failedBadge')}</span> : null}
                {skipped ? <span className="dev-badge bg-zinc-500/10 text-zinc-600 dark:text-zinc-400">{t('changes:shots.claim.skippedBadge')}</span> : null}
              </div>
              {failed || skipped ? (
                <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
                  {claim.reason || t(failed ? 'changes:shots.claim.failedReason' : 'changes:shots.claim.skippedReason')}
                </p>
              ) : (
                <>
                  {steps ? (
                    <div className="mt-0.5 text-[0.68rem] text-zinc-500 dark:text-zinc-400">
                      {t('changes:shots.claim.where', { sizes: listText(claim.viewports.map((v) => sizeWord(t, v))), persona: personaText(t, claim.persona) })}
                    </div>
                  ) : null}
                  {steps ? <Flow steps={claim.steps} className="mt-1 text-xs text-zinc-600 dark:text-zinc-400" /> : null}
                  <ClaimNotes claim={claim} />
                  <Clips claim={claim} clips={clips} />
                </>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Pure: whether a screen's before side shows something not there yet: every
 * change on it adds what the before build did not have, as its author
 * declared. A new app's first version has no before at all, and says that.
 */
export function absentOnScreen(model: ShotsModel, screen: ShotScreen): boolean {
  const on = screen.claims.map((n) => model.claims[n - 1]).filter(Boolean);
  return !model.afterOnly && on.length > 0 && on.every((c) => c.absentBefore);
}

export function ShotsViewer({ source, captions = null, expanded = false, steps = false, onExpand = null, shape = null }: {
  /** Null draws nothing (the preview's tab before a change's shots arrive). */
  source: ShotsSource | null;
  /** Each side's name, where it is not the slider's own (a change already live, or closed). */
  captions?: { before: string; after: string } | null;
  /** Drawn larger, with each screen's size and who it was seen as (the detail column, the preview's tab). */
  expanded?: boolean;
  /** Each change's steps and where it was seen, under it (the About sheet and the admin gallery). */
  steps?: boolean;
  /** Open this viewer larger beside the page; no Expand without it. */
  onExpand?: (() => void) | null;
  /** The screens' shaper; AppView._workshopVisuals unless a test hands one in. */
  shape?: ShotsShape | null;
}): ReactNode {
  const t = useMessages('changes');
  const p = useMessages('project');
  const pageDark = usePageDark();
  const [mode, setMode] = useState<ShotsTheme | null>(null);
  const theme: ShotsTheme = mode || (pageDark ? 'dark' : 'light');
  const shaper = shape || legacyShape();
  const model = useMemo(
    () => (source ? readShots(source.shots, { sessionId: source.sessionId, shape: shaper, theme }) : null),
    // The shaper is AppView's own function, or a test's: it does not change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [source?.shots, source?.sessionId, theme],
  );
  const [picked, setPicked] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useIsomorphicLayoutEffect(() => {
    const el = box.current;
    if (!el) return undefined;
    const read = () => setWidth(Math.round(el.clientWidth));
    read();
    if (typeof ResizeObserver !== 'function') return undefined;
    const watch = new ResizeObserver(read);
    watch.observe(el);
    return () => watch.disconnect();
  }, [model?.screens.length]);
  if (!model) return null;
  const screens = model.screens;
  const at = Math.max(0, Math.min(picked, screens.length - 1));
  const shown = screens[at] || null;
  const max = expanded ? PICTURE_MAX_EXPANDED : PICTURE_MAX;
  const frame = shown && shown.screen && width > 0 ? pictureFrame(shown.screen, width, max) : null;
  const height = frame ? frame.height : shown && shown.pair && width > 0 ? wholeFrame(shown.pair, width, max) : 0;
  const onIt = shown ? shown.claims.map((n) => model.claims[n - 1]) : [];
  const absent = !captions && !!shown && absentOnScreen(model, shown);
  const sideNames = captions || (absent ? { before: t('changes:shots.viewer.chipBeforeAbsent'), after: t('changes:shots.viewer.chipAfter') } : null);
  const shownState = model.previousVersion ? 'previous' : 'verified';
  return (
    <section
      className={expanded ? 'dev-change-shots dev-thread-picture shots-one shots-one-expanded' : 'dev-change-shots dev-thread-picture shots-one'}
      data-change-shots={shownState}
      data-thread-picture=""
      data-thread-compare={at}
      data-shots="1"
      data-shots-state={shownState}
      data-shots-after-only={model.afterOnly ? '1' : undefined}
      aria-label={t('changes:shots.thread.title')}
    >
      {model.missing ? (
        <p className="shots-missing" role="note">{t('changes:shots.card.missingDetails')}</p>
      ) : null}
      {shown ? (
        <div ref={box} className="dev-thread-compare" style={height ? { height } : undefined}>
          {height ? (
            <CompareSlider
              key={`${shown.key}:${theme}`}
              screen={shown.screen}
              pair={shown.pair ? { before: shown.pair.before, after: shown.pair.after } : null}
              ground="var(--thread-well, var(--messages-surface-2))"
              width={width}
              height={height}
              marks
              place={frame ? frame.place : null}
              captions={sideNames}
            />
          ) : null}
          {model.themes ? (
            <button
              type="button"
              className="dev-thread-compare-theme"
              data-shots-theme={theme}
              onClick={() => setMode(theme === 'dark' ? 'light' : 'dark')}
              title={t(theme === 'dark' ? 'changes:shots.viewer.showLight' : 'changes:shots.viewer.showDark')}
              aria-label={t(theme === 'dark' ? 'changes:shots.viewer.showLight' : 'changes:shots.viewer.showDark')}
            >
              {theme === 'dark' ? <SunIcon width={16} height={16} /> : <CrescentIcon width={16} height={16} />}
            </button>
          ) : null}
          {onExpand ? (
            <button
              type="button"
              className="dev-thread-compare-expand"
              data-thread-compare-expand=""
              onClick={onExpand}
              title={t('changes:shots.viewer.expand')}
              aria-label={t('changes:shots.viewer.expand')}
            >
              <ExpandIcon width={16} height={16} />
            </button>
          ) : null}
        </div>
      ) : null}
      {shown ? (
        <div className="dev-thread-tiles" data-thread-tiles={screens.length > 1 ? screens.length : 0}>
          {screens.length > 1 ? screens.map((one, i) => (
            <button
              key={one.key}
              type="button"
              className="dev-thread-tile"
              data-shots-screen={one.viewport}
              aria-pressed={i === at}
              aria-label={PICK_IDS[one.viewport]
                ? t(PICK_IDS[one.viewport], { index: i + 1, total: screens.length })
                : t('changes:shots.viewer.pickOther', { index: i + 1, total: screens.length, size: one.viewport })}
              onClick={() => setPicked(i)}
            >
              {one.thumb ? <img src={(one.screen ? shotThumb(one.screen.after) : null) || one.thumb} alt="" loading="lazy" decoding="async" /> : null}
            </button>
          )) : null}
          <div className="dev-thread-tiles-cap">
            {screens.length > 1 ? <p className="dev-thread-tiles-count">{p('project:topic.card.shots.screenOf', { index: at + 1, total: screens.length })}</p> : null}
            {model.afterOnly ? <p className="shots-after-only">{t('changes:shots.screen.nothingBefore')}</p> : null}
            {onIt.length ? (
              // On a card, one quiet line a change (app.css .dev-thread-tiles-legend).
              <div className={expanded || steps ? 'shots-changes-wrap' : 'shots-changes-wrap dev-thread-tiles-legend'}>
                <ol className="shots-changes">
                  {onIt.map((claim) => (
                    <li key={claim.id || claim.n} className="shots-change" data-shots-n={claim.n} data-shots-change={claim.id}>
                      <span className="shots-change-n">{claim.n}</span>
                      <div className="min-w-0 flex-1">
                        <strong className="text-sm leading-snug">{claim.text}</strong>
                        {steps ? <Flow steps={claim.steps} className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400" /> : null}
                        <ClaimNotes claim={claim} />
                        <Clips claim={claim} clips={claim.clips.filter((clip) => clip.viewport === shown.viewport)} />
                      </div>
                    </li>
                  ))}
                </ol>
              </div>
            ) : null}
            {expanded || steps ? (
              <div className="shots-view-meta">
                {t('changes:facts.pair', {
                  first: shown.size
                    ? t('changes:shots.screen.sized', { size: sizeName(t, shown.viewport), width: shown.size.width, height: shown.size.height })
                    : sizeName(t, shown.viewport),
                  second: seenAsText(t, shown.seenAs),
                })}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
      <RestClaims model={model} steps={steps} />
      <Noticed model={model} />
    </section>
  );
}
