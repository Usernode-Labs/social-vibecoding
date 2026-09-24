// One viewport-sized paint layer, with a hole for the original rounded glass.
// It follows the surface in paint order but never participates in hit testing.
// Keep all geometry reads ahead of writes, and do no frame work while idle.
const pending = new Set();
let frame = 0;
function schedule(entry) {
  pending.add(entry);
  if (!frame) frame = requestAnimationFrame(flush);
}
function flush() {
  frame = 0;
  const entries = [...pending];
  pending.clear();
  const snapshots = entries.map(entry => entry.read());
  entries.forEach((entry, i) => {
    entry.write(snapshots[i]);
    if (snapshots[i]?.animating) schedule(entry);
  });
}

// Compound clip paths with an inner hole paint as a solid dim in Android's
// WebView on the tested Pixel. Paint only the outside instead: four bounded
// strips and four small corner gradients, never a viewport-sized shadow/mask.
export function scrimBackground(rect, radii, width, height, pixelRatio = 1) {
  const layers = [];
  const clamp = (n, end) => Math.max(0, Math.min(n, end));
  const top = clamp(rect.top, height), bottom = clamp(rect.bottom, height);
  const left = clamp(rect.left, width), right = clamp(rect.right, width);
  const color = 'var(--pane-scrim)';
  const place = (image, x, y, w, h) => {
    if (w > 0 && h > 0) layers.push(`${image} ${x}px ${y}px / ${w}px ${h}px no-repeat`);
  };
  const fill = `linear-gradient(${color}, ${color})`;
  place(fill, 0, 0, width, top);
  place(fill, 0, bottom, width, height - bottom);
  place(fill, 0, top, left, bottom - top);
  place(fill, right, top, width - right, bottom - top);
  const [tl, tr, br, bl] = radii;
  const corners = [
    [tl, rect.left, rect.top, 'right bottom'],
    [tr, rect.right - tr[0], rect.top, 'left bottom'],
    [br, rect.right - br[0], rect.bottom - br[1], 'left top'],
    [bl, rect.left, rect.bottom - bl[1], 'right top'],
  ];
  for (const [[rx, ry], x, y, center] of corners) {
    if (x >= width || y >= height || x + rx <= 0 || y + ry <= 0) continue;
    const edge = 0.5 / pixelRatio;
    place(`radial-gradient(ellipse ${rx}px ${ry}px at ${center}, transparent calc(100% - ${edge}px), ${color} 100%)`, x, y, rx, ry);
  }
  return layers.join(', ') || 'none';
}

// How tall the paint layer is. It is `position: fixed; inset: 0`, so it spans
// the LAYOUT viewport, and on iOS `innerHeight` is not that while the on-screen
// keyboard is up: it collapses to the visual viewport (409 of an 812px layout
// in the kit's measurements, native.js keyboardInset). The dim stopped there,
// and a dialog riding the band the keyboard pans the page to (#2765) sat on
// undimmed page below it. The larger of the two is the kit's own
// layoutViewportHeight(); everywhere else they agree.
function layoutViewportHeight() {
  const root = typeof document === 'undefined' ? null : document.documentElement;
  return Math.max(innerHeight, (root && root.clientHeight) || 0);
}

// WHERE THE PAINT LAYER ACTUALLY IS, in the same coordinates as the surface
// (#2822). Send feedback with the keyboard up still showed the top of the
// screen undimmed and the bottom dimmed: the cutout was placed in client
// coordinates and painted as if the layer's own top-left were (0, 0) and its
// height the layout viewport's. While iOS pans the visual viewport for the
// keyboard neither is guaranteed — the layer is a fixed box, and so is the
// dialog, but the band on screen need not be where either assumes. So the layer
// is measured too, and the cutout is placed relative to IT: both rects come
// from the same getBoundingClientRect, so whatever space the engine reports
// them in, the hole lands on the dialog. app.css also extends the layer a
// viewport above and below its fixed box (`.overlay-scrim`), so the band the
// keyboard pans to is inside it wherever it is. Where the layer has no box
// to measure (tests, a detached node) this falls back to the old origin.
function paintBox(paint) {
  const rect = typeof paint.getBoundingClientRect === 'function' ? paint.getBoundingClientRect() : null;
  if (rect && rect.width > 0 && rect.height > 0) {
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  }
  return { left: 0, top: 0, width: innerWidth, height: layoutViewportHeight() };
}

