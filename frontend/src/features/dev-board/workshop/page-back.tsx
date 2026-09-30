/**
 * THE WAY BACK UP TO A PROJECT'S HUB, drawn inside the page rather than in
 * the header. The header's slot is the project's own (App._backSlotFor); a
 * page under the hub (the Workshop, Needs you, All items) and the project's
 * channel (#3407) are a level inside it, so each leads with this disc.
 *
 * `PageBackButton` is the disc alone, for a row that already names what is
 * open (the channel's header: its tile, name and line). `PageBack` is the
 * disc with the page's name under where it goes back to ("Homeroom" over
 * "Workshop"), the name being the page's one heading. Both draw from
 * `.dev-ws-page-back*` in app.css, so the two cannot drift apart.
 */

import type { ButtonHTMLAttributes, ReactNode } from 'react';

import { ChevronLeftIcon } from '@/components/ui/icons';

type BackButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className' | 'type' | 'children'> & {
  /** Where it goes, as the reader knows it: "Back to <label>". */
  label: string;
  onBack: () => void;
};

export function PageBackButton({ label, onBack, ...rest }: BackButtonProps): ReactNode {
  return (
    <button
      type="button"
      className="dev-ws-page-back un-touch-target"
      {...rest}
      aria-label={`Back to ${label}`}
      title={`Back to ${label}`}
      onClick={onBack}
    >
      <ChevronLeftIcon className="dev-ws-page-back-glyph" aria-hidden="true" />
    </button>
  );
}

export function PageBack({ label, title, onBack }: { label: string; title: string; onBack: () => void }): ReactNode {
  return (
    <div className="dev-ws-pagehead" data-ws-pagehead="">
      <PageBackButton label={label} onBack={onBack} data-ws-page-back="" />
      <div className="dev-ws-pagehead-text">
        <span className="dev-ws-pagehead-over">{label}</span>
        <h2 className="dev-ws-pagehead-title">{title}</h2>
      </div>
    </div>
  );
}
