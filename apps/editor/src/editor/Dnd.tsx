import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { useRef, type ReactNode } from 'react';
import type { DocOp } from '../lib/commands.ts';
import { layerDropZone, resolveDrop, type Point } from '../lib/drop.ts';
import { createNode, firstAcceptingSlot, findNode, isInside, locateNode, slotAccepts } from '../lib/tree.ts';
import { useStore } from '../lib/store.ts';
import { blockIcon, Icon } from '../ui/Icon.tsx';
import { canvas } from './canvas.ts';
import { actions, editor, type DragInfo, type LayerDrop } from './state.ts';

/** Prefer layer rows when the pointer is over them; the canvas is one big droppable. */
const collision: CollisionDetection = (args) => {
  const hits = pointerWithin(args);
  const layer = hits.find((h) => String(h.id).startsWith('layer:'));
  return layer ? [layer] : hits;
};

/**
 * The real pointer position, tracked from window events. dnd-kit's `delta` also
 * folds in scrolling of the draggable's scroll containers (the Insert panel), so
 * activator + delta drifts as soon as anything scrolls — that broke every drop.
 */
const pointer: { x: number; y: number; known: boolean } = { x: 0, y: 0, known: false };
if (typeof window !== 'undefined') {
  const track = (e: PointerEvent | MouseEvent) => {
    pointer.x = e.clientX;
    pointer.y = e.clientY;
    pointer.known = true;
  };
  window.addEventListener('pointermove', track, { capture: true, passive: true });
  window.addEventListener('pointerdown', track, { capture: true, passive: true });
}

/** Clicks that follow a drag (pointerup over the source) must not insert a second block. */
let suppressClickUntil = 0;
export function clickSuppressed() {
  return Date.now() < suppressClickUntil;
}

function pointerOf(e: DragMoveEvent | DragEndEvent): Point | null {
  if (pointer.known) return { x: pointer.x, y: pointer.y };
  const ae = e.activatorEvent as PointerEvent | MouseEvent | null;
  if (!ae || typeof (ae as MouseEvent).clientX !== 'number') return null;
  return { x: (ae as MouseEvent).clientX + e.delta.x, y: (ae as MouseEvent).clientY + e.delta.y };
}

/** Compute the layers-panel drop for a pointer over a row. */
export function computeLayerDrop(drag: DragInfo, targetId: string, rowTop: number, rowHeight: number, y: number): LayerDrop {
  const s = editor.get();
  const target = findNode(s.tree, targetId);
  if (!target) return { targetId, position: 'after', valid: false };
  const canNest = !!firstAcceptingSlot(s.schemas, target, drag.type) && target.type !== 'core:page';
  const position = layerDropZone(rowTop, rowHeight, y, canNest);
  let valid = true;
  if (drag.kind === 'move' && drag.id && (drag.id === targetId || isInside(s.tree, targetId, drag.id))) valid = false;
  if (position !== 'inside') {
    const loc = locateNode(s.tree, targetId);
    valid = valid && !!loc && slotAccepts(s.schemas, loc.parent.type, loc.slot, drag.type);
  }
  return { targetId, position, valid };
}

/** Ops for a layers drop (index computed among siblings excluding the moved node, matching yMove). */
export function layerDropOps(drag: DragInfo, drop: LayerDrop): { ops: DocOp[]; select: string } | null {
  const s = editor.get();
  if (!drop.valid || !s.tree) return null;
  const target = findNode(s.tree, drop.targetId);
  if (!target) return null;
  let parentId: string;
  let slot: string;
  let index: number;
  if (drop.position === 'inside') {
    const sl = firstAcceptingSlot(s.schemas, target, drag.type);
    if (!sl) return null;
    parentId = target.id;
    slot = sl;
    index = (target.slots?.[sl] ?? []).filter((n) => n.id !== drag.id).length;
  } else {
    const loc = locateNode(s.tree, drop.targetId);
    if (!loc) return null;
    parentId = loc.parent.id;
    slot = loc.slot;
    const sibs = loc.siblings.filter((n) => n.id !== drag.id);
    index = sibs.findIndex((n) => n.id === drop.targetId) + (drop.position === 'after' ? 1 : 0);
  }
  if (drag.kind === 'move') return { ops: [{ op: 'move', id: drag.id!, parentId, slot, index }], select: drag.id! };
  const node = newNodeFor(drag);
  if (!node) return null;
  return { ops: [{ op: 'insert', node, parentId, slot, index }], select: node.id };
}

