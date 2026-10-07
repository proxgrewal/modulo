import * as Y from 'yjs';
import type { PageNode, StyleProps, Breakpoint, StyleState } from '@modulo/core';

/**
 * Page documents as a CRDT. Nodes live in a flat Y.Map keyed by id, each with
 * parent/slot/pos (fractional index) and a nested Y.Map of props, so two people
 * editing different props of the same block, or moving different blocks,
 * merge without conflicts. The tree is re-derived deterministically.
 */
const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** A key strictly between a and b (a may be '' = start, b may be null = end). */
export function keyBetween(a: string, b: string | null): string {
  if (b !== null && a >= b) throw new Error(`keyBetween: ${a} >= ${b}`);
  if (b !== null) {
    let n = 0;
    while ((a[n] ?? '0') === b[n]) n++;
    if (n > 0) return b.slice(0, n) + keyBetween(a.slice(n), b.slice(n));
  }
  const da = a ? DIGITS.indexOf(a[0]!) : 0;
  const db = b !== null ? DIGITS.indexOf(b[0]!) : DIGITS.length;
  if (db - da > 1) return DIGITS[Math.round((da + db) / 2)]!;
  if (b !== null && b.length > 1) return b.slice(0, 1);
  return DIGITS[da]! + keyBetween(a.slice(1), null);
}

type YNode = Y.Map<any>;

export function nodesMap(doc: Y.Doc): Y.Map<YNode> {
  return doc.getMap('nodes');
}

function setPlain(m: YNode, key: string, v: unknown) {
  if (v === undefined) m.delete(key);
  else m.set(key, v);
}

function writeNode(nodes: Y.Map<YNode>, node: PageNode, parent: string | null, slot: string | null, pos: string) {
  const m = new Y.Map<any>();
  nodes.set(node.id, m);
  m.set('type', node.type);
  setPlain(m, 'v', node.v);
  m.set('parent', parent);
  m.set('slot', slot);
  m.set('pos', pos);
  const props = new Y.Map<any>();
  m.set('props', props);
  for (const [k, v] of Object.entries(node.props ?? {})) props.set(k, v);
  const style = new Y.Map<any>();
  m.set('style', style);
  for (const [k, v] of Object.entries(node.style ?? {})) style.set(k, v);
  setPlain(m, 'responsive', node.responsive);
  setPlain(m, 'states', node.states);
  setPlain(m, 'presets', node.presets);
  setPlain(m, 'className', node.className);
  setPlain(m, 'name', node.name);
  setPlain(m, 'bind', node.bind);
  setPlain(m, 'origin', node.origin);
  setPlain(m, 'locked', node.locked);
  setPlain(m, 'slotNames', node.slots ? Object.keys(node.slots) : undefined);
  for (const [s, children] of Object.entries(node.slots ?? {})) {
    let prev = '';
    for (const c of children) {
      prev = keyBetween(prev, null);
      writeNode(nodes, c, node.id, s, prev);
    }
  }
}

export function loadTree(doc: Y.Doc, tree: PageNode) {
  doc.transact(() => {
    const nodes = nodesMap(doc);
    for (const k of [...nodes.keys()]) nodes.delete(k);
    doc.getMap('meta').set('root', tree.id);
    writeNode(nodes, tree, null, null, 'V');
  }, 'load');
}

export function readTree(doc: Y.Doc): PageNode | null {
  const nodes = nodesMap(doc);
  const rootId = doc.getMap('meta').get('root') as string | undefined;
  if (!rootId || !nodes.has(rootId)) return null;
  const children = new Map<string, { id: string; slot: string; pos: string }[]>();
  nodes.forEach((m, id) => {
    const p = m.get('parent');
    if (p == null) return;
    const list = children.get(p) ?? [];
    list.push({ id, slot: m.get('slot'), pos: m.get('pos') });
    children.set(p, list);
  });
  const seen = new Set<string>();
  const build = (id: string): PageNode | null => {
    if (seen.has(id)) return null; // concurrent moves can create cycles; first visit wins
    seen.add(id);
    const m = nodes.get(id);
    if (!m) return null;
    const node: PageNode = { id, type: m.get('type'), props: (m.get('props') as Y.Map<any>)?.toJSON() ?? {} };
    const v = m.get('v');
    if (v !== undefined) node.v = v;
    const style = (m.get('style') as Y.Map<any> | undefined)?.toJSON();
    if (style && Object.keys(style).length) node.style = style as StyleProps;
    for (const k of ['responsive', 'states', 'presets', 'className', 'name', 'bind', 'origin', 'locked'] as const) {
      const val = m.get(k);
      if (val !== undefined) (node as any)[k] = val;
    }
    const slotNames: string[] = m.get('slotNames') ?? [];
    const kids = (children.get(id) ?? []).sort((a, b) => (a.pos < b.pos ? -1 : a.pos > b.pos ? 1 : a.id < b.id ? -1 : 1));
    if (slotNames.length || kids.length) {
      node.slots = {};
      for (const s of slotNames) node.slots[s] = [];
      for (const k of kids) {
        const c = build(k.id);
        if (c) (node.slots[k.slot] ??= []).push(c);
      }
    }
    return node;
  };
  return build(rootId);
}

