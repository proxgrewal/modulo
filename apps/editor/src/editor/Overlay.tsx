import { useDraggable } from '@dnd-kit/core';
import { memo, useEffect, useReducer } from 'react';
import type { Rect } from '../lib/drop.ts';
import { shallowEqual, useStore } from '../lib/store.ts';
import { findNode, INSTANCE_TYPE, locateNode, PAGE_ROOT } from '../lib/tree.ts';
import { Icon } from '../ui/Icon.tsx';
import { canvas } from './canvas.ts';
import { actions, editor } from './state.ts';

function useGeometryTick() {
  const [, tick] = useReducer((x: number) => x + 1, 0);
  useEffect(() => canvas.subscribe(tick), []);
}

function Box({ r, className, color, children }: { r: Rect; className: string; color?: string; children?: React.ReactNode }) {
  return (
    <div className={className} style={{ left: r.left, top: r.top, width: Math.max(0, r.right - r.left), height: Math.max(0, r.bottom - r.top), ...(color ? ({ '--peer': color } as React.CSSProperties) : null) }}>
      {children}
    </div>
  );
}

/** Hover / selection / presence outlines and the drop indicator, drawn over the iframe. */
export function Overlay() {
  useGeometryTick();
  // `tree` is selected so outlines refresh when the document changes.
  const { hoverId, selection, peers, drop, dragging } = useStore(
    editor,
    (s) => ({ hoverId: s.hoverId, selection: s.selection, peers: s.peers, drop: s.drop, dragging: s.dragging, tree: s.tree }),
    shallowEqual,
  );
  const schemas = useStore(editor, (s) => s.schemas);
  useStore(editor, (s) => s.library);
  const isInstance = (id: string | null | undefined) => !!id && findNode(editor.get().tree, id)?.type === INSTANCE_TYPE;
  const labelOf = (id: string) => {
    const s = editor.get();
    const n = canvas.isLayoutNode(id) ? findNode(s.layout?.tree ?? null, id) : findNode(s.tree, id);
    if (n?.type === INSTANCE_TYPE) return `◇ ${s.library?.find((c) => c.id === n.props.component)?.name ?? 'Synced component'}`;
    return n?.name || (schemas.get(n?.type ?? '')?.label ?? n?.type ?? 'Block');
  };
  const vp = canvas.viewport;
  const bounds = vp ? { w: vp.clientWidth, h: vp.clientHeight } : { w: 0, h: 0 };
  const clip = (r: Rect | null) => (r && r.bottom > 0 && r.top < bounds.h ? r : null);

  const hoverRect = !dragging && hoverId && hoverId !== selection?.id ? clip(canvas.rectOf(hoverId)) : null;
  const selRect = selection ? clip(canvas.rectOf(selection.id)) : null;
  const dropRect = drop ? canvas.toViewport(drop.indicator.rect) : null;

  return (
    <div className="overlay" aria-hidden={false}>
      {peers.map((p) => {
        const r = p.selection ? clip(canvas.rectOf(p.selection)) : null;
        return r ? (
          <Box key={p.clientId} r={r} className="ov-peer" color={p.color}>
            <span className="ov-peer-tag">{p.name}</span>
          </Box>
        ) : null;
      })}
      {hoverRect && (
        <Box r={hoverRect} className={`ov-hover${canvas.isLayoutNode(hoverId!) ? ' layout' : ''}${isInstance(hoverId) ? ' instance' : ''}`}>
          <span className="ov-tag">{labelOf(hoverId!)}</span>
        </Box>
      )}
      {selRect && selection && (
        <Box r={selRect} className={`ov-select${selection.mode === 'layout' ? ' layout' : ''}${isInstance(selection.id) ? ' instance' : ''}${dragging ? ' faded' : ''}`}>
          {!dragging && <SelectionToolbar id={selection.id} mode={selection.mode} rect={selRect} label={labelOf(selection.id)} />}
        </Box>
      )}
      {dropRect && drop && (
        <div
          className={`ov-drop ${drop.indicator.kind} ${drop.indicator.orientation}`}
          style={{ left: dropRect.left, top: dropRect.top, width: Math.max(2, dropRect.right - dropRect.left), height: Math.max(2, dropRect.bottom - dropRect.top) }}
        />
      )}
    </div>
  );
}

const SelectionToolbar = memo(function SelectionToolbar({ id, mode, rect, label }: { id: string; mode: 'page' | 'layout'; rect: Rect; label: string }) {
  const node = useStore(editor, (s) => (mode === 'page' ? findNode(s.tree, id) : null));
  const canEdit = useStore(editor, (s) => s.canEdit);
  const { attributes, listeners, setNodeRef } = useDraggable({ id: `move:${id}`, data: { kind: 'move', id, type: node?.type ?? '', label }, disabled: mode !== 'page' || !node || !!node.locked || !canEdit });
  const below = rect.top < 34;
  if (mode === 'layout') {
    return (
      <div className={`ov-toolbar${below ? ' below' : ''}`} role="toolbar" aria-label={`${label} (site layout)`}>
        <span className="ov-toolbar-label">
          <Icon name="layout" size={13} /> {label} · Layout
        </span>
        <button className="ov-btn" title="Edit header & footer" aria-label="Open layout panel" onClick={() => editor.set({ leftTab: 'layout' })}>
          <Icon name="settings" size={14} />
        </button>
      </div>
    );
  }
  const tree = editor.get().tree;
  const loc = locateNode(tree, id);
  const locked = !!node?.locked;
  const unpackable = !!node && !!editor.get().schemas.get(node.type)?.unpackable;
  return (
    <div className={`ov-toolbar${below ? ' below' : ''}`} role="toolbar" aria-label={`${label} actions`}>
      <button ref={setNodeRef} className="ov-btn grab" aria-label={`Drag ${label}`} title="Drag to move" {...listeners} {...attributes}>
        <Icon name="grip" size={14} />
      </button>
      <span className="ov-toolbar-label">
        {locked && <Icon name="lock" size={12} />} {label}
      </span>
      <button className="ov-btn" title="Move up (Alt+↑)" aria-label="Move up" disabled={!canEdit || locked || !loc || loc.index === 0} onClick={() => actions.run('moveUp')}>
        <Icon name="arrow-up" size={14} />
      </button>
      <button className="ov-btn" title="Move down (Alt+↓)" aria-label="Move down" disabled={!canEdit || locked || !loc || loc.index >= loc.siblings.length - 1} onClick={() => actions.run('moveDown')}>
        <Icon name="arrow-down" size={14} />
      </button>
      <button className="ov-btn" title="Select parent (Esc)" aria-label="Select parent" disabled={!loc || loc.parent.id === PAGE_ROOT} onClick={() => actions.run('selectParent')}>
        <Icon name="parent" size={14} />
      </button>
      {unpackable && (
        <button className="ov-btn" title="Unpack into editable parts" aria-label="Unpack into editable parts" disabled={!canEdit || locked} onClick={() => actions.unpack(id)}>
          <Icon name="unpack" size={14} />
        </button>
      )}
      <button className="ov-btn" title="Duplicate (Ctrl+D)" aria-label="Duplicate" disabled={!canEdit} onClick={() => actions.run('duplicate')}>
        <Icon name="copy" size={14} />
      </button>
      <button className="ov-btn danger" title="Delete (Del)" aria-label="Delete" disabled={!canEdit || locked} onClick={() => actions.run('delete')}>
        <Icon name="trash" size={14} />
      </button>
    </div>
  );
});
