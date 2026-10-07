import { useDraggable, useDroppable } from '@dnd-kit/core';
import { memo, useCallback, useMemo, useState } from 'react';
import type { PageNode } from '@modulo/core';
import { useStore } from '../../lib/store.ts';
import { flattenTree, INSTANCE_TYPE, nodeSnippet, pathTo, type FlatNode } from '../../lib/tree.ts';
import { Empty } from '../../ui/controls.tsx';
import { blockIcon, Icon } from '../../ui/Icon.tsx';
import { actions, editor } from '../state.ts';

const LayerRow = memo(function LayerRow({ item, selected, tabbable, collapsed, onToggle, peerColor }: { item: FlatNode; selected: boolean; tabbable: boolean; collapsed: boolean; onToggle: (id: string) => void; peerColor?: string }) {
  const { node, depth, hasChildren } = item;
  const schema = useStore(editor, (s) => s.schemas.get(node.type));
  const modules = useStore(editor, (s) => s.runtime?.modules);
  const canEdit = useStore(editor, (s) => s.canEdit);
  const drop = useStore(editor, (s) => (s.layerDrop?.targetId === node.id ? s.layerDrop : null));
  const isInstance = node.type === INSTANCE_TYPE;
  const compName = useStore(editor, (s) => (isInstance ? (s.library?.find((c) => c.id === node.props.component)?.name ?? null) : null));
  const presetLabels = useStore(editor, (s) => (node.presets ?? []).map((n) => s.runtime?.stylePresets?.[n]?.label ?? n).join(', '));
  const [renaming, setRenaming] = useState(false);
  const typeLabel = schema?.label ?? node.type;
  const label = node.name || (isInstance ? (compName ?? 'Synced component') : typeLabel);
  const drag = useDraggable({ id: `layer-drag:${node.id}`, data: { kind: 'move', id: node.id, type: node.type, label }, disabled: !canEdit || !!node.locked });
  const dropZone = useDroppable({ id: `layer:${node.id}` });
  const setRef = useCallback(
    (el: HTMLElement | null) => {
      drag.setNodeRef(el);
      dropZone.setNodeRef(el);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [drag.setNodeRef, dropZone.setNodeRef],
  );
  const mod = schema?.module && schema.module !== 'core' ? (modules?.find((m) => m.name === schema.module)?.label ?? schema.module) : null;
  const snippet = nodeSnippet(node);
  return (
    <li
      role="treeitem"
      aria-level={depth + 1}
      aria-selected={selected}
      aria-expanded={hasChildren ? !collapsed : undefined}
      className={`layer${selected ? ' selected' : ''}${drag.isDragging ? ' dragging' : ''}${drop ? ` drop-${drop.position}${drop.valid ? '' : ' invalid'}` : ''}`}
      style={{ ['--depth' as any]: depth, ...(peerColor ? { ['--peer' as any]: peerColor } : null) }}
    >
      <div ref={setRef} className="layer-row" {...drag.attributes} {...drag.listeners} tabIndex={-1} role="presentation">
        {hasChildren ? (
          <button className="layer-caret" aria-label={collapsed ? `Expand ${label}` : `Collapse ${label}`} tabIndex={-1} onClick={() => onToggle(node.id)} onPointerDown={(e) => e.stopPropagation()}>
            <Icon name={collapsed ? 'chevron-right' : 'chevron-down'} size={13} />
          </button>
        ) : (
          <span className="layer-caret" />
        )}
        {renaming ? (
          <input
            className="input sm layer-rename"
            autoFocus
            defaultValue={node.name ?? ''}
            placeholder={typeLabel}
            aria-label={`Rename ${label}`}
            onPointerDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              if (e.key === 'Escape') setRenaming(false);
            }}
            onBlur={(e) => {
              if (renaming) actions.setField(node.id, 'name', e.target.value.trim().slice(0, 80));
              setRenaming(false);
            }}
          />
        ) : (
        <button
          className={`layer-main${isInstance ? ' instance' : ''}`}
          data-layer-id={node.id}
          tabIndex={tabbable ? 0 : -1}
          onClick={() => actions.selectPage(node.id)}
          onDoubleClick={() => canEdit && setRenaming(true)}
          onKeyDown={(e) => {
            if (e.key === 'F2' && canEdit) {
              e.preventDefault();
              e.stopPropagation();
              setRenaming(true);
            }
          }}
          title={`${label}${node.name ? ` (${typeLabel})` : ''} · double-click to rename`}
          onMouseEnter={() => actions.hover(node.id)}
          onMouseLeave={() => actions.hover(null)}
        >
          <Icon name={isInstance ? 'sync' : blockIcon(schema?.icon, schema?.category)} size={14} />
          <span className="layer-label">{label}</span>
          {snippet && !node.name && <span className="layer-snippet">{snippet}</span>}
          {isInstance && <span className="mini-badge synced" title="Synced library component">synced</span>}
          {presetLabels && <span className="mini-badge preset" title={`Style presets: ${presetLabels}`}>{presetLabels.length > 14 ? presetLabels.slice(0, 13) + '…' : presetLabels}</span>}
          {node.locked && <Icon name="lock" size={12} title="Locked" />}
          {mod && <span className="mini-badge" title={`From the ${mod} module`}>{mod}</span>}
          {node.origin && node.origin !== 'user' && node.origin !== 'pages' && !mod && <span className="mini-badge muted">{node.origin}</span>}
          {peerColor && <span className="peer-dot" style={{ background: peerColor }} aria-label="Selected by a collaborator" />}
        </button>
        )}
      </div>
    </li>
  );
});

