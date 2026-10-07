import type { PageNode } from '@modulo/core';
import { cloneWithNewIds, firstAcceptingSlot, locateNode, PAGE_ROOT, slotAccepts, type SchemaMap } from './tree.ts';

/** Document edits, applied by the store as Yjs operations (yInsert / yMove / yRemove). */
export type DocOp =
  | { op: 'insert'; node: PageNode; parentId: string; slot: string; index: number }
  | { op: 'move'; id: string; parentId: string; slot: string; index: number }
  | { op: 'remove'; id: string };

export type Command =
  | 'delete'
  | 'duplicate'
  | 'copy'
  | 'paste'
  | 'undo'
  | 'redo'
  | 'selectPrev'
  | 'selectNext'
  | 'selectParent'
  | 'moveUp'
  | 'moveDown'
  | 'focusSearch'
  | 'deselect';

export interface KeyLike {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}

/** Map a keyboard event to an editor command (null = not ours). */
export function keyToCommand(e: KeyLike, isMac = false): Command | null {
  const mod = isMac ? !!e.metaKey : !!e.ctrlKey;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (mod && !e.altKey) {
    if (key === 'z') return e.shiftKey ? 'redo' : 'undo';
    if (key === 'y' && !isMac) return 'redo';
    if (key === 'd') return 'duplicate';
    if (key === 'c') return 'copy';
    if (key === 'v') return 'paste';
    return null;
  }
  if (e.altKey && !mod) {
    if (key === 'ArrowUp') return 'moveUp';
    if (key === 'ArrowDown') return 'moveDown';
    return null;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  switch (key) {
    case 'Delete':
    case 'Backspace':
      return 'delete';
    case 'ArrowUp':
      return 'selectPrev';
    case 'ArrowDown':
      return 'selectNext';
    case 'Escape':
      return 'selectParent';
    case '/':
      return 'focusSearch';
    default:
      return null;
  }
}

export interface CommandContext {
  tree: PageNode | null;
  selection: string | null;
  clipboard: PageNode | null;
  schemas: SchemaMap;
}

export interface CommandResult {
  ops: DocOp[];
  /** New selection (undefined = keep). */
  select?: string | null;
  clipboard?: PageNode;
  /** Message for a toast / screen reader. */
  announce?: string;
}

/**
 * Pure command reducer: what a command does to the document and selection.
 * Undo/redo/focusSearch are handled by the caller (they are not document ops).
 */
export function planCommand(cmd: Command, ctx: CommandContext): CommandResult {
  const { tree, selection } = ctx;
  const none: CommandResult = { ops: [] };
  if (!tree) return none;
  const loc = selection ? locateNode(tree, selection) : null;
  const node = loc ? loc.siblings[loc.index]! : null;
  switch (cmd) {
    case 'delete': {
      if (!node || !loc || node.locked) return none;
      const next = loc.siblings[loc.index + 1] ?? loc.siblings[loc.index - 1] ?? null;
      return { ops: [{ op: 'remove', id: node.id }], select: next ? next.id : loc.parent.id === PAGE_ROOT ? null : loc.parent.id, announce: 'Block deleted' };
    }
    case 'duplicate': {
      if (!node || !loc) return none;
      const copy = cloneWithNewIds({ ...node, locked: undefined });
      return { ops: [{ op: 'insert', node: copy, parentId: loc.parent.id, slot: loc.slot, index: loc.index + 1 }], select: copy.id, announce: 'Block duplicated' };
    }
    case 'copy': {
      if (!node) return none;
      return { ops: [], clipboard: structuredClone(node), announce: 'Copied' };
    }
    case 'paste': {
      const clip = ctx.clipboard;
      if (!clip) return none;
      const copy = cloneWithNewIds({ ...clip, locked: undefined });
      // Paste inside the selection if it can hold the block, else after it, else at the end of the page.
      if (node && loc) {
        const inner = firstAcceptingSlot(ctx.schemas, node, copy.type);
        if (inner && (node.slots?.[inner]?.length ?? 0) === 0) {
          return { ops: [{ op: 'insert', node: copy, parentId: node.id, slot: inner, index: 0 }], select: copy.id, announce: 'Pasted' };
        }
        if (slotAccepts(ctx.schemas, loc.parent.type, loc.slot, copy.type)) {
          return { ops: [{ op: 'insert', node: copy, parentId: loc.parent.id, slot: loc.slot, index: loc.index + 1 }], select: copy.id, announce: 'Pasted' };
        }
      }
      const count = tree.slots?.default?.length ?? 0;
      return { ops: [{ op: 'insert', node: copy, parentId: tree.id, slot: 'default', index: count }], select: copy.id, announce: 'Pasted' };
    }
    case 'selectPrev': {
      if (!loc) {
        const first = tree.slots?.default?.[0];
        return { ops: [], select: first?.id ?? null };
      }
      const prev = loc.siblings[loc.index - 1];
      return prev ? { ops: [], select: prev.id } : none;
    }
    case 'selectNext': {
      if (!loc) {
        const first = tree.slots?.default?.[0];
        return { ops: [], select: first?.id ?? null };
      }
      const nxt = loc.siblings[loc.index + 1];
      return nxt ? { ops: [], select: nxt.id } : none;
    }
    case 'selectParent': {
      if (!loc) return none;
      return { ops: [], select: loc.parent.id === PAGE_ROOT ? null : loc.parent.id };
    }
    case 'moveUp':
    case 'moveDown': {
      if (!node || !loc || node.locked) return none;
      const to = cmd === 'moveUp' ? loc.index - 1 : loc.index + 1;
      if (to < 0 || to >= loc.siblings.length) return none;
      return { ops: [{ op: 'move', id: node.id, parentId: loc.parent.id, slot: loc.slot, index: to }], select: node.id };
    }
    case 'deselect':
      return { ops: [], select: null };
    default:
      return none;
  }
}

/** Ops to insert nodes right after the selection (or at the end of the page). */
export function insertAfterSelection(tree: PageNode, selection: string | null, nodes: PageNode[], schemas: SchemaMap): DocOp[] {
  const loc = selection ? locateNode(tree, selection) : null;
  if (loc && nodes.every((n) => slotAccepts(schemas, loc.parent.type, loc.slot, n.type))) {
    return nodes.map((n, i) => ({ op: 'insert', node: n, parentId: loc.parent.id, slot: loc.slot, index: loc.index + 1 + i }));
  }
  const count = tree.slots?.default?.length ?? 0;
  return nodes.map((n, i) => ({ op: 'insert', node: n, parentId: tree.id, slot: 'default', index: count + i }));
}

/** Ops replacing all top-level page content (restore revision / AI "replace page"). */
export function replacePageOps(tree: PageNode, nodes: PageNode[]): DocOp[] {
  const ops: DocOp[] = (tree.slots?.default ?? []).map((n) => ({ op: 'remove', id: n.id }));
  nodes.forEach((n, i) => ops.push({ op: 'insert', node: n, parentId: tree.id, slot: 'default', index: i }));
  return ops;
}
