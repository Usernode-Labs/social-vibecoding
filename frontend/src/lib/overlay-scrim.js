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

export function cutoutPath(rect, radii, width, height) {
  const { left: l, top: t, right: r, bottom: b } = rect;
  const [tl, tr, br, bl] = radii;
  // Keep offscreen coordinates: clipping a moving hole to the viewport would
  // introduce rounded corners on the straight docked edge during a spring.
  return `path(evenodd, "M 0 0 H ${width} V ${height} H 0 Z `
    + `M ${l + tl[0]} ${t} H ${r - tr[0]} A ${tr} 0 0 1 ${r} ${t + tr[1]} `
    + `V ${b - br[1]} A ${br} 0 0 1 ${r - br[0]} ${b} `
    + `H ${l + bl[0]} A ${bl} 0 0 1 ${l} ${b - bl[1]} `
    + `V ${t + tl[1]} A ${tl} 0 0 1 ${l + tl[0]} ${t} Z")`;
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
      const box = { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
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
      if (surface.classList.contains('un-sheet')) box.bottom = Math.max(box.bottom, innerHeight);
      if (surface.classList.contains('un-panel')) {
        if (surface.dataset.unSide === 'left') box.left = Math.min(box.left, 0);
        else box.right = Math.max(box.right, innerWidth);
      }
      const cardFade = surface.classList.contains('un-modal')
        || (surface.id === 'apps-switcher-sheet' && matchMedia('(min-width: 640px)').matches);
      const opacity = cardFade ? style.opacity : getComputedStyle(backdrop).opacity;
      return {
        clipPath: cutoutPath(box, radii, innerWidth, innerHeight),
        opacity, zIndex: style.zIndex, visibility: 'visible',
        animating: [surface, backdrop].some(el => el.getAnimations().some(a => a.playState === 'running')),
      };
    },
    write(snapshot) {
      if (disposed) return;
      visible = !!snapshot;
      const next = snapshot || { visibility: 'hidden', opacity: '0' };
      for (const key of ['clipPath', 'opacity', 'zIndex', 'visibility']) {
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
  surface.addEventListener('focusin', update);
  surface.addEventListener('focusout', update);
  surface.addEventListener('transitionrun', update);
  surface.addEventListener('transitionend', update);
  surface.addEventListener('transitioncancel', update);
  window.addEventListener('resize', updateVisible);
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
    surface.removeEventListener('focusin', update);
    surface.removeEventListener('focusout', update);
    surface.removeEventListener('transitionrun', update);
    surface.removeEventListener('transitionend', update);
    surface.removeEventListener('transitioncancel', update);
    window.removeEventListener('resize', updateVisible);
    window.visualViewport?.removeEventListener('resize', updateVisible);
    window.visualViewport?.removeEventListener('scroll', updateVisible);
    paint.style.visibility = 'hidden';
  };
}
