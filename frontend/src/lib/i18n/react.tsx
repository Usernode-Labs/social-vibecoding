import { cloneElement, type ReactElement, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { i18n, registerNamespace } from './runtime';

/**
 * Subscribe only the React owner that renders the text; `Shell` itself stays
 * static. Returns the namespace's `t`, which re-renders this owner when the
 * language changes or its pack arrives.
 */
export function useMessages(namespace = 'core') {
  registerNamespace(namespace);
  return useTranslation(namespace, { i18n }).t;
}

/** One translated text node. `id` is `namespace:key`, or a `core` key. */
export function Message({ id, values }: { id: string; values?: Record<string, string | number> }) {
  const t = useMessages(id.includes(':') ? id.split(':')[0] : 'core');
  return <>{t(id, values)}</>;
}

/**
 * A whole message with links or emphasis inside it. The catalog holds numbered
 * tags (`Read <0>the terms</0>, {{name}}.`); the elements, their URLs and
 * handlers stay in code. Only numbered tags are structural: a parameter is
 * always rendered as text, whatever it contains.
 */
export function RichMessage({ id, values = {}, components = [] }: {
  id: string;
  values?: Record<string, string | number | null | undefined>;
  components?: ReactElement[];
}) {
  const t = useMessages(id.includes(':') ? id.split(':')[0] : 'core');
  // Leave {{parameters}} in place: they are substituted below, after the
  // tags are parsed, so a value that looks like a tag stays text.
  const text = String(t(id, {
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
