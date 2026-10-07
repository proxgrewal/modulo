/** The page document: a tree of block instances, stored as JSONB. */
export interface PageNode {
  id: string;
  /** Namespaced block type, e.g. "core:section" or "shop:product-grid". */
  type: string;
  /** Block schema version the props were written against. */
  v?: number;
  props: Record<string, unknown>;
  /** Style props (tokens or CSS values); per-breakpoint overrides under responsive. */
  style?: StyleProps;
  responsive?: Partial<Record<Breakpoint, StyleProps>>;
  /** Interaction-state overrides (hover/focus/active). */
  states?: Partial<Record<StyleState, StyleProps>>;
  /** Named site style presets applied to this node (like design-tool classes). */
  presets?: string[];
  /** Extra class names for site custom CSS (sanitised: [a-z0-9-_]). */
  className?: string;
  slots?: Record<string, PageNode[]>;
  /** Data bindings: prop name -> "source:path" expression. */
  bind?: Record<string, string>;
  /** Provenance: which module (or "user") inserted this node. */
  origin?: string;
  /** Template nodes may be locked against user edits. */
  locked?: boolean;
  /** Editor-only display name in the layers panel. */
  name?: string;
}

/** Desktop is the base; overrides cascade down: md (tablet) → sm (mobile) → xs (small phone). */
export type Breakpoint = 'md' | 'sm' | 'xs';
export const BREAKPOINTS: Record<Breakpoint, number> = { md: 1024, sm: 640, xs: 420 };

export type StyleState = 'hover' | 'focus' | 'active';
export const STYLE_STATES: StyleState[] = ['hover', 'focus', 'active'];

/** Style values keyed by catalog property (see STYLE_PROPS in style.ts). */
export type StyleProps = Record<string, string | number | undefined>;

let counter = 0;
export function nodeId(prefix = 'n'): string {
  const rand = Math.random().toString(36).slice(2, 8);
  counter = (counter + 1) % 1296;
  return `${prefix}_${rand}${counter.toString(36)}`;
}

export function walk(
  node: PageNode,
  fn: (n: PageNode, parent: PageNode | null, slot: string | null) => void | false,
  parent: PageNode | null = null,
  slotName: string | null = null,
): void {
  if (fn(node, parent, slotName) === false) return;
  for (const [name, children] of Object.entries(node.slots ?? {})) {
    for (const c of children) walk(c, fn, node, name);
  }
}

export function findNode(root: PageNode, id: string): PageNode | null {
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

export interface Location {
  parent: PageNode;
  slot: string;
  index: number;
}

export function locate(root: PageNode, id: string): Location | null {
  let loc: Location | null = null;
  walk(root, (n, parent, slotName) => {
    if (loc) return false;
    if (n.id === id && parent && slotName) {
      loc = { parent, slot: slotName, index: parent.slots![slotName]!.indexOf(n) };
      return false;
    }
  });
  return loc;
}

export function cloneTree<T>(t: T): T {
  return structuredClone(t);
}

export function insertNode(root: PageNode, parentId: string, slotName: string, index: number, node: PageNode): PageNode {
  const next = cloneTree(root);
  const parent = findNode(next, parentId);
  if (!parent) throw new Error(`insertNode: parent ${parentId} not found`);
  parent.slots ??= {};
  const list = (parent.slots[slotName] ??= []);
  list.splice(Math.max(0, Math.min(index, list.length)), 0, node);
  return next;
}

export function removeNode(root: PageNode, id: string): PageNode {
  const next = cloneTree(root);
  const loc = locate(next, id);
  if (!loc) throw new Error(`removeNode: ${id} not found`);
  loc.parent.slots![loc.slot]!.splice(loc.index, 1);
  return next;
}

export function moveNode(root: PageNode, id: string, parentId: string, slotName: string, index: number): PageNode {
  const node = findNode(root, id);
  if (!node) throw new Error(`moveNode: ${id} not found`);
  if (findNode(node, parentId)) throw new Error('moveNode: cannot move a node into itself');
  const loc = locate(root, id)!;
  let adj = index;
  if (loc.parent.id === parentId && loc.slot === slotName && loc.index < index) adj -= 1;
  return insertNode(removeNode(root, id), parentId, slotName, adj, cloneTree(node));
}

export function updateNode(root: PageNode, id: string, fn: (n: PageNode) => void): PageNode {
  const next = cloneTree(root);
  const n = findNode(next, id);
  if (!n) throw new Error(`updateNode: ${id} not found`);
  fn(n);
  return next;
}

/** Deep-clone a subtree giving every node a fresh id (duplicate / paste). */
export function reId(node: PageNode): PageNode {
  const copy = cloneTree(node);
  walk(copy, (n) => {
    n.id = nodeId();
  });
  return copy;
}

export function emptyPage(): PageNode {
  return { id: 'root', type: 'core:page', props: {}, slots: { default: [] } };
}

/** A node without ids — used by block default children and layout presets. */
export interface NodeTemplate {
  type: string;
  props?: Record<string, unknown>;
  style?: StyleProps;
  responsive?: Partial<Record<Breakpoint, StyleProps>>;
  states?: Partial<Record<StyleState, StyleProps>>;
  presets?: string[];
  name?: string;
  slots?: Record<string, NodeTemplate[]>;
}

/** Give a template fresh ids (recursively). */
export function instantiate(t: NodeTemplate, origin = 'user'): PageNode {
  const node: PageNode = { id: nodeId(), type: t.type, props: structuredClone(t.props ?? {}), origin };
  if (t.style) node.style = structuredClone(t.style);
  if (t.responsive) node.responsive = structuredClone(t.responsive);
  if (t.states) node.states = structuredClone(t.states);
  if (t.presets) node.presets = [...t.presets];
  if (t.name) node.name = t.name;
  if (t.slots) node.slots = Object.fromEntries(Object.entries(t.slots).map(([k, v]) => [k, v.map((c) => instantiate(c, origin))]));
  return node;
}

/** Ready-made layouts/sections modules contribute to the insert palette. */
export interface LayoutPreset {
  id: string;
  label: string;
  category?: string;
  description?: string;
  icon?: string;
  node: NodeTemplate;
}
