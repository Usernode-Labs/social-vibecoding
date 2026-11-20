/**
 * A project's own Needs you, around its run (./review-flow.tsx), under the
 * Standard (WIP) look: what stands in the page when nothing waits, and the
 * ways on into the project under whatever does.
 *
 * The run itself knows no look (the stage is the product's on every one),
 * so the look is read here, in the two pieces that are drawn beside it.
 * Under every other look ProjectNeedsEmpty draws the line it is handed and
 * ProjectWaysIn draws nothing.
 */

import { useEffect, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import { ChatIcon, CheckIcon, ChevronRightIcon, PlayIcon, SparklesIcon } from '@/components/ui/icons';
import { useMessages } from '../../lib/i18n/react';
import { isKitHome, useLiveSkin } from '../../lib/skin';

/** Whether this is a project's page under the look that draws these. */
function useDrawn(slug?: string, project?: string): boolean {
  return isKitHome(useLiveSkin()) && !!slug && !!project;
}

/** From this width a project's Needs you shows what a change does beside it (app.css `[data-rf-beside]`). */
const DESC_BESIDE = '(min-width: 1280px)';

/**
 * Whether what a change does is shown beside it, not under the arrow in its
 * bar: on a project's own Needs you under the look that draws it, on a large
 * screen. Read after mount, so the first render knows no width.
 */
export function useDescBeside(slug?: string, project?: string): boolean {
  const drawn = useDrawn(slug, project);
  const [large, setLarge] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const mq = window.matchMedia(DESC_BESIDE);
    const read = () => setLarge(mq.matches);
    read();
    mq.addEventListener('change', read);
    return () => mq.removeEventListener('change', read);
  }, []);
  return drawn && large;
}

/**
 * The ways on into a project: its Workshop, its discussion and its hub, as
 * three doors of the hub's own shape under a label of the look.
 */
export function ProjectWaysIn({ slug, project }: { slug?: string; project?: string }): ReactNode {
  const t = useMessages('communities');
  const drawn = useDrawn(slug, project);
  if (!drawn || !slug || !project) return null;
  const go = (place: string) => {
    const win = window as any;
    try { win.AppView?._landOnTab?.(slug, place); } catch { /* the page opens on what it remembers */ }
    win.App?.navigateToApp?.(slug, 'dev');
  };
  const door = (mark: string, place: string, glyph: ReactNode, title: string, text: string) => (
    <button type="button" className="wip-caught-door" data-mark={mark} onClick={() => go(place)}>
      <span className="wip-caught-door-tile" aria-hidden="true">{glyph}</span>
      <span className="wip-caught-door-text">
        <span className="wip-caught-door-title">{title}</span>
        <span className="wip-caught-door-sub">{text}</span>
      </span>
      <ChevronRightIcon className="wip-caught-door-go" aria-hidden="true" />
    </button>
  );
  return (
    <section className="wip-ways" data-needs-ways="">
      <h3 className="wip-ways-label"><span className="wip-head-words">{t('communities:reel.caughtUp.next')}</span></h3>
      <div className="wip-caught-doors">
        {door('1', 'workshop', <SparklesIcon className="wip-caught-door-glyph" />, t('communities:reel.caughtUp.workshop.title'), t('communities:reel.caughtUp.workshop.text'))}
        {door('3', 'discussion', <ChatIcon className="wip-caught-door-glyph" />, t('communities:reel.caughtUp.discussion.title'), t('communities:reel.caughtUp.discussion.text'))}
        {door('2', 'status', <PlayIcon className="wip-caught-door-glyph" />, t('communities:reel.caughtUp.hub.title', { project }), t('communities:reel.caughtUp.hub.text'))}
      </div>
    </section>
  );
}

/**
 * Nothing waits: good news, said as a heading on a card, with the ways on
 * under it. `children` is the plain line every other look draws.
 */
export function ProjectNeedsEmpty({ slug, project, anchorRef, children }: {
  slug?: string;
  project?: string;
  anchorRef: RefObject<HTMLDivElement | null>;
  children: ReactNode;
}): ReactNode {
  const t = useMessages('communities');
  const drawn = useDrawn(slug, project);
  if (!drawn) return children;
  return (
    <div ref={anchorRef} className="wip-needs" data-needs-empty="" data-review-flow="">
      <div className="wip-caught">
        <span className="wip-caught-mark" aria-hidden="true"><CheckIcon className="wip-caught-glyph" /></span>
        <h3 className="wip-caught-title">{t('communities:reel.caughtUp.title')}</h3>
        <p className="wip-caught-text">{t('communities:reel.emptyProject', { project })}</p>
      </div>
      <ProjectWaysIn slug={slug} project={project} />
    </div>
  );
}
