/**
 * `#app-iframe` and its launch cover, as a React island (#1085 chunk H, step 2).
 *
 * Read ./app-frame-store.js first: this file exists to satisfy a single
 * invariant, and every line of it is shaped by that invariant.
 *
 *   **The `<iframe>` element must be created exactly once per app and never
 *   again.** It hosts someone else's application. Re-creating it reloads their
 *   document and throws away whatever the user had in it.
 *
 * React re-creates a DOM node when its element type changes, its `key` changes,
 * or its position among its siblings changes. So:
 *
 * - `AppFrame` is keyed by `slug` and by nothing else, by its only caller below.
 *   A different app IS a different frame; nothing else is.
 * - The `.app-launch-host` wrapper is rendered UNCONDITIONALLY, outside
 *   `AppFrame`, so the frame's parent is the same node for the lifetime of the
 *   document. (It also supplies the `position: relative` that
 *   `#app-iframe { position: absolute; inset: 0 }` resolves against — the same
 *   role `#app-content { position: relative }` played for the old hand-built
 *   markup, so the frame's rect is unchanged.)
 * - The iframe is the FIRST child, always, and the cover — which comes and goes
 *   — is the second. Removing a trailing sibling cannot move the one before it.
 * - There is no `src` prop. `src` is assigned through the registered ref by
 *   `appFrameBridge.setSrc` and nowhere else; re-applying a `src` prop is a
 *   document reload even when the value has not changed.
 * - `sandbox` and `allow` ARE rendered props, and the difference is that
 *   re-applying either is a no-op: React writes the same string to the same
 *   attribute and the document is untouched. Both are also read at
 *   navigation and not before, so `setSrc` publishes them on the line above
 *   the `src` assignment (see ./app-frame-policy.js).
 * - Parking (Dev tab) hides the HOST, it does not unmount this component.
 *
 * `opacity` is a rendered prop rather than an imperative write because React
 * owns it end to end: `#app-iframe` had `style="opacity:0"` in the launch
 * markup and `_revealLaunch` set it to '1'. A style-prop change updates the
 * existing node's style; it never re-creates it.
 */

import { memo, useEffect, useRef, type ReactNode } from 'react';

import { useHiddenClass, useIsomorphicLayoutEffect } from '../../lib/legacy-dom';
import { useStoreState } from '../../lib/use-store-state';
import { APP_FRAME_SANDBOX, PENDING_FRAME_SANDBOX } from './app-frame-policy.js';
import { navStore } from '../nav/nav-store.js';
import { appFrameRefs, appFrameStore } from './app-frame-store.js';
import { publishAppTone } from './app-tone.js';

function LaunchCover({
  iconKind,
  iconHtml,
  name,
  note,
  spinner,
  out,
}: {
  iconKind: string;
  iconHtml: string;
  name: string;
  note: string;
  spinner: boolean;
  out: boolean;
}): ReactNode {
  return (
    <div
      id="app-launch-cover"
      className={out ? 'app-launch-cover app-launch-cover--out' : 'app-launch-cover'}
      aria-hidden="true"
    >
      {/*
          The icon tile's inner markup comes from `Home.iconTileFor` — the same
          helper that paints every icon tile on the platform — so it arrives as
          HTML. The name and the note are raw text: React escapes them, where
          the legacy template called escapeHtml itself.
      */}
      <div
        className="app-icon-tile app-launch-cover-icon"
        data-icon={iconKind}
        dangerouslySetInnerHTML={{ __html: iconHtml }}
      >
      </div>
      <p className="app-launch-cover-name">{name}</p>
      <p className="app-launch-cover-note" id="app-launch-cover-note">{note}</p>
      <div
        className={
          spinner
            ? 'dc-status-spinner-arc app-launch-cover-spinner'
            : 'dc-status-spinner-arc app-launch-cover-spinner hidden'
        }
        id="app-launch-cover-spinner"
      >
      </div>
    </div>
  );
}

/**
 * `memo` is not what protects the frame's identity — the key and the position
 * do. It is here because this component subscribes to the store for `faded` and
 * `cover`, and `slug` is the only prop it takes: memoising keeps a parent
 * re-render from doing any work at all.
 *
 * ── Mounted, or kept alive (#2902) ────────────────────────────────────
 *
 * The same component renders a frame whether it is the MOUNTED app (the store's
 * top-level `slug`) or one of the apps kept alive behind it (`kept`). It has to
 * be the same component: React re-creates a node whose element type changes,
 * so a kept frame drawn by anything else would reload the moment it was
 * resumed. Being mounted is only ever a change of attributes on the same node:
 *
 * - `id="app-iframe"` goes to the mounted frame alone. Every shell handler that
 *   believes a postMessage checks `e.source` against that element, so a hidden
 *   app cannot open dialogs, request permissions or paint the bar.
 * - A kept frame is `inert` and `aria-hidden`, so neither the keyboard nor a
 *   screen reader can reach it, and `data-kept`, which app.css hides it by —
 *   `visibility: hidden` over the same box, so its layout is untouched.
 * - The cover belongs to the mounted frame and to no other.
 */
