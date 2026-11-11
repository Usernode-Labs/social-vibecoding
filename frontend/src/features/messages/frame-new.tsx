/**
 * New message in the one frame, version 2 (the tour's s16): the kit's sheet
 * over the inbox holding what the standard "+" offers, and nothing else.
 * Three kinds of conversation, each with its one line: Agent chat, Direct
 * message, Group chat (./index.tsx NEW_CHOICES, in its order and words).
 *
 * A press hands over to the product: an agent chat starts, and a direct
 * message or a group opens the product's own create dialog (./create-dialog
 * .tsx) on that tab, where people are found, a group is named and blocked
 * people are managed. Nothing is picked, searched or created here.
 */
import { Card, Lead, Row, Sheet } from '@/components/ui/kit';
import { useMessages } from '../../lib/i18n/react';

export type NewMessageKind = 'agent' | 'direct' | 'group';

/** One choice: its key, and the catalog ids of its name and its line. */
export interface NewMessageChoice {
  key: NewMessageKind;
  label: string;
  hint: string;
}

/** The glyph each kind wears, the kit's of the three the standard menu draws (sparkles, a bubble, people). */
const GLYPH: Record<NewMessageKind, string> = { agent: 'spark', direct: 'chat', group: 'users' };

export function NewMessageSheet({ choices, onPick, onClose }: {
  choices: readonly NewMessageChoice[];
  onPick: (key: NewMessageKind) => void;
  onClose: () => void;
}) {
  const t = useMessages('messages');
  const tc = useMessages('core');
  return (
    <Sheet
      title={t('messages:create.title')}
      purpose={t('messages:inbox.new.menuName')}
      onClose={onClose}
      closeLabel={tc('core:common.close')}
    >
      <Card>
        {choices.map((item) => (
          <Row
            key={item.key}
            lead={<Lead icon={GLYPH[item.key]} />}
            title={t(item.label)}
            line={t(item.hint)}
            onClick={() => onPick(item.key)}
          />
        ))}
      </Card>
    </Sheet>
  );
}
