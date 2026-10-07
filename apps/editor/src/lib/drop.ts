/**
 * Drop-target resolution for the iframe canvas. Pure functions over geometry
 * snapshots so they can be unit-tested with fake rects; the DOM side
 * (canvas.ts) only measures.
 */
export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Point {
  x: number;
  y: number;
}

export type Flow = 'row' | 'column';

export interface ChildGeom {
  id: string;
  rect: Rect;
}

/** One `<m-slot>` on the canvas, measured. */
export interface SlotGeom {
  /** Document parent id (already mapped main -> root). */
  parentId: string;
  parentType: string;
  slot: string;
  /** Ids from the outermost node down to the parent (used to forbid dropping into the dragged subtree). */
  ancestors: string[];
  /** Nesting depth (deeper wins). */
  depth: number;
  /** Rect of the element that owns the slot. */
  parentRect: Rect;
  /** Rect of the m-slot itself when empty (EDIT_CSS makes empty slots a block drop zone). */
  emptyRect: Rect | null;
  flow: Flow;
  children: ChildGeom[];
}

export interface Indicator {
  kind: 'line' | 'box';
  /** For lines: orientation of the line. Horizontal lines sit between stacked children. */
  orientation: 'horizontal' | 'vertical';
  rect: Rect;
}

export interface DropTarget {
  parentId: string;
  slot: string;
  index: number;
  indicator: Indicator;
}

export const rectW = (r: Rect) => r.right - r.left;
export const rectH = (r: Rect) => r.bottom - r.top;

export function contains(r: Rect, p: Point, pad = 0): boolean {
  return p.x >= r.left - pad && p.x <= r.right + pad && p.y >= r.top - pad && p.y <= r.bottom + pad;
}

export function union(rects: Rect[]): Rect | null {
  if (!rects.length) return null;
  return {
    left: Math.min(...rects.map((r) => r.left)),
    top: Math.min(...rects.map((r) => r.top)),
    right: Math.max(...rects.map((r) => r.right)),
    bottom: Math.max(...rects.map((r) => r.bottom)),
  };
}

export function distanceToRect(r: Rect, p: Point): number {
  const dx = Math.max(r.left - p.x, 0, p.x - r.right);
  const dy = Math.max(r.top - p.y, 0, p.y - r.bottom);
  return Math.hypot(dx, dy);
}

