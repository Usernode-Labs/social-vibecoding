/**
 * The tier list's mark (./examples.ts `chart`), on its tile on "What do you
 * want to make?" and in the story's list: a tier list in miniature. One
 * column of tier colours, red over orange over yellow with no gap between
 * them, and beside each a row of grey items, two, two and one, a little
 * wider than they are tall.
 *
 * Boxes rather than a glyph: it is a picture of the thing, at the size of
 * the emoji it stands beside (29 by 30), and the tier colours are the ones
 * tier lists everywhere use, so they are the same in both themes.
 */

const ROWS = [2, 2, 1] as const;

export function TierChart() {
  return (
    <span data-tier-chart="" className="flex h-[30px] w-[29px] gap-[3px]" aria-hidden="true">
      <span className="flex w-2 shrink-0 flex-col overflow-hidden rounded-[2px]">
        <span className="h-2.5 bg-[#ff7f7f]" />
        <span className="h-2.5 bg-[#ffbf7f]" />
        <span className="h-2.5 bg-[#ffdf7f]" />
      </span>
      <span className="flex flex-col">
        {ROWS.map((items, row) => (
          <span key={row} className="flex h-2.5 items-center gap-0.5">
            {Array.from({ length: items }, (_, i) => (
              <span key={i} className="h-1.5 w-2 rounded-[1.5px] bg-zinc-300 dark:bg-zinc-600" />
            ))}
          </span>
        ))}
      </span>
    </span>
  );
}
