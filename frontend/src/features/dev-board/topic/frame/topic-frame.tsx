/**
 * The kit's parts of an item's page (a request, a change) in the one frame:
 * the first screen tour's layout (its steps s32 to s35) holding what the
 * standard page says today (version 2). The page's head is a small line
 * saying what it is ("Request #5998") over its full title, with the page's
 * own menu.
 *
 * Presentational. The page (../request-head.tsx, ../change-head.tsx) is
 * still the product's: it draws these under a look beside its own parts,
 * and hands in the words.
 */
import { Av, Card, Frame, Head, Icon, Pill, Sec, Track, k, type PillKind } from '@/components/ui/kit';

/**
 * The head, in the bar's place. The ⋯ keeps the class and the key the
 * shell's own menu wiring finds it by (AppView reads `.dev-card-menu-btn`
 * and `data-card-menu`), drawn as the kit's disc.
 */
export function TopicFrameHead({ title, over, menu }: {
  title: string;
  /** What this is, over the title: "Request #5998", with its topic when it has one. */
  over?: string | null;
  menu?: { key: string; label: string } | null;
}) {
  return (
    <Frame data-topic-frame-head="">
      <Head
        title={title}
        over={over || undefined}
        acts={menu ? (
          <button type="button" className={`${k('ib')} dev-card-menu-btn`} data-card-menu={menu.key} aria-haspopup="true" aria-label={menu.label} title={menu.label}>
            <Icon name="more" size={18} />
          </button>
        ) : undefined}
      />
    </Frame>
  );
}

/** A small label over one of the page's own cards ("The request", "The change"), which the page writes as a sibling, not inside a section. */
export function TopicFrameLabel({ children }: { children: string }) {
  return (
    <Frame className="fr-topiclabel" data-topic-label="">
      <div className={k('sechead')}><h2 className={k('cap')}>{children}</h2></div>
    </Frame>
  );
}

/**
 * Who wrote the words, at the top of their card: a face, the name, and one
 * grey line (when; what built it). The page writes it just before the card
 * (the product's own `.dev-request-ask`), and app.css draws it inside the
 * card's top; with no card after it (no words, or the editor open) it is a
 * line on the page.
 */
export function TopicFrameBy({ name, color, line, title, at }: {
  name: string;
  color?: string | null;
  line?: string | null;
  /** The whole moment, as the line's tooltip. */
  title?: string | null;
  at?: string | null;
}) {
  return (
    <Frame className="fr-topicby" data-topic-by="">
      <div className={k('byline')}>
        <Av size={28} name={name || '?'} color={color} />
        <b>{name}</b>
        {line ? <time dateTime={at || undefined} title={title || undefined}>{line}</time> : null}
      </div>
    </Frame>
  );
}

/**
 * Where the item stands, as the kit's card. Two forms share it:
 *
 *  - in the context column, under a "Status" label: the state as a pill,
 *    the five-stop line when the item has one, and one grey line;
 *  - in the words' column (`big`): the sentence in the page's own type with
 *    its lead in bold, the claim's small words, and the one action for this
 *    viewer, drawn as the kit's button with the class the standard look's
 *    action has, for whatever reads it.
 */
export function TopicFrameStatus({ label, pill, at = null, state = 'now', stops, words, say, lead, big, fine, action, children }: {
  label?: string | null;
  pill?: { word: string; kind: PillKind } | null;
  /** The stop the item is at; null (and no `stops`) draws no line. */
  at?: number | null;
  state?: 'now' | 'wait';
  /** Each stop's own state, where the caller already knows them (Homeroom bot's track). */
  stops?: ReadonlyArray<'done' | 'now' | 'wait' | 'live' | ''> | null;
  words?: readonly [string, string, string, string, string];
  say?: string | null;
  /** The start of `say` that is said in bold. */
  lead?: string | null;
  big?: boolean;
  fine?: string | null;
  action?: { label: string; title?: string; disabled?: boolean; href?: string; act?: string; onClick?: () => void } | null;
  /** What else the card holds under its line: the track's links and pictures. */
  children?: React.ReactNode;
}) {
  const bold = say && lead && say.startsWith(lead) ? lead : '';
  const line = say ? (bold ? <><b>{bold}</b>{say.slice(bold.length)}</> : say) : null;
  return (
    <Sec label={label || undefined} data-topic-status="">
      <Card>
        <div className={k('status')}>
          {pill ? <div className={k('btnrow')}><Pill kind={pill.kind}>{pill.word}</Pill></div> : null}
          {words && (stops || at != null) ? <Track at={at ?? 0} state={state} stops={stops || undefined} words={words} /> : null}
          {line ? (big ? <p className={k('sub15')}>{line}</p> : <p className={k('txt')}>{line}</p>) : null}
          {fine ? <p className={k('fine')}>{fine}</p> : null}
          {children}
          {action ? (
            <div className={k('btnrow')}>
              {action.href
                ? <a className={`${k('btn')} dev-request-primary`} href={action.href} title={action.title}>{action.label}</a>
                : <button type="button" className={`${k('btn', action.disabled && 'off')} dev-request-primary`} title={action.title} disabled={!!action.disabled} data-act={action.act} onClick={action.onClick}>{action.label}</button>}
            </div>
          ) : null}
        </div>
      </Card>
    </Sec>
  );
}
