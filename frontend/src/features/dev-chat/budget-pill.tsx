/**
 * `#dc-budget` — the dev chat composer's credit meter — as the only React
 * writer below that host. See ./budget-pill-store.ts for the split.
 */

import { useStoreState } from '../../lib/use-store-state';
import {
  budgetPillStore,
  type BudgetPart,
  type BudgetPillState,
} from './budget-pill-store';

function Part({ part }: { part: BudgetPart }) {
  if (part.href) {
    return (
      <a
        href={part.href}
        className={part.className}
        {...(part.title ? { title: part.title } : null)}
      >
        {part.text}
      </a>
    );
  }
  return (
    <span className={part.className} {...(part.title ? { title: part.title } : null)}>
      {part.text}
    </span>
  );
}

export function BudgetPillView({ title, parts }: BudgetPillState) {
  if (!parts.length) return null;
  const run = parts.map((part, i) => <Part key={`${i}:${part.text}`} part={part} />);
  // The wrapper exists only where the original had one: a titled `<span>`
  // around several fragments. A lone fragment carries its own title instead,
  // so the markup stays what it was.
  return title ? <span title={title}>{run}</span> : <>{run}</>;
}

export function BudgetPill() {
  return <BudgetPillView {...useStoreState<BudgetPillState>(budgetPillStore)} />;
}
