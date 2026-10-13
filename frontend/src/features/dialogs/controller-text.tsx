/**
 * The first words of a node whose text a controller module owns.
 *
 * feedback.tsx, members.tsx and app-secrets.tsx render a constant tree and a
 * controller writes into it (`textContent`, `innerHTML`). Where such a node
 * starts with words in it ("Post request", "App secrets"), those words come
 * from the catalog like any others, but the node must not follow the language
 * the way a subscribed component does: React would write the translated
 * resting text over whatever the controller has put there since ("Posting…",
 * an app's name). So this reads the message once, in the English the document
 * was prerendered in, and never renders again; the controller repaints the
 * node on `homeroom:language-changed`, as it does for everything else it
 * wrote.
 *
 * Text nothing but React writes uses `useMessages` as usual.
 */

import { memo } from 'react';

import { t } from '../../lib/i18n/runtime';

export const ControllerText = memo(function ControllerText({ id }: { id: string }) {
  return <>{t(id)}</>;
});