function siblings(doc: Y.Doc, parentId: string, slot: string, exclude?: string): { id: string; pos: string }[] {
  const out: { id: string; pos: string }[] = [];
  nodesMap(doc).forEach((m, id) => {
    if (m.get('parent') === parentId && m.get('slot') === slot && id !== exclude) out.push({ id, pos: m.get('pos') });
  });
  return out.sort((a, b) => (a.pos < b.pos ? -1 : a.pos > b.pos ? 1 : a.id < b.id ? -1 : 1));
}

function posAt(doc: Y.Doc, parentId: string, slot: string, index: number, exclude?: string): string {
  const sib = siblings(doc, parentId, slot, exclude);
  const i = Math.max(0, Math.min(index, sib.length));
  const before = i > 0 ? sib[i - 1]!.pos : '';
  const after = i < sib.length ? sib[i]!.pos : null;
  if (after !== null && before >= after) return keyBetween(before, null); // equal keys from concurrent inserts
  return keyBetween(before, after);
}

function ensureSlot(doc: Y.Doc, parentId: string, slot: string) {
  const p = nodesMap(doc).get(parentId);
  if (!p) throw new Error(`Parent ${parentId} not found`);
  const names: string[] = p.get('slotNames') ?? [];
  if (!names.includes(slot)) p.set('slotNames', [...names, slot]);
}

export function yInsert(doc: Y.Doc, node: PageNode, parentId: string, slot: string, index: number) {
  doc.transact(() => {
    ensureSlot(doc, parentId, slot);
    writeNode(nodesMap(doc), node, parentId, slot, posAt(doc, parentId, slot, index));
  });
}

export function yRemove(doc: Y.Doc, id: string) {
  doc.transact(() => {
    const nodes = nodesMap(doc);
    const kill = [id];
    while (kill.length) {
      const cur = kill.pop()!;
      nodes.forEach((m, cid) => {
        if (m.get('parent') === cur) kill.push(cid);
      });
      nodes.delete(cur);
    }
  });
}

export function yMove(doc: Y.Doc, id: string, parentId: string, slot: string, index: number) {
  doc.transact(() => {
    const nodes = nodesMap(doc);
    const m = nodes.get(id);
    if (!m) throw new Error(`Node ${id} not found`);
    for (let p: string | null = parentId; p; p = nodes.get(p)?.get('parent') ?? null) {
      if (p === id) throw new Error('Cannot move a node into itself');
    }
    ensureSlot(doc, parentId, slot);
    m.set('pos', posAt(doc, parentId, slot, index, id));
    m.set('parent', parentId);
    m.set('slot', slot);
  });
}

export function ySetProps(doc: Y.Doc, id: string, props: Record<string, unknown>) {
  doc.transact(() => {
    const p = nodesMap(doc).get(id)?.get('props') as Y.Map<any> | undefined;
    if (!p) throw new Error(`Node ${id} not found`);
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined) p.delete(k);
      else if (JSON.stringify(p.get(k)) !== JSON.stringify(v)) p.set(k, v);
    }
  });
}

/** Set style values for the base style, a breakpoint override, or an interaction state. Empty values clear. */
export function ySetStyle(doc: Y.Doc, id: string, style: Partial<StyleProps>, bp?: Breakpoint, state?: StyleState) {
  doc.transact(() => {
    const m = nodesMap(doc).get(id);
    if (!m) throw new Error(`Node ${id} not found`);
    if (state) {
      const all = { ...(m.get('states') ?? {}) };
      const cur = { ...(all[state] ?? {}) };
      for (const [k, v] of Object.entries(style)) v === undefined || v === '' ? delete cur[k] : (cur[k] = v);
      if (Object.keys(cur).length) all[state] = cur;
      else delete all[state];
      Object.keys(all).length ? m.set('states', all) : m.delete('states');
    } else if (!bp) {
      const s = m.get('style') as Y.Map<any>;
      for (const [k, v] of Object.entries(style)) v === undefined || v === '' ? s.delete(k) : s.set(k, v);
    } else {
      const r = { ...(m.get('responsive') ?? {}) };
      const cur = { ...(r[bp] ?? {}) };
      for (const [k, v] of Object.entries(style)) v === undefined || v === '' ? delete cur[k] : (cur[k] = v);
      if (Object.keys(cur).length) r[bp] = cur;
      else delete r[bp];
      Object.keys(r).length ? m.set('responsive', r) : m.delete('responsive');
    }
  });
}

/** Replace a node's whole style (all breakpoints/states) — used by "paste style" and "clear style". */
export function yReplaceStyle(doc: Y.Doc, id: string, next: { style?: StyleProps; responsive?: PageNode['responsive']; states?: PageNode['states'] }) {
  doc.transact(() => {
    const m = nodesMap(doc).get(id);
    if (!m) throw new Error(`Node ${id} not found`);
    const s = m.get('style') as Y.Map<any>;
    for (const k of [...s.keys()]) s.delete(k);
    for (const [k, v] of Object.entries(next.style ?? {})) if (v !== undefined && v !== '') s.set(k, v);
    next.responsive && Object.keys(next.responsive).length ? m.set('responsive', next.responsive) : m.delete('responsive');
    next.states && Object.keys(next.states).length ? m.set('states', next.states) : m.delete('states');
  });
}

export function ySetField(doc: Y.Doc, id: string, key: 'bind' | 'locked' | 'origin' | 'presets' | 'className' | 'name', value: unknown) {
  const m = nodesMap(doc).get(id);
  if (!m) throw new Error(`Node ${id} not found`);
  doc.transact(() => setPlain(m, key, value === '' || (Array.isArray(value) && !value.length) ? undefined : value));
}