/** Count top-level tracks in a grid-template-columns value (handles nested parentheses and repeat()). */
export function gridTrackCount(value: string): number {
  const v = value.trim();
  if (!v || v === 'none') return 0;
  let depth = 0;
  let count = 0;
  let inToken = false;
  for (let i = 0; i < v.length; i++) {
    const ch = v[i]!;
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (depth === 0 && /\s/.test(ch)) inToken = false;
    else if (!inToken) {
      inToken = true;
      count++;
    }
  }
  const rep = /^repeat\(\s*(\d+)\s*,/.exec(v);
  if (rep && count === 1) return Number(rep[1]);
  return count;
}

/**
 * Detect whether children flow in a row or a column from the container's
 * computed style, falling back to the children's positions.
 */
export function detectFlow(style: { display?: string; flexDirection?: string; gridTemplateColumns?: string } | null, childRects: Rect[] = []): Flow {
  if (style) {
    const d = style.display ?? '';
    if (d.includes('flex')) return (style.flexDirection ?? 'row').startsWith('row') ? 'row' : 'column';
    if (d.includes('grid')) {
      return gridTrackCount(style.gridTemplateColumns ?? '') > 1 ? 'row' : 'column';
    }
  }
  if (childRects.length >= 2) {
    const [a, b] = childRects;
    if (Math.abs(a!.top - b!.top) < 4 && b!.left >= a!.right - 4) return 'row';
  }
  return 'column';
}

/**
 * Insertion index for a point among ordered children.
 * Column flow: before the first child whose vertical midpoint is below the point.
 * Row flow (incl. wrapping grids): before the first child on a later line, or
 * on the same line whose horizontal midpoint is right of the point.
 */
export function insertionIndex(children: Rect[], p: Point, flow: Flow): number {
  for (let i = 0; i < children.length; i++) {
    const r = children[i]!;
    if (flow === 'column') {
      if (p.y < (r.top + r.bottom) / 2) return i;
    } else {
      if (p.y < r.top) return i;
      if (p.y <= r.bottom && p.x < (r.left + r.right) / 2) return i;
    }
  }
  return children.length;
}

/** Where to draw the insertion line for `index` among `children`. */
export function indicatorFor(children: Rect[], index: number, flow: Flow, container: Rect, emptyRect: Rect | null): Indicator {
  const T = 2;
  if (!children.length) {
    const r = emptyRect ?? container;
    return { kind: 'box', orientation: 'horizontal', rect: r };
  }
  const before = children[index - 1];
  const after = children[index];
  if (flow === 'column') {
    const left = Math.min(...children.map((c) => c.left));
    const right = Math.max(...children.map((c) => c.right));
    const y = before && after ? (before.bottom + after.top) / 2 : after ? after.top - 3 : before!.bottom + 3;
    return { kind: 'line', orientation: 'horizontal', rect: { left, right, top: y - T / 2, bottom: y + T / 2 } };
  }
  // Row flow: vertical line next to the neighbouring child on the same line.
  const ref = after ?? before!;
  const x = after && before && Math.abs(before.top - after.top) < 4 ? (before.right + after.left) / 2 : after ? after.left - 3 : before!.right + 3;
  return { kind: 'line', orientation: 'vertical', rect: { left: x - T / 2, right: x + T / 2, top: ref.top, bottom: ref.bottom } };
}

export interface ResolveOptions {
  /** Whether the slot accepts the dragged block type. */
  accepts: (slot: SlotGeom) => boolean;
  /** Id of the node being moved (its own subtree is not a valid target; it is skipped when indexing). */
  draggedId?: string | null;
  /** Edge band (px) near a container's top/bottom where we prefer inserting next to the container. */
  edge?: number;
}

/** Resolve the deepest accepting slot under the pointer and the insertion index within it. */
export function resolveDrop(slots: SlotGeom[], p: Point, opts: ResolveOptions): DropTarget | null {
  const dragged = opts.draggedId ?? null;
  const usable = slots.filter((s) => (!dragged || !s.ancestors.includes(dragged)) && opts.accepts(s));
  const hitArea = (s: SlotGeom) => s.emptyRect ?? s.parentRect;
  let hits = usable.filter((s) => contains(hitArea(s), p, s.emptyRect ? 4 : 0) || contains(s.parentRect, p));
  if (!hits.length) return null;

  // Near the top/bottom edge of a nested container, prefer the enclosing slot
  // so users can drop "between" big blocks instead of always inside them.
  const edgeOf = (s: SlotGeom) => Math.min(opts.edge ?? 14, rectH(s.parentRect) * 0.2);
  const minDepth = Math.min(...hits.map((h) => h.depth));
  const inEdge = (s: SlotGeom) => s.depth > minDepth && (p.y - s.parentRect.top < edgeOf(s) || s.parentRect.bottom - p.y < edgeOf(s));
  const shallowHits = hits.filter((s) => !inEdge(s));
  if (shallowHits.length) hits = shallowHits;

  const slotRect = (s: SlotGeom) => s.emptyRect ?? union(s.children.filter((c) => c.id !== dragged).map((c) => c.rect)) ?? s.parentRect;
  hits.sort((a, b) => b.depth - a.depth || distanceToRect(slotRect(a), p) - distanceToRect(slotRect(b), p));
  const best = hits[0]!;
  const kids = best.children.filter((c) => c.id !== dragged);
  const rects = kids.map((c) => c.rect);
  const index = insertionIndex(rects, p, best.flow);
  return {
    parentId: best.parentId,
    slot: best.slot,
    index,
    indicator: indicatorFor(rects, index, best.flow, best.parentRect, best.emptyRect),
  };
}

/**
 * Layers-panel drop zones: top quarter = before, bottom quarter = after,
 * middle = inside (when the row's block can contain the dragged block).
 */
export function layerDropZone(rowTop: number, rowHeight: number, y: number, canNest: boolean): 'before' | 'after' | 'inside' {
  const rel = (y - rowTop) / Math.max(1, rowHeight);
  if (canNest && rel > 0.25 && rel < 0.75) return 'inside';
  return rel < 0.5 ? 'before' : 'after';
}