export function LayersPanel() {
  const tree = useStore(editor, (s) => s.tree);
  const selId = useStore(editor, (s) => (s.selection?.mode === 'page' ? s.selection.id : null));
  const peers = useStore(editor, (s) => s.peers);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggle = useCallback((id: string) => setCollapsed((c) => {
    const n = new Set(c);
    n.has(id) ? n.delete(id) : n.add(id);
    return n;
  }), []);
  // Always reveal the selected node.
  const effectiveCollapsed = useMemo(() => {
    if (!selId || !tree) return collapsed;
    const path = pathTo(tree, selId);
    if (!path.some((p) => collapsed.has(p) && p !== selId)) return collapsed;
    const n = new Set(collapsed);
    for (const p of path) if (p !== selId) n.delete(p);
    return n;
  }, [collapsed, selId, tree]);
  const items = useMemo(() => (tree ? flattenTree(tree, effectiveCollapsed) : []), [tree, effectiveCollapsed]);
  const peerBy = useMemo(() => new Map(peers.filter((p) => p.selection).map((p) => [p.selection!, p.color])), [peers]);

  const onKey = (e: React.KeyboardEvent) => {
    const idx = items.findIndex((i) => i.node.id === selId);
    const focus = (id: string) => {
      actions.selectPage(id);
      requestAnimationFrame(() => (document.querySelector(`[data-layer-id="${CSS.escape(id)}"]`) as HTMLElement | null)?.focus());
    };
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const n = items[Math.min(items.length - 1, idx + 1)];
      if (n) focus(n.node.id);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const n = items[Math.max(0, idx - 1)];
      if (n) focus(n.node.id);
    } else if (e.key === 'ArrowLeft' && selId) {
      e.preventDefault();
      const it = items[idx];
      if (it?.hasChildren && !collapsed.has(selId)) toggle(selId);
      else if (it?.parentId && it.parentId !== tree?.id) focus(it.parentId);
    } else if (e.key === 'ArrowRight' && selId) {
      e.preventDefault();
      if (collapsed.has(selId)) toggle(selId);
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      actions.run('delete');
    }
  };

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Layers</h2>
        <p className="muted small">Drag to reorder or nest. Use arrow keys to move through the tree.</p>
        <div className="row-btns">
          <button className="btn sm ghost" onClick={() => setCollapsed(new Set())}>
            Expand all
          </button>
          <button
            className="btn sm ghost"
            onClick={() => {
              const all = new Set<string>();
              const rec = (n: PageNode) => {
                if (Object.values(n.slots ?? {}).flat().length) all.add(n.id);
                Object.values(n.slots ?? {}).flat().forEach(rec);
              };
              (tree?.slots?.default ?? []).forEach(rec);
              setCollapsed(all);
            }}
          >
            Collapse all
          </button>
        </div>
      </div>
      <div className="panel-body">
        {!tree ? null : items.length === 0 ? (
          <Empty>This page is empty. Add blocks from the Insert panel.</Empty>
        ) : (
          <ul className="layers" role="tree" aria-label="Page layers" onKeyDown={onKey}>
            {items.map((it, i) => (
              <LayerRow key={it.node.id} item={it} selected={it.node.id === selId} tabbable={it.node.id === selId || (!selId && i === 0)} collapsed={effectiveCollapsed.has(it.node.id)} onToggle={toggle} peerColor={peerBy.get(it.node.id)} />
            ))}
          </ul>
        )}
        <p className="muted small pad">Header and footer belong to the site layout — edit them in the Layout panel.</p>
      </div>
    </div>
  );
}
