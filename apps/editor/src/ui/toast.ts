import { createStore } from '../lib/store.ts';

export interface Toast {
  id: number;
  kind: 'info' | 'success' | 'error';
  message: string;
  link?: { href: string; label: string };
}

export const toasts = createStore<{ list: Toast[] }>({ list: [] });
let seq = 0;

function push(kind: Toast['kind'], message: string, link?: Toast['link'], ms = kind === 'error' ? 6000 : 3200) {
  const id = ++seq;
  toasts.set((s) => ({ list: [...s.list.slice(-3), { id, kind, message, link }] }));
  setTimeout(() => dismiss(id), link ? ms * 2.5 : ms);
  return id;
}

export function dismiss(id: number) {
  toasts.set((s) => ({ list: s.list.filter((t) => t.id !== id) }));
}

export const toast = {
  info: (m: string) => push('info', m),
  success: (m: string, link?: Toast['link']) => push('success', m, link),
  error: (m: string) => push('error', m),
};