/** The node a "new" drag inserts: a palette block, a layout preset or a library item. */
export function newNodeFor(drag: DragInfo) {
  if (drag.make) return drag.make();
  const schema = editor.get().schemas.get(drag.type);
  return schema ? createNode(schema) : null;
}

export function EditorDnd({ children }: { children: ReactNode }) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const scrollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const dragging = useStore(editor, (s) => s.dragging);

  const stopAutoScroll = () => {
    if (scrollTimer.current) clearInterval(scrollTimer.current);
    scrollTimer.current = null;
  };

  const onStart = (e: DragStartEvent) => {
    const d = e.active.data.current as DragInfo | undefined;
    if (!d) return;
    editor.set({ dragging: d, drop: null, layerDrop: null, hoverId: null });
    canvas.setInteractive(false);
  };

  const onMove = (e: DragMoveEvent) => {
    const d = editor.get().dragging;
    const p = pointerOf(e);
    if (!d || !p) return;
    const overId = e.over ? String(e.over.id) : null;
    if (overId === 'canvas') {
      const ip = canvas.clientToIframe(p);
      const s = editor.get();
      const target = ip
        ? resolveDrop(canvas.snapshotSlots(), ip, {
            accepts: (g) => slotAccepts(s.schemas, g.parentType, g.slot, d.type),
            draggedId: d.kind === 'move' ? d.id : null,
          })
        : null;
      editor.set({ drop: target, layerDrop: null });
      // Auto-scroll the canvas near its top/bottom edge.
      const fr = canvas.iframeVisibleRect();
      const vp = canvas.viewport?.getBoundingClientRect();
      stopAutoScroll();
      if (fr && vp) {
        const top = Math.max(fr.top, vp.top);
        const bottom = Math.min(fr.bottom, vp.bottom);
        const dir = p.y < top + 48 ? -1 : p.y > bottom - 48 ? 1 : 0;
        if (dir) scrollTimer.current = setInterval(() => canvas.scrollBy(dir * 14), 16);
      }
    } else if (overId?.startsWith('layer:') && e.over) {
      stopAutoScroll();
      const r = e.over.rect;
      editor.set({ layerDrop: computeLayerDrop(d, overId.slice(6), r.top, r.height, p.y), drop: null });
    } else {
      stopAutoScroll();
      if (editor.get().drop || editor.get().layerDrop) editor.set({ drop: null, layerDrop: null });
    }
  };

  const finish = () => {
    suppressClickUntil = Date.now() + 400;
    stopAutoScroll();
    canvas.setInteractive(true);
    editor.set({ dragging: null, drop: null, layerDrop: null });
  };

  const onEnd = (_e: DragEndEvent) => {
    const s = editor.get();
    const d = s.dragging;
    const drop = s.drop;
    const layerDrop = s.layerDrop;
    finish();
    if (!d) return;
    if (drop) {
      if (d.kind === 'move' && d.id) {
        actions.apply([{ op: 'move', id: d.id, parentId: drop.parentId, slot: drop.slot, index: drop.index }], d.id);
      } else {
        const node = newNodeFor(d);
        if (!node) return;
        actions.apply([{ op: 'insert', node, parentId: drop.parentId, slot: drop.slot, index: drop.index }], node.id);
      }
    } else if (layerDrop) {
      const res = layerDropOps(d, layerDrop);
      if (res) actions.apply(res.ops, res.select);
    }
  };

  return (
    <DndContext sensors={sensors} collisionDetection={collision} onDragStart={onStart} onDragMove={onMove} onDragEnd={onEnd} onDragCancel={finish} autoScroll={false}>
      {children}
      <DragOverlay dropAnimation={null}>
        {dragging ? (
          <div className="drag-chip">
            <Icon name={blockIcon(editor.get().schemas.get(dragging.type)?.icon, editor.get().schemas.get(dragging.type)?.category)} size={15} />
            {dragging.label}
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
