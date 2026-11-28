/**
 * THE LIST'S PLACE FOR AN ITEM, BEFORE ONE IS OPENED (28 Nov 2026). On a
 * wide window the All items list (./board-list.tsx) keeps one width and
 * its item opens beside it (../workshop/side-panel.tsx). Until one is
 * open, this outlined box stands where the item's page will, so opening
 * one moves nothing, and says what goes there.
 *
 * Into <body>, as the item's own panel is: the Workshop sits inside the
 * page's frosted layers, whose transforms would make `position: fixed`
 * relative to them. It takes the panel's class for its place alone.
 */

import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { ChatBubbleTailIcon } from '@/components/ui/icons';

import { useMessages } from '../../../lib/i18n/react';

export function BesideEmpty(): ReactNode {
  const t = useMessages('project');
  if (typeof document === 'undefined') return null;
  return createPortal((
    <aside className="dev-ws-side dev-ws-side-empty" data-ws-side-empty="">
      <span className="dev-ws-side-empty-tile" aria-hidden="true"><ChatBubbleTailIcon aria-hidden="true" /></span>
      <p className="dev-ws-side-empty-title">{t('project:boardList.beside.title')}</p>
      <p className="dev-ws-side-empty-sub">{t('project:boardList.beside.sub')}</p>
    </aside>
  ), document.body);
}
