import { nodeId, type PageNode, type PatchOp, type StyleProps } from '@modulo/core';

/**
 * Site-level layout customisations are a list of patch ops applied after all
 * module patches (PUT /api/sites/:site/layout {ops}). The patch engine prefixes
 * ids of inserted nodes with the patching module, "site." for these ops.
 */
export const SITE_PREFIX = 'site.';

export function siteNodeId(id: string): string {
  return id.startsWith(SITE_PREFIX) ? id : SITE_PREFIX + id;
}

type InsertOp = Extract<PatchOp, { node: PageNode }>;

function isInsert(op: PatchOp): op is InsertOp {
  return 'node' in op && op.op !== 'replace' && op.op !== 'wrap';
}

/** Find the site op that inserted the node now known as `id` (composed id, e.g. "site.about-link"). */
export function findInsertingOp(ops: PatchOp[], id: string): number {
  return ops.findIndex((op) => isInsert(op) && siteNodeId(op.node.id) === id);
}

function findInNode(node: PageNode, composedId: string): PageNode | null {
  if (siteNodeId(node.id) === composedId) return node;
  for (const kids of Object.values(node.slots ?? {})) {
    for (const k of kids) {
      const f = findInNode(k, composedId);
      if (f) return f;
    }
  }
  return null;
}

/**
 * Merge one new op into the existing site ops, keeping the list minimal:
 * - setProp/setStyle on a node the site itself added edits that node in place;
 * - setProp on the same target+prop replaces the earlier op;
 * - setStyle on the same target merges;
 * - removing a node the site added drops its insert op (and edits targeting it).
 */
export function mergeLayoutOp(ops: PatchOp[], op: PatchOp): PatchOp[] {
  const out = structuredClone(ops);
  switch (op.op) {
    case 'setProp': {
      for (const o of out) {
        if (isInsert(o)) {
          const n = findInNode(o.node, op.target);
          if (n) {
            n.props = { ...n.props, [op.prop]: op.value };
            return out;
          }
        }
      }
      const i = out.findIndex((o) => o.op === 'setProp' && o.target === op.target && o.prop === op.prop);
      if (i >= 0) out[i] = structuredClone(op);
      else out.push(structuredClone(op));
      return out;
    }
    case 'setStyle': {
      for (const o of out) {
        if (isInsert(o)) {
          const n = findInNode(o.node, op.target);
          if (n) {
            if (op.state) {
              const st = cleanStyle({ ...(n.states?.[op.state] ?? {}), ...op.style });
              n.states = { ...(n.states ?? {}), [op.state]: st };
              if (!Object.keys(st).length) delete n.states[op.state];
              if (!Object.keys(n.states).length) delete n.states;
            } else if (op.bp) {
              const st = cleanStyle({ ...(n.responsive?.[op.bp] ?? {}), ...op.style });
              n.responsive = { ...(n.responsive ?? {}), [op.bp]: st };
              if (!Object.keys(st).length) delete n.responsive[op.bp];
              if (!Object.keys(n.responsive).length) delete n.responsive;
            } else n.style = cleanStyle({ ...(n.style ?? {}), ...op.style });
            return out;
          }
        }
      }
      const same = (o: PatchOp): o is Extract<PatchOp, { op: 'setStyle' }> => o.op === 'setStyle' && o.target === op.target && (o.bp ?? null) === (op.bp ?? null) && (o.state ?? null) === (op.state ?? null);
      const i = out.findIndex(same);
      const layerOf = (style: StyleProps): PatchOp => ({ op: 'setStyle', target: op.target, style, ...(op.bp ? { bp: op.bp } : {}), ...(op.state ? { state: op.state } : {}) });
      if (i >= 0) {
        const prev = out[i] as Extract<PatchOp, { op: 'setStyle' }>;
        const merged = cleanStyle({ ...prev.style, ...op.style });
        if (Object.keys(merged).length) out[i] = layerOf(merged);
        else out.splice(i, 1);
      } else {
        const st = cleanStyle(op.style);
        if (Object.keys(st).length) out.push(layerOf(st));
      }
      return out;
    }
    case 'setField': {
      for (const o of out) {
        if (isInsert(o)) {
          const n = findInNode(o.node, op.target);
          if (n) {
            const empty = op.value === undefined || op.value === '' || (Array.isArray(op.value) && !op.value.length);
            if (empty) delete (n as any)[op.field];
            else (n as any)[op.field] = structuredClone(op.value);
            return out;
          }
        }
      }
      const i = out.findIndex((o) => o.op === 'setField' && o.target === op.target && o.field === op.field);
      if (i >= 0) out[i] = structuredClone(op);
      else out.push(structuredClone(op));
      return out;
    }
    case 'remove': {
      const i = findInsertingOp(out, op.target);
      if (i >= 0) {
        out.splice(i, 1);
        return out.filter((o) => !(('target' in o) && o.target.split('#')[0] === op.target));
      }
      // Nested inside a site-added node: remove from that node.
      for (const o of out) {
        if (isInsert(o) && removeFromNode(o.node, op.target)) return out;
      }
      const kept = out.filter((o) => !((o.op === 'setProp' || o.op === 'setStyle' || o.op === 'setField') && o.target === op.target));
      if (!kept.some((o) => o.op === 'remove' && o.target === op.target)) kept.push({ op: 'remove', target: op.target });
      return kept;
    }
    default:
      return [...out, structuredClone(op)];
  }
}

