/**
 * The kit's parts of an item's page (a request, a change) in the one frame,
 * as the 2026-11-06 screen tour draws it (its steps s32 to s35): the page's
 * head is its title and one line, with the page's own menu; who asked and
 * under which topic are rows of the context column.
 *
 * Presentational. The page (../request-head.tsx) is still the product's:
 * it draws these under a look beside its own parts, and hands in the words.
 */
import { Av, Card, Frame, Head, Icon, Lead, Row, Sec, k } from '@/components/ui/kit';

/**
 * The head, in the bar's place. The ⋯ keeps the class and the key the
 * shell's own menu wiring finds it by (AppView reads `.dev-card-menu-btn`
 * and `data-card-menu`), drawn as the kit's disc.
 */
export function TopicFrameHead({ title, purpose, menu }: {
  title: string;
  purpose?: string | null;
  menu?: { key: string; label: string } | null;
}) {
  return (
    <Frame data-topic-frame-head="">
      <Head
        title={title}
        purpose={purpose || undefined}
        acts={menu ? (
          <button type="button" className={`${k('ib')} dev-card-menu-btn`} data-card-menu={menu.key} aria-haspopup="true" aria-label={menu.label} title={menu.label}>
            <Icon name="more" size={18} />
          </button>
        ) : undefined}
      />
    </Frame>
  );
}

/** About, in the context column: who asked and when, and the topic it is filed under. */
export function TopicFrameAbout({ label, asker, color, line, topic, topicLine }: {
  label: string;
  asker: string;
  color?: string | null;
  line?: string | null;
  topic?: string | null;
  topicLine: string;
}) {
  return (
    <Frame as="aside" className="fr-topicside" data-topic-side="">
      <Sec label={label}>
        <Card>
          <Row lead={<Av size={40} name={asker || '?'} color={color} />} title={asker} line={line || undefined} sm={false} />
          {topic ? <Row lead={<Lead icon="hash" />} title={topic} line={topicLine} /> : null}
        </Card>
      </Sec>
    </Frame>
  );
}
