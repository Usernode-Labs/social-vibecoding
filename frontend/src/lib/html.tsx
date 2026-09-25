/**
 * Markup another renderer built, drawn without rebuilding it on every render.
 *
 * ── Why this exists ────────────────────────────────────────────────────
 *
 * React 19 compares `dangerouslySetInnerHTML` by the IDENTITY of its
 * `{ __html }` object, not by the string inside it: a fresh object is a new
 * value, and React reassigns `innerHTML` even when the markup is the same.
 * Written inline — `dangerouslySetInnerHTML={{ __html: html }}` — every
 * render of the parent tears the subtree down and parses it again. Images
 * are recreated and decoded again (a before/after tile flashes), a text
 * selection inside the block is lost, and a legacy filler's node inside it
 * is thrown away.
 *
 * The group chat's `Body` and Messages' `MessageMarkdown` memoise the wrapper
 * for this reason (#3104). This is the same fix as a component, for a
 * surface with several such blocks: the wrapper is memoised on the string,
 * and the component itself is `memo()`, so a parent that re-renders with the
 * same props does not even reach it.
 *
 * The markup must already be sanitised where it was built; this draws what
 * it is given.
 */

import { memo, useMemo, type HTMLAttributes } from 'react';

/** The `{ __html }` wrapper for `html`, the same object for as long as the string is. */
export function useInnerHtml(html: string): { __html: string } {
  return useMemo(() => ({ __html: html }), [html]);
}

type DataAttributes = { [name: `data-${string}`]: string | number | boolean | undefined };

export type HtmlProps = Omit<HTMLAttributes<HTMLElement>, 'children' | 'dangerouslySetInnerHTML'> & DataAttributes & {
  html: string;
  /** The element to draw; a `div` unless a caller's markup was another. */
  as?: 'div' | 'span' | 'section' | 'p';
};

export const Html = memo(function Html({ html, as: Tag = 'div', ...rest }: HtmlProps) {
  const inner = useInnerHtml(html);
  return <Tag {...rest} dangerouslySetInnerHTML={inner} />;
});
