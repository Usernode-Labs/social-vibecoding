/**
 * THE WALLPAPER STAYS UNDER THE BARS WHILE A SCREEN FADES THROUGH (#2758).
 *
 * The desktop screen swap is the kit's fade-through (native.css, #1920): the
 * outgoing root snapshot goes to opacity 0 over the first 35% of the
 * transition, and only then does the incoming one arrive. Whatever is painted
 * UNDER ::view-transition shows for those frames — and that is the canvas,
 * flat #f4f2e4, because the wallpaper is the BODY's background and so rides
 * inside the root snapshot that is fading.
 *
 * The page going briefly flat is part of the fade. The bars are what made it a
 * flicker: #platform-header and #platform-tabs are pinned groups of their own
 * (app.css, "The top bar does not travel with the page"), and they are
 * translucent, so each one showed the wallpaper tinted through it, then the
 * flat ground, then the wallpaper again — on every tab press, while every
 * control on them stayed exactly where it was. Measured on a Home -> Discover
 * push at 1280x900, the rail at (100, 600): rgb(255,241,232) at rest,
 * rgb(250,249,242) at 40-80ms, rgb(255,241,232) again from 120ms.
 *
 * So the ground under the transition is made the wallpaper. app.css paints
 * `::view-transition` with `var(--un-vt-ground)`, and this module fills that
 * property. It has to be copied rather than referenced: every pseudo-element of
 * the transition inherits from <html>, and `--home-wallpaper` is declared on
 * the BODY (behind `body:has(...)` rules several tests pin), so <html> cannot
 * see it. A computed custom property has its own var()s already substituted,
 * which is what makes the copy a faithful one: the star's scroll offset, the
 * theme's tints and the 640px layer set all come across as they are.
 *
 * WHEN: the kit writes `data-un-vt` on <html> immediately before it calls
 * startViewTransition, and the old snapshot is taken at the next rendering
 * opportunity — after this observer's microtask. So the copy is the OUTGOING
 * screen's ground, which on a tab change is also the incoming one's. A route
 * with no wallpaper yields an empty value, the property is removed, and the
 * transition keeps the plain canvas it always had.
 */

export const GROUND_PROP = '--un-vt-ground';
export const WALLPAPER_PROP = '--home-wallpaper';

type RootLike = Pick<Element, 'hasAttribute'> & {
  style: Pick<CSSStyleDeclaration, 'setProperty' | 'removeProperty'>;
};
type DocLike = { documentElement: RootLike; body: Element | null };
type ComputeStyle = (el: Element) => Pick<CSSStyleDeclaration, 'getPropertyValue'>;

/** Copy the body's wallpaper onto <html> for the transition that is starting.
 *  Returns the value written, '' when there is no wallpaper to carry. */
export function syncTransitionGround(doc: DocLike, computeStyle: ComputeStyle): string {
  const root = doc.documentElement;
  if (!root.hasAttribute('data-un-vt') || !doc.body) return '';
  const ground = computeStyle(doc.body).getPropertyValue(WALLPAPER_PROP).trim();
  if (ground) root.style.setProperty(GROUND_PROP, ground);
  else root.style.removeProperty(GROUND_PROP);
  return ground;
}

if (typeof document !== 'undefined' && typeof MutationObserver !== 'undefined') {
  new MutationObserver(() => {
    syncTransitionGround(document, (el) => getComputedStyle(el));
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-un-vt'] });
}
