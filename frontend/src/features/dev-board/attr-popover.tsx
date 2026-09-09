/**
 * `#attr-popover` — the priority / category / assignee picker — as the only
 * React writer below that host.
 *
 * The host stays app-view.js's: it creates the element, places it under the
 * chip that opened it, clamps it into the viewport and removes it on close.
 * See ./attr-popover-store.ts for the split.
 *
 * ── Three things the module still reads back ──────────────────────────
 *
 *   * `.attr-opt` rows keep `data-attr-opt-value` and `data-attr-opt-mine`.
 *     The click is an onClick here rather than a delegated handler — unlike
 *     the group chat's menus, this host is destroyed and rebuilt on every
 *     open, so there is no long-lived element for one listener to sit on.
 *   * `#attr-category-input` / `#attr-assignee-input` stay UNCONTROLLED and
 *     keep their ids: `submit()` reads `.value` off them, and the assignee box
 *     is focused and selected by the module after the mount. A controlled
 *     field would put the typed text in React state and leave the module
 *     reading a stale node.
 *   * `#attr-assignee-suggest` is rendered here, but its rows come from the
 *     module's debounced fetch — it publishes usernames, this draws them.
 */

import { Fragment } from 'react';

import { CheckIcon } from '@/components/ui/icons';

import { useStoreState } from '../../lib/use-store-state';
import {
  attrPopoverStore,
  type AttrAddView,
  type AttrOptionView,
  type AttrPopoverState,
} from './attr-popover-store';

function controller(): any {
  return (typeof window !== 'undefined' ? (window as any).AppView : null) || null;
}

/** Exported for tests: the row's click is the whole #1187 toggle rule. */
export function AttrOptionRow({ option, field }: { option: AttrOptionView; field: string }) {
  return (
    <button
      type="button"
      className="attr-opt"
      data-attr-opt-value={option.value}
      data-attr-opt-mine={option.mine ? '1' : '0'}
      // #1187: the assignee row is a TOGGLE — clicking the name you already
      // voted for withdraws it. Priority and category keep the idempotent
      // re-vote: their check doubles as "my current pick", and un-picking
      // them was never the reported gap.
      {...(option.mine && field === 'assignee' ? { title: 'Click again to remove your pick' } : null)}
      onClick={() => {
        if (field === 'assignee' && option.mine) controller()?._withdrawAttrVote?.();
        else controller()?._castAttrVote?.(option.value);
      }}
    >
      <span className="attr-opt-label">
        {option.dot ? <span className={`attr-dot ${option.dot}`} /> : null}
        {option.dot ? option.label : `@${option.label}`}
      </span>
      <span className="attr-opt-right">
        {option.count ? <span className="attr-opt-count">{option.count}</span> : null}
        {option.mine ? (
          <CheckIcon className="w-3.5 h-3.5 text-violet-700 shrink-0 dark:text-violet-400" strokeWidth="3" />
        ) : null}
      </span>
    </button>
  );
}

function AddBox({ add, suggestions }: { add: AttrAddView; suggestions: string[] }) {
  const submit = () => controller()?._submitAttrTyped?.();
  return (
    <div className="attr-pop-add">
      <input
        type="text"
        id={add.inputId}
        className="attr-pop-input"
        placeholder={add.placeholder}
        autoComplete="off"
        maxLength={add.maxLength}
        defaultValue={add.defaultValue}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          submit();
        }}
        {...(add.suggest ? { onChange: () => controller()?._onAttrAssigneeInput?.() } : null)}
      />
      {add.suggest ? (
        <div
          id="attr-assignee-suggest"
          className={suggestions.length ? 'attr-pop-suggest' : 'attr-pop-suggest hidden'}
        >
          {suggestions.map((name) => (
            <button
              key={name}
              type="button"
              className="attr-suggest-item"
              data-attr-suggest={name}
              onClick={() => controller()?._castAttrVote?.(name)}
            >
              {`@${name}`}
            </button>
          ))}
        </div>
      ) : null}
      <button type="button" id={add.buttonId} className="attr-pop-addbtn" onClick={submit}>
        Add
      </button>
    </div>
  );
}

export function AttrPopoverView({
  phase, field, groups, emptyNote, add, suggestions,
}: AttrPopoverState) {
  if (phase === 'idle') return null;
  if (phase === 'loading') {
    return <div className="px-3 py-2 text-xs text-zinc-500 dark:text-zinc-400">Loading…</div>;
  }
  if (phase === 'error') {
    return <div className="px-3 py-2 text-xs text-red-700 dark:text-red-400">Couldn&#39;t load options.</div>;
  }
  return (
    <>
      {/*
          A keyed Fragment, not a wrapper element: the head and its rows are
          FLAT siblings of the popover in app.css, and an extra div — even a
          `display: contents` one — would break any direct-child rule and the
          `.attr-opt + .attr-opt` rhythm.
      */}
      {groups.map((group) => (
        <Fragment key={group.head}>
          <div className={group.divided ? 'attr-pop-head attr-pop-head-divided' : 'attr-pop-head'}>
            {group.head}
          </div>
          {group.options.map((option) => (
            <AttrOptionRow key={option.value} option={option} field={field || ''} />
          ))}
        </Fragment>
      ))}
      {emptyNote ? (
        <div className="px-3 py-1.5 text-xs text-zinc-500 dark:text-zinc-500">{emptyNote}</div>
      ) : null}
      {add ? <AddBox add={add} suggestions={suggestions} /> : null}
    </>
  );
}

export function AttrPopover() {
  return <AttrPopoverView {...useStoreState<AttrPopoverState>(attrPopoverStore)} />;
}
