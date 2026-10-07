import type { PageNode } from '@modulo/core';

/** Extract top-level nodes from whatever shape the AI module returns ({tree}, a page node, or a node list). */
export function aiNodes(res: unknown): PageNode[] {
  const r = res as any;
  const t = r?.tree ?? r?.page ?? r?.node ?? r?.nodes ?? r;
  if (Array.isArray(t)) return t.filter((n) => n && typeof n.type === 'string');
  if (t && typeof t.type === 'string') return t.type === 'core:page' ? (t.slots?.default ?? []) : [t];
  return [];
}