export function attachOverlayScrim(surface, backdrop, paint) {
  if (!surface || !backdrop || !paint) return () => {};
  let disposed = false;
  let last = {};
  let visible = false;
  const entry = {
    read() {
      if (disposed || !surface.isConnected) return null;
      const style = getComputedStyle(surface);
      if (style.visibility === 'hidden' || style.display === 'none'
          || surface.classList.contains('platform-sheet-adopted')) return null;
      // The Homeroom menu's desktop presentation is a POPOVER anchored under
      // the mark (#2784) — the kit's own desktop menu idiom, which has no
      // backdrop (.un-popover in native.css). Below `sm` it is a bottom sheet
      // and dims like every other one.
      if (surface.id === 'apps-switcher-sheet' && matchMedia('(min-width: 640px)').matches) return null;
      const rect = surface.getBoundingClientRect();
      const width = surface.offsetWidth || 1;
      const height = surface.offsetHeight || 1;
      const sx = rect.width / width;
      const sy = rect.height / height;
      const radii = ['TopLeft', 'TopRight', 'BottomRight', 'BottomLeft'].map(corner => {
        const parts = style[`border${corner}Radius`].split(' ');
        const size = (part, extent) => part.endsWith('%') ? parseFloat(part) * extent / 100 : parseFloat(part);
        return [size(parts[0], width) * sx,
          size(parts[1] || parts[0], height) * sy];
      });
      // CSS proportionally reduces radii when adjacent corners would overlap.
      const scale = Math.min(1, rect.width / (radii[0][0] + radii[1][0] || 1),
        rect.width / (radii[3][0] + radii[2][0] || 1),
        rect.height / (radii[0][1] + radii[3][1] || 1),
        rect.height / (radii[1][1] + radii[2][1] || 1));
      radii.forEach(pair => { pair[0] *= scale; pair[1] *= scale; });
      const layer = paintBox(paint);
      const box = { left: rect.left - layer.left, top: rect.top - layer.top,
        right: rect.right - layer.left, bottom: rect.bottom - layer.top };
      // Focus outlines paint outside the border box. Leave them above the dim
      // as they were with the original outer shadow (including UA auto rings).
      const outline = style.outlineStyle === 'none' ? 0
        : Math.max(0, parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset));
      if (outline) {
        box.left -= outline; box.top -= outline;
        box.right += outline; box.bottom += outline;
        radii.forEach(pair => { pair[0] += outline; pair[1] += outline; });
      }
      // The kit extends its glass beyond the docked edge during overshoot.
      if (surface.classList.contains('un-sheet')) box.bottom = Math.max(box.bottom, layer.height);
      if (surface.classList.contains('un-panel')) {
        if (surface.dataset.unSide === 'left') box.left = Math.min(box.left, 0);
        else box.right = Math.max(box.right, layer.width);
      }
      const cardFade = surface.classList.contains('un-modal');
      const opacity = cardFade ? style.opacity : getComputedStyle(backdrop).opacity;
      return {
        background: scrimBackground(box, radii, layer.width, layer.height, window.devicePixelRatio || 1),
        opacity, zIndex: style.zIndex, visibility: 'visible',
        animating: [surface, backdrop].some(el => el.getAnimations().some(a => a.playState === 'running')),
      };
    },
    write(snapshot) {
      if (disposed) return;
      visible = !!snapshot;
      const next = snapshot || { visibility: 'hidden', opacity: '0' };
      for (const key of ['background', 'opacity', 'zIndex', 'visibility']) {
        if (next[key] !== undefined && next[key] !== last[key]) paint.style[key] = next[key];
      }
      last = next;
    },
  };
  const update = () => schedule(entry);
  const updateVisible = () => { if (visible) update(); };
  const mutations = new MutationObserver(update);
  mutations.observe(surface, { attributes: true, attributeFilter: ['class', 'style', 'data-open'] });
  mutations.observe(backdrop, { attributes: true, attributeFilter: ['class', 'style', 'data-open'] });
  const resize = new ResizeObserver(updateVisible);
  resize.observe(surface);
  // The kit's keyboard inset and the visual-viewport pan both reach the
  // dialog as custom properties on <html> (`--un-kb-inset`,
  // `--platform-vv-top`), and a change to them MOVES the dialog without
  // resizing it. Only the `top` transition's events and the viewport events
  // reported that, and a move that runs no transition, or lands after the
  // last viewport event, left the cutout where the dialog used to be (#2822).
  // Re-measure whenever <html>'s style or class changes.
  const root = typeof document === 'undefined' ? null : document.documentElement;
  const rootChanges = new MutationObserver(updateVisible);
  if (root) rootChanges.observe(root, { attributes: true, attributeFilter: ['style', 'class'] });
  surface.addEventListener('focusin', update);
  surface.addEventListener('focusout', update);
  surface.addEventListener('transitionrun', update);
  surface.addEventListener('transitionend', update);
  surface.addEventListener('transitioncancel', update);
  window.addEventListener('resize', updateVisible);
  window.addEventListener('scroll', updateVisible, { passive: true });
  window.visualViewport?.addEventListener('resize', updateVisible);
  window.visualViewport?.addEventListener('scroll', updateVisible);
  // Opening must not paint even one frame with a missing or stale hole.
  entry.write(entry.read());
  return () => {
    disposed = true;
    pending.delete(entry);
    if (!pending.size && frame) { cancelAnimationFrame(frame); frame = 0; }
    mutations.disconnect();
    resize.disconnect();
    rootChanges.disconnect();
    surface.removeEventListener('focusin', update);
    surface.removeEventListener('focusout', update);
    surface.removeEventListener('transitionrun', update);
    surface.removeEventListener('transitionend', update);
    surface.removeEventListener('transitioncancel', update);
    window.removeEventListener('resize', updateVisible);
    window.removeEventListener('scroll', updateVisible);
    window.visualViewport?.removeEventListener('resize', updateVisible);
    window.visualViewport?.removeEventListener('scroll', updateVisible);
    paint.style.visibility = 'hidden';
  };
}
