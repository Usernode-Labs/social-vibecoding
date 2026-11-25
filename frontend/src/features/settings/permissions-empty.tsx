/**
 * The empty line of a list in Settings > App permissions (#6512 item 1): a
 * small glyph for what the list holds, then the sentence that says what will
 * appear there and that it can be undone.
 *
 * One component for the three lists (device permissions, AI permissions,
 * blocked apps), so the empty state is one style down the page and reads
 * apart from the explanation above it. The glyph is decoration: the sentence
 * says everything, so a screen reader is given the sentence alone. It is
 * drawn in the muted ink, never the accent, because nothing here asks for
 * the person.
 */

import type { ReactElement } from 'react';

import { CameraIcon, NoSymbolIcon, SparklesIcon, type IconProps } from '@/components/ui/icons';

export type PermissionsEmptyKind = 'device' | 'ai' | 'blocked';

const GLYPH: Record<PermissionsEmptyKind, (props: IconProps) => ReactElement> = {
  device: CameraIcon,
  ai: SparklesIcon,
  blocked: NoSymbolIcon,
};

export function PermissionsEmpty({ kind, children }: { kind: PermissionsEmptyKind; children: string }) {
  const Glyph = GLYPH[kind];
  return (
    <div data-role="permissions-empty" data-kind={kind} className="flex items-start gap-2.5">
      <Glyph aria-hidden="true" strokeWidth="1.75" className="mt-0.5 h-4 w-4 shrink-0 text-zinc-500 dark:text-zinc-400" />
      <p className="min-w-0 text-sm text-zinc-500 dark:text-zinc-400">{children}</p>
    </div>
  );
}
