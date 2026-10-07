import { defaultsFor, instantiate, matchType, nodeId, reId, walk, type NodeTemplate, type PageNode } from '@modulo/core';
import type { BlockSchema } from '../types.ts';

/** The page document root (a core:page node). Its "default" slot holds top-level blocks. */
export const PAGE_ROOT = 'root';
/** The id of the layout outlet the canvas renders page content into. */
export const OUTLET_ID = 'main';

/**
 * The canvas renders the page inside the site layout, so top-level page blocks
 * appear in `<m-slot data-parent="main">`. Map canvas parent ids to document ids.
 */
export function canvasToDocParent(parentId: string, pageRootId: string | null = OUTLET_ID): string {
  return pageRootId && parentId === pageRootId ? PAGE_ROOT : parentId;
}

export function docToCanvasParent(parentId: string, pageRootId: string | null = OUTLET_ID): string {
  return parentId === PAGE_ROOT && pageRootId ? pageRootId : parentId;
}

export type SchemaMap = Map<string, BlockSchema>;

export function schemaMap(blocks: BlockSchema[]): SchemaMap {
  return new Map(blocks.map((b) => [b.type, b]));
}

/** Whether `childType` may be placed in `parentType`'s slot `slot` (respects slot allow lists). */
export function slotAccepts(schemas: SchemaMap, parentType: string, slot: string, childType: string): boolean {
  if (parentType === 'core:page') return slot === 'default';
  // A synced component instance's content comes from the library, not the page.
  if (parentType === INSTANCE_TYPE) return false;
  const def = schemas.get(parentType);
  if (!def) return false;
  const spec = def.slots?.find((s) => s.name === slot);
  if (!spec) return false;
  if (!spec.allow?.length) return true;
  return spec.allow.some((a) => matchType(a, childType));
}

/** First slot of a block that accepts the given child type. */
export function firstAcceptingSlot(schemas: SchemaMap, parent: PageNode, childType: string): string | null {
  if (parent.type === 'core:page') return 'default';
  const def = schemas.get(parent.type);
  for (const s of def?.slots ?? []) if (slotAccepts(schemas, parent.type, s.name, childType)) return s.name;
  return null;
}

export function findNode(root: PageNode | null, id: string): PageNode | null {
  if (!root) return null;
  let found: PageNode | null = null;
  walk(root, (n) => {
    if (found) return false;
    if (n.id === id) {
      found = n;
      return false;
    }
  });
  return found;
}

export interface NodeLocation {
  parent: PageNode;
  slot: string;
  index: number;
  siblings: PageNode[];
}

export function locateNode(root: PageNode | null, id: string): NodeLocation | null {
  if (!root) return null;
  let loc: NodeLocation | null = null;
  walk(root, (n, parent, slot) => {
    if (loc) return false;
    if (n.id === id && parent && slot) {
      const siblings = parent.slots![slot]!;
      loc = { parent, slot, index: siblings.indexOf(n), siblings };
      return false;
    }
  });
  return loc;
}

/** True when `id` is `ancestorId` or lies inside it. */
export function isInside(root: PageNode | null, id: string, ancestorId: string): boolean {
  const anc = findNode(root, ancestorId);
  return !!anc && !!findNode(anc, id);
}

/** Ids from the root down to (and including) the node. */
export function pathTo(root: PageNode | null, id: string): string[] {
  if (!root) return [];
  const out: string[] = [];
  const rec = (n: PageNode): boolean => {
    out.push(n.id);
    if (n.id === id) return true;
    for (const kids of Object.values(n.slots ?? {})) for (const k of kids) if (rec(k)) return true;
    out.pop();
    return false;
  };
  return rec(root) ? out : [];
}

/** Create a fresh node for a block schema with field defaults, default children (fresh ids) and default style. */
export function createNode(schema: BlockSchema, origin = 'user'): PageNode {
  const node: PageNode = { id: nodeId(), type: schema.type, v: schema.version, props: defaultsFor(schema.fields), origin };
  if (schema.slots?.length) node.slots = Object.fromEntries(schema.slots.map((s) => [s.name, (schema.defaultChildren?.[s.name] ?? []).map((t) => instantiateTemplate(t, origin))]));
  if (schema.defaultStyle && Object.keys(schema.defaultStyle).length) node.style = structuredClone(schema.defaultStyle);
  return node;
}

/** Instantiate a node template (layout preset / default children) with fresh ids, dropping empty style maps. */
export function instantiateTemplate(t: NodeTemplate, origin = 'user', schemas?: SchemaMap): PageNode {
  const n = instantiate(t, origin);
  walk(n, (x) => {
    if (x.style && !Object.keys(x.style).length) delete x.style;
    if (x.name === undefined) delete x.name;
    const def = schemas?.get(x.type);
    if (def) {
      if (x.v === undefined) x.v = def.version;
      x.props = { ...defaultsFor(def.fields), ...x.props };
      // Make sure every declared slot exists so the canvas offers a drop zone.
      for (const s of def.slots ?? []) {
        x.slots ??= {};
        x.slots[s.name] ??= [];
      }
    }
  });
  return n;
}

