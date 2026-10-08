/**
 * A change's explanation blocks (#4098), drawn with the shell's own list
 * primitives so they read as every other list in the app: a small-caps
 * label over a plane card of rows, 15 over 13.
 *
 * The data is lib/explain-blocks.ts's validated output, rendered as text
 * children only: nothing from it reaches an attribute, and no sanitiser is
 * involved. Nothing in a block is an action, so no row is a button and no
 * row has a chevron; a row that stays the same before and after gets no
 * treatment, so the one that changes reads by its words alone.
 */
import type { ReactNode } from 'react';
import { GroupedList, ListRow, SectionHeader } from '@/components/ui/grouped-list';
import { IconTile } from '@/components/ui/icon-tile';
import type { ComparisonBlock, ExplainBlock, StepsBlock, TableBlock } from '../../../lib/explain-blocks';

// The label sits inside the hero sheet, which has its own padding, so the
// primitive's horizontal inset and the card's margin come off here.
const LABEL = 'px-0 pb-2 pt-4';
const CARD = 'mx-0';
const KEY = 'font-medium text-zinc-600 dark:text-zinc-300';

function Label({ children }: { children: ReactNode }) {
  return <SectionHeader className={LABEL}>{children}</SectionHeader>;
}

function Comparison({ b }: { b: ComparisonBlock }) {
  return (
    <>
      <Label>{b.title || 'Before and after'}</Label>
      <GroupedList tone="plane" className={CARD} data-explain-block="comparison">
        {b.rows.map((r, i) => (
          <ListRow
            key={i}
            as="div"
            chevron={false}
            inset="text"
            title={r.who}
            titleClassName="whitespace-normal"
            subtitleClassName="whitespace-normal"
            subtitle={(
              <>
                <span className={KEY}>Before</span>{` ${r.before} `}
                <span aria-hidden="true">·</span>
                <span className={KEY}>{' After'}</span>{` ${r.after}`}
              </>
            )}
          />
        ))}
      </GroupedList>
      {b.terms && b.terms.length ? (
        <>
          <Label>Terms</Label>
          <GroupedList tone="plane" className={CARD} data-explain-block="terms">
            {b.terms.map((x, i) => (
              <ListRow key={i} as="div" chevron={false} inset="text" title={x.term} subtitle={x.meaning}
                titleClassName="whitespace-normal" subtitleClassName="whitespace-normal" />
            ))}
          </GroupedList>
        </>
      ) : null}
    </>
  );
}

function Steps({ b }: { b: StepsBlock }) {
  return (
    <>
      <Label>{b.title || 'Steps'}</Label>
      <GroupedList tone="plane" className={CARD} data-explain-block="steps">
        {b.steps.map((s, i) => (
          <ListRow
            key={i}
            as="div"
            chevron={false}
            title={s}
            titleClassName="whitespace-normal"
            leading={(
              <IconTile size="xs" tint="neutral" className="text-[0.8125rem] font-[650]" aria-hidden="true">
                {i + 1}
              </IconTile>
            )}
          />
        ))}
      </GroupedList>
    </>
  );
}

function Table({ b }: { b: TableBlock }) {
  const [first, ...rest] = b.columns;
  return (
    <>
      <Label>{b.title || first}</Label>
      <GroupedList tone="plane" className={CARD} data-explain-block="table">
        {b.rows.map((r, i) => (
          <ListRow
            key={i}
            as="div"
            chevron={false}
            inset="text"
            title={r[0]}
            titleClassName="whitespace-normal"
            subtitleClassName="whitespace-normal"
            subtitle={rest.length ? (
              <>
                {rest.map((c, n) => (
                  <span key={n}>
                    {n ? <span aria-hidden="true">{' · '}</span> : null}
                    <span className={KEY}>{`${c}:`}</span>{` ${r[n + 1]}`}
                  </span>
                ))}
              </>
            ) : null}
          />
        ))}
      </GroupedList>
    </>
  );
}

export function ExplainBlocks({ blocks }: { blocks: ExplainBlock[] | null | undefined }): ReactNode {
  if (!blocks || !blocks.length) return null;
  return (
    <div data-topic-part="summary-blocks">
      {blocks.map((b, i) => (
        b.kind === 'comparison' ? <Comparison key={i} b={b} />
          : b.kind === 'steps' ? <Steps key={i} b={b} />
            : <Table key={i} b={b} />
      ))}
    </div>
  );
}
