/**
 * Artifacts (docs/plans/artifacts.md): THE frame every page the bot writes
 * is drawn in. One component, three modes (./policy.ts), and the rule about
 * who sees a page running:
 *
 *   run     the page's own scripts run (for its author: the viewer rule)
 *   static  nothing runs
 *   helper  nothing of the page's runs; Homeroom's helper alone does, by a
 *           nonce made new for the frame, so the chat learns the page's size
 *           and where its links are (a laid-out answer, bot-html.tsx)
 *
 * ── The viewer rule ───────────────────────────────────────────────────
 *
 * A page's scripts are its author's to run. Inside the frame a script cannot
 * read a cookie or call the network, but it can draw anything, a convincing
 * sign-in box included. So:
 *
 *   - A page asked for in `run` mode runs only for its AUTHOR by default.
 *     Anyone else is shown the static version (`staticMarkup`: nothing of
 *     the page's own runs) until they choose to run it.
 *   - A page somebody else chose to run is drawn in a plain box that says
 *     whose page it is and that it is not part of Homeroom. It never sits in
 *     chrome that looks like Homeroom's own: the box draws no card, header
 *     or button of the shell's around or over the running page.
 *
 * `viewer` defaults to 'other', so a caller that forgets to say gets the
 * safe side. Today every running page is read from its author's own private
 * thread, and those callers say `viewer="author"`.
 *
 * ── What a caller hands it ────────────────────────────────────────────
 *
 *   html   the page (a design's version, any artifact): this builds the
 *          frame's document (./frame-doc.ts artifactFrameDoc)
 *   doc    a whole document already under the static policy (a plan's
 *          screen, lib/spec-html.ts)
 *   src    a document a route serves under the same policy as a header (a
 *          first look's drawn screen)
 *
 * `doc` and `src` are static only: a caller cannot hand a prebuilt document
 * to a running frame, so the policy and the helper are always this module's.
 */

import { useMemo, useState, type CSSProperties, type ReactNode, type Ref } from 'react';

import { useMessages } from '../../lib/i18n/react';
import { ARTIFACT_FRAME_ATTR, ARTIFACT_PICTURED_ATTR, artifactFrameDoc, frameNonce } from './frame-doc';
import { sandboxFor, type FrameMode } from './policy';

/** Who is looking at the page: the person it was written with, or anyone else. */
export type Viewer = 'author' | 'other';

/**
 * Pure: the mode a frame is actually drawn in (the viewer rule). `mode` is
 * what the surface asks for; a page runs only for its author, or for a
 * viewer who chose to run it.
 */
export function frameModeFor({ mode, viewer = 'other', chose = false }: { mode: FrameMode; viewer?: Viewer; chose?: boolean }): FrameMode {
  // The helper mode runs nothing of the page's, only Homeroom's own helper:
  // the same for whoever looks.
  if (mode === 'helper') return 'helper';
  if (mode !== 'run') return 'static';
  return viewer === 'author' || chose ? 'run' : 'static';
}

export interface ArtifactFrameProps {
  mode: FrameMode;
  viewer?: Viewer;
  /** The author's name, for the line over a page somebody else chose to run. */
  author?: string | null;
  html?: string;
  doc?: string;
  src?: string;
  /** Accessible name of the frame. */
  title: string;
  /** This site's origin; the page's own when left out. */
  origin?: string;
  /** Whether the page draws with this site's stylesheets, pictures and fonts. */
  site?: boolean;
  sheets?: readonly string[];
  /** The helper mode's nonce (frame-doc.ts, the helper); made here, new for the frame, when left out. */
  nonce?: string;
  /** Nothing in it can be tapped or focused: a picture of the page. */
  inert?: boolean;
  /** Marked so a comment's picture can ask the frame to draw itself (running and helper pages). */
  pictured?: boolean;
  lazy?: boolean;
  scrolling?: 'no';
  className?: string;
  style?: CSSProperties;
  frameRef?: Ref<HTMLIFrameElement>;
  onLoad?: () => void;
  tabIndex?: number;
  ariaHidden?: boolean;
}

const RUN_BUTTON = 'inline-flex h-9 items-center rounded-full bg-zinc-900 px-3 text-[13px] font-semibold text-white dark:bg-zinc-100 dark:text-zinc-900';

/** The one frame. See the head of this file. */
export function ArtifactFrame({
  mode, viewer = 'other', author = null, html, doc, src, title, origin, site = true, sheets, nonce,
  inert = false, pictured = false, lazy = false, scrolling, className, style, frameRef, onLoad, tabIndex, ariaHidden,
}: ArtifactFrameProps): ReactNode {
  const t = useMessages('core');
  const [chose, setChose] = useState(false);
  // A prebuilt document or a served one is static, whatever was asked.
  const asked: FrameMode = html == null ? 'static' : mode;
  const drawn = frameModeFor({ mode: asked, viewer, chose });
  const made = useMemo(() => nonce || (drawn === 'helper' ? frameNonce() : ''), [nonce, drawn]);
  const site_ = origin || (typeof window !== 'undefined' ? window.location.origin : '');
  const srcDoc = useMemo(() => {
    if (src) return undefined;
    if (html == null) return doc;
    return artifactFrameDoc(html, { mode: drawn, origin: site_, site, sheets, nonce: made || null });
  }, [src, html, doc, drawn, site_, site, sheets, made]);
  const frame = (
    <iframe
      ref={frameRef}
      {...(src ? { src } : {})}
      title={title}
      sandbox={sandboxFor(drawn)}
      referrerPolicy="no-referrer"
      {...(src ? {} : { srcDoc })}
      {...(lazy ? { loading: 'lazy' as const } : {})}
      {...(scrolling ? { scrolling } : {})}
      {...{ [ARTIFACT_FRAME_ATTR]: drawn }}
      {...(pictured && (drawn === 'run' || drawn === 'helper') ? { [ARTIFACT_PICTURED_ATTR]: '' } : {})}
      tabIndex={inert ? -1 : tabIndex}
      aria-hidden={inert || ariaHidden ? 'true' : undefined}
      onLoad={onLoad}
      className={className}
      style={inert ? { ...style, pointerEvents: 'none' } : style}
    />
  );
  // The author's own page, or a page nothing of which runs: the frame alone.
  if (asked !== 'run' || viewer === 'author') return frame;
  // Somebody else's page. Static until they choose; then running, in a plain
  // box of its own with a line saying what it is, and none of Homeroom's
  // chrome around it.
  if (!chose) {
    return (
      <div data-artifact-viewer="static" className="flex flex-col gap-2">
        {frame}
        <div className="flex flex-wrap items-center gap-2 text-[13px] text-zinc-600 dark:text-zinc-300">
          <span className="min-w-0 flex-1">{t('core:artifact.viewer.staticNote')}</span>
          <button type="button" className={RUN_BUTTON} onClick={() => setChose(true)} data-artifact-run="">
            {t('core:artifact.viewer.run')}
          </button>
        </div>
      </div>
    );
  }
  return (
    <div data-artifact-viewer="running" style={{ border: '2px dashed #b45309', background: '#fff', color: '#18181b' }}>
      <p role="note" style={{ margin: 0, padding: '6px 8px', font: '600 13px/1.4 system-ui, sans-serif', background: '#fef3c7' }}>
        {author ? t('core:artifact.viewer.runningNoteBy', { author }) : t('core:artifact.viewer.runningNote')}
      </p>
      {frame}
    </div>
  );
}
