import { useTranslation } from 'react-i18next';
import { cloneElement, type ReactElement, type ReactNode } from 'react';
import { i18n, t as translateText, registerNamespace } from './runtime';
export { t as message } from './runtime';

export function LocalizedValue({ render }: { render: () => import('react').ReactNode }) {
  useMessages();
  return <>{render()}</>;
}

export function LocalizedDynamic({ element, resolve }: {
  element: ReactElement<Record<string, unknown>>;
  resolve: () => Record<string, unknown>;
}) {
  useMessages();
  return translateElement(element, resolve());
}

function translateElement(element: ReactElement<Record<string, unknown>>, props: Record<string, unknown>): ReactElement {
  // A node may have both fixed and computed labels. Compose those owners at
  // the original element, not as unknown props on an intermediate wrapper.
  if (element.type === LocalizedDynamic) {
    const own = (element.props.resolve as () => Record<string, unknown>)();
    return translateElement(element.props.element as ReactElement<Record<string, unknown>>, { ...own, ...props });
  }
  if (element.type === Localized) {
    const own = Object.fromEntries(Object.entries(element.props.messages as Record<string, string>)
      .map(([prop, key]) => [prop, translateText(key)]));
    return translateElement(element.props.element as ReactElement<Record<string, unknown>>, { ...own, ...props });
  }
  return cloneElement(element, props);
}

/** Subscribe only the React owner rendering text; Shell itself stays static. */
export function useMessages(namespace = 'core') {
  registerNamespace(namespace);
  return useTranslation(namespace, { i18n }).t;
}

export function Message({ id, values, before = '', after = '' }: {
  id: string; values?: Record<string, string | number>; before?: string; after?: string;
}) {
  const t = useMessages(id.includes(':') ? id.split(':')[0] : 'core');
  return <>{`${before}${t(id, values)}${after}`}</>;
}

/** Only numbered component tags are structural; parameter strings stay data. */
export function RichMessage({ id, values = {}, components = [] }: {
  id: string; values?: Record<string, string | number | null | undefined>;
  components?: ReactElement[];
}) {
  const translate = useMessages(id.split(':')[0]);
  const text = String(translate(id, {
    count: typeof values.count === 'number' ? values.count : undefined,
    interpolation: { prefix: '[[unused:', suffix: ']]' },
  }));
  const stack: { index: number; children: ReactNode[] }[] = [{ index: -1, children: [] }];
  const append = (value: ReactNode) => {
    if (value === '') return;
    const children = stack[stack.length - 1].children;
    if (typeof value === 'string' && typeof children[children.length - 1] === 'string') {
      children[children.length - 1] = String(children[children.length - 1]) + value;
    } else children.push(value);
  };
  for (const token of text.split(/(<\/?\d+>|{{\s*\w+\s*}})/g)) {
    const open = /^<(\d+)>$/.exec(token);
    const close = /^<\/(\d+)>$/.exec(token);
    const parameter = /^{{\s*(\w+)\s*}}$/.exec(token);
    if (open) stack.push({ index: Number(open[1]), children: [] });
    else if (close && stack.length > 1 && stack[stack.length - 1].index === Number(close[1])) {
      const group = stack.pop()!;
      const element = components[group.index];
      if (element) append(cloneElement(element, { key: group.index }, ...group.children));
    } else if (parameter) append(String(values[parameter[1]] ?? ''));
    else append(token);
  }
  return <>{stack[0].children}</>;
}

/**
 * Own only translated props. The original element (including its children,
 * refs, classes and handlers) stays stable when the language changes. In
 * particular, do not subscribe Shell or rebuild a legacy-owned subtree.
 */
export function Localized({ element, messages }: {
  element: ReactElement<Record<string, unknown>>;
  messages: Record<string, string>;
}) {
  useMessages();
  return translateElement(element, Object.fromEntries(
    Object.entries(messages).map(([prop, key]) => [prop, translateText(key)]),
  ));
}