const AppFrame = memo(function AppFrame({ slug }: { slug: string }): ReactNode {
  const state = useStoreState(appFrameStore);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const active = state.slug === slug;
  const look = active ? state : (state.kept.find((k) => k.slug === slug) || state);

  // Register the element for the bridge, and only for as long as React owns it:
  // as THE frame while it is mounted, by slug while it is kept.
  useIsomorphicLayoutEffect(() => {
    const el = iframeRef.current;
    if (active) {
      appFrameRefs.iframe = el;
      if (appFrameRefs.kept[slug] === el) delete appFrameRefs.kept[slug];
    } else {
      if (appFrameRefs.iframe === el) appFrameRefs.iframe = null;
      if (el) appFrameRefs.kept[slug] = el;
    }
  }, [active, slug]);
  useIsomorphicLayoutEffect(() => {
    const el = iframeRef.current;
    return () => {
      if (appFrameRefs.iframe === el) appFrameRefs.iframe = null;
      if (appFrameRefs.kept[slug] === el) delete appFrameRefs.kept[slug];
    };
  }, []);

  const cover = active ? state.cover : null;
  return (
    <>
      {/*
          `allow` was the constant 'clipboard-write; pointer-lock; geolocation'
          before #2219 — every app, unconditionally. The ungated base still
          ships to everyone; the nine gated capabilities come from THIS user's
          grants for THIS app, rebuilt by setSrc before each navigation.
      */}
      <iframe
        id={active ? 'app-iframe' : undefined}
        ref={iframeRef}
        className="w-full h-full border-0"
        style={{ opacity: active && state.faded ? 0 : 1, backgroundColor: look.background || undefined }}
        sandbox={look.sandboxReady ? APP_FRAME_SANDBOX : PENDING_FRAME_SANDBOX}
        allow={look.allow}
        data-app-slug={slug}
        title={look.title || undefined}
        data-kept={active ? undefined : ''}
        inert={!active}
        aria-hidden={active ? undefined : 'true'}
        tabIndex={active ? undefined : -1}
      >
      </iframe>
      {cover ? (
        <LaunchCover
          iconKind={cover.iconKind}
          iconHtml={cover.iconHtml}
          name={cover.name}
          note={cover.note}
          spinner={cover.spinner}
          out={cover.out}
        />
      ) : null}
    </>
  );
});

/**
 * #2902: every live frame — the mounted one and the kept ones — in the order
 * they were CREATED (`seq`), which never changes for a frame's lifetime. A
 * frame is therefore only ever appended or removed and never moved, and a move
 * is a reload.
 */
function liveFrames(state: ReturnType<typeof appFrameStore.get>): string[] {
  const frames = state.kept.map((k) => ({ slug: k.slug, seq: k.seq }));
  if (state.slug) frames.push({ slug: state.slug, seq: state.seq });
  return frames.sort((a, b) => a.seq - b.seq).map((f) => f.slug);
}

/**
 * `#app-frame-host` — the React-owned half of `#app-view`.
 *
 * A sibling of `#app-content` rather than a child of it, and that split is the
 * whole architecture of step 2: `#app-content` stays exactly what it was, an
 * empty host that `public/js/**` fills with `innerHTML` (Dev mode and all its
 * sub-views, the status placeholders, the `?shot=app-launching` cover), and the
 * app frame moves out from under it into a region React owns end to end. That
 * is what the migration rule demands — "a region may become stateful only when
 * its entire subtree is React-owned" — and it is also what lets the frame
 * survive a tab switch, because a Dev render no longer writes over it.
 *
 * Exactly one of the two is visible. Both carry `flex-1` + `min-height: 0` +
 * `overflow: hidden` inside `#app-view`'s column flex, and a hidden sibling is
 * `display: none` and out of the layout, so the visible one gets the same box
 * `#app-content` had when it was the only child.
 */
export function AppFrameHost(): ReactNode {
  const state = useStoreState(appFrameStore);
  const { screen } = useStoreState(navStore) as { screen: string | null };
  const hostRef = useRef<HTMLDivElement | null>(null);

  // Written on the ref, not rendered, so `className` stays a constant string —
  // #app-view's own `hidden` is toggled by app.js's visibility seam and the same
  // discipline applies all the way down this subtree.
  useHiddenClass(hostRef, !state.active);

  // #1945: the bar above the frame takes the app's tone. The page colour the
  // app's bridge reports (`background`) is turned into `data-app-tone` on
  // <html> — a node React does not own, written from an effect the same way
  // the head's theme module writes `.dark` there — and cleared the moment the
  // frame is parked or dropped, or the router reveals any other screen (the
  // app left by a tab keeps its frame active; see toneForState). `useEffect`,
  // not a layout effect: the tone is a repaint of the strip, never something
  // a first paint has to wait for, and it must not run in the prerender pass
  // at all (the shipped document carries no tone, exactly like the empty
  // store).
  useEffect(() => {
    publishAppTone(document, state, window, false, screen);
  }, [state.slug, state.active, state.background, screen]);

  return (
    <div
      id="app-frame-host"
      ref={hostRef}
      className="hidden flex-1"
      style={{ minHeight: '0', overflow: 'hidden' }}
    >
      <div className="app-launch-host w-full h-full">
        {liveFrames(state).map((slug) => <AppFrame key={slug} slug={slug} />)}
      </div>
    </div>
  );
}