function removeFromNode(node: PageNode, composedId: string): boolean {
  for (const [s, kids] of Object.entries(node.slots ?? {})) {
    const i = kids.findIndex((k) => siteNodeId(k.id) === composedId);
    if (i >= 0) {
      node.slots![s] = kids.filter((_, j) => j !== i);
      return true;
    }
    if (kids.some((k) => removeFromNode(k, composedId))) return true;
  }
  return false;
}

/** Apply one layout op optimistically to a composed layout tree (setProp / setStyle / setField). */
export function applyLayoutOpLocally(tree: PageNode, op: PatchOp): void {
  if (op.op !== 'setProp' && op.op !== 'setStyle' && op.op !== 'setField') return;
  const n = findComposed(tree, op.target);
  if (!n) return;
  if (op.op === 'setProp') n.props = { ...n.props, [op.prop]: op.value };
  else if (op.op === 'setField') {
    const empty = op.value === undefined || op.value === '' || (Array.isArray(op.value) && !op.value.length);
    if (empty) delete (n as any)[op.field];
    else (n as any)[op.field] = structuredClone(op.value);
  } else {
    const merge = (cur: StyleProps | undefined) => {
      const next: StyleProps = { ...(cur ?? {}) };
      for (const [k, v] of Object.entries(op.style)) v === '' || v === undefined || v === null ? delete next[k] : (next[k] = v);
      return next;
    };
    if (op.state) n.states = { ...(n.states ?? {}), [op.state]: merge(n.states?.[op.state]) };
    else if (op.bp) n.responsive = { ...(n.responsive ?? {}), [op.bp]: merge(n.responsive?.[op.bp]) };
    else n.style = merge(n.style);
  }
}

function findComposed(node: PageNode, id: string): PageNode | null {
  if (node.id === id) return node;
  for (const kids of Object.values(node.slots ?? {})) {
    for (const k of kids) {
      const f = findComposed(k, id);
      if (f) return f;
    }
  }
  return null;
}

function cleanStyle(s: StyleProps): StyleProps {
  return Object.fromEntries(Object.entries(s).filter(([, v]) => v !== undefined && v !== '')) as StyleProps;
}

export function mergeLayoutOps(ops: PatchOp[], add: PatchOp[]): PatchOp[] {
  return add.reduce(mergeLayoutOp, ops);
}

/** A new navigation link appended to the header's nav slot. */
export function navLinkOp(label: string, href: string, id = nodeId('link')): PatchOp {
  return { op: 'append', target: 'header#nav', node: { id, type: 'core:link', props: { label, href } } };
}

export function setPropOp(target: string, prop: string, value: unknown): PatchOp {
  return { op: 'setProp', target, prop, value };
}

/** Props changed between two prop objects, as setProp ops. */
export function diffPropsToOps(target: string, before: Record<string, unknown>, after: Record<string, unknown>): PatchOp[] {
  const ops: PatchOp[] = [];
  for (const [k, v] of Object.entries(after)) if (JSON.stringify(before[k]) !== JSON.stringify(v)) ops.push(setPropOp(target, k, v));
  return ops;
}

/** Human description of an op for the Layout panel. */
export function describeOp(op: PatchOp): string {
  switch (op.op) {
    case 'append':
    case 'prepend':
      return `${op.op === 'append' ? 'Add' : 'Prepend'} ${op.node.type.split(':')[1]} "${String(op.node.props.label ?? op.node.props.text ?? op.node.id)}" to ${op.target}`;
    case 'insertBefore':
    case 'insertAfter':
      return `Insert ${op.node.type} ${op.op === 'insertBefore' ? 'before' : 'after'} ${op.target}`;
    case 'replace':
      return `Replace ${op.target}`;
    case 'remove':
      return `Remove ${op.target}`;
    case 'setProp':
      return `Set ${op.target}.${op.prop} = ${JSON.stringify(op.value).slice(0, 40)}`;
    case 'setStyle':
      return `Style ${op.target}${op.bp ? ` (${op.bp})` : ''}${op.state ? ` :${op.state}` : ''}`;
    case 'setField':
      return `Set ${op.target} ${op.field}`;
    case 'wrap':
      return `Wrap ${op.target}`;
  }
}