/** The block type of a synced library component instance. */
export const INSTANCE_TYPE = 'library:instance';

/** A fresh synced instance of a library component. */
export function instanceNode(componentId: string): PageNode {
  return { id: nodeId(), type: INSTANCE_TYPE, v: 1, props: { component: componentId }, slots: { default: [] } };
}

/** Canvas ids "<instanceId>~<innerId>" belong to an expanded synced instance: map to the instance. */
export function canvasSelectableId(id: string): string {
  const i = id.indexOf('~');
  return i > 0 ? id.slice(0, i) : id;
}

/** Strip ids and editor-only fields to get a reusable copy with fresh ids. */
export function copyOfComponent(node: PageNode): PageNode {
  const copy = reId(node);
  walk(copy, (n) => {
    delete n.locked;
    if (n.origin === 'library') n.origin = 'user';
  });
  return copy;
}

/** Deep copy with fresh ids (duplicate / paste). */
export function cloneWithNewIds(node: PageNode): PageNode {
  return reId(node);
}

function shallowJsonEqual(a: unknown, b: unknown) {
  if (a === b) return true;
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Structural sharing: returns `next`, but re-uses objects from `prev` for every
 * subtree that did not change, so memoised components keyed on node identity
 * only re-render when their node actually changed.
 */
export function shareTree(prev: PageNode | null, next: PageNode | null): PageNode | null {
  if (!prev || !next) return next;
  if (prev.id !== next.id) return next;
  let same = prev.type === next.type && prev.v === next.v && prev.locked === next.locked && prev.origin === next.origin;
  same = same && prev.name === next.name && prev.className === next.className;
  same = same && shallowJsonEqual(prev.props, next.props) && shallowJsonEqual(prev.style, next.style) && shallowJsonEqual(prev.responsive, next.responsive) && shallowJsonEqual(prev.states, next.states) && shallowJsonEqual(prev.presets, next.presets) && shallowJsonEqual(prev.bind, next.bind);
  let slots: Record<string, PageNode[]> | undefined;
  if (next.slots) {
    slots = {};
    const prevSlots = prev.slots ?? {};
    if (Object.keys(prevSlots).length !== Object.keys(next.slots).length) same = false;
    for (const [name, kids] of Object.entries(next.slots)) {
      const pk = prevSlots[name] ?? [];
      const prevById = new Map(pk.map((k) => [k.id, k]));
      const shared = kids.map((k) => shareTree(prevById.get(k.id) ?? null, k)!);
      if (shared.length !== pk.length || shared.some((k, i) => k !== pk[i])) {
        same = false;
        slots[name] = shared;
      } else slots[name] = pk;
    }
  } else if (prev.slots) same = false;
  if (same) return prev;
  return { ...next, ...(slots ? { slots } : {}) };
}

/** Short human label for a node: block label + a text snippet if it has one. */
export function nodeLabel(node: PageNode, schemas: SchemaMap): string {
  return node.name || (schemas.get(node.type)?.label ?? node.type);
}

export function nodeSnippet(node: PageNode): string {
  const p = node.props ?? {};
  for (const k of ['text', 'title', 'label', 'heading', 'name', 'html', 'quote', 'caption', 'alt']) {
    const v = p[k];
    if (typeof v === 'string' && v.trim()) return v.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
  }
  return '';
}

export interface FlatNode {
  node: PageNode;
  depth: number;
  parentId: string | null;
  slot: string | null;
  hasChildren: boolean;
}

/** Flatten the visible part of a tree (collapsed nodes hide their children). */
export function flattenTree(root: PageNode, collapsed: Set<string>, includeRoot = false): FlatNode[] {
  const out: FlatNode[] = [];
  const rec = (n: PageNode, depth: number, parentId: string | null, slot: string | null) => {
    const kids = Object.values(n.slots ?? {}).flat();
    out.push({ node: n, depth, parentId, slot, hasChildren: kids.length > 0 });
    if (collapsed.has(n.id)) return;
    for (const [s, list] of Object.entries(n.slots ?? {})) for (const k of list) rec(k, depth + 1, n.id, s);
  };
  if (includeRoot) rec(root, 0, null, null);
  else for (const [s, list] of Object.entries(root.slots ?? {})) for (const k of list) rec(k, 0, root.id, s);
  return out;
}

/** Collect the ids of a subtree. */
export function subtreeIds(node: PageNode): string[] {
  const ids: string[] = [];
  walk(node, (n) => void ids.push(n.id));
  return ids;
}
