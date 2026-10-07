import { useDraggable } from '@dnd-kit/core';
import { memo, useMemo, useState } from 'react';
import { insertAfterSelection } from '../../lib/commands.ts';
import { useStore } from '../../lib/store.ts';
import { createNode, instantiateTemplate } from '../../lib/tree.ts';
import type { BlockSchema, LayoutPreset } from '../../types.ts';
import { Empty } from '../../ui/controls.tsx';
import { blockIcon, Icon } from '../../ui/Icon.tsx';
import { actions, editor } from '../state.ts';
import { clickSuppressed } from '../Dnd.tsx';

const CATEGORY_ORDER = ['Sections', 'Layout', 'Text', 'Basic', 'Media'];

export function insertBlock(type: string) {
  const s = editor.get();
  const schema = s.schemas.get(type);
  if (!schema || !s.tree) return;
  const node = createNode(schema);
  const sel = s.selection?.mode === 'page' ? s.selection.id : null;
  actions.apply(insertAfterSelection(s.tree, sel, [node], s.schemas), node.id);
}

/** Insert a module layout preset (fresh ids) after the selection. */
export function insertPreset(p: LayoutPreset) {
  const s = editor.get();
  if (!s.tree) return;
  const node = instantiateTemplate(p.node, 'user', s.schemas);
  const sel = s.selection?.mode === 'page' ? s.selection.id : null;
  actions.apply(insertAfterSelection(s.tree, sel, [node], s.schemas), node.id);
}

const PresetItem = memo(function PresetItem({ p, disabled }: { p: LayoutPreset; disabled: boolean }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `preset:${p.id}`,
    data: { kind: 'new', type: p.node.type, label: p.label, make: () => instantiateTemplate(p.node, 'user', editor.get().schemas) },
    disabled,
  });
  return (
    <li>
      <button
        ref={setNodeRef}
        className={`palette-item preset${isDragging ? ' dragging' : ''}`}
        {...listeners}
        {...attributes}
        disabled={disabled}
        data-preset-id={p.id}
        aria-label={`Insert ${p.label}${p.description ? ': ' + p.description : ''}`}
        title={p.description ?? `Insert ${p.label}`}
        onClick={() => {
          if (!clickSuppressed()) insertPreset(p);
        }}
      >
        <span className="palette-icon">
          <Icon name={blockIcon(p.icon, p.category === 'Sections' ? 'Sections' : 'Layout')} size={18} />
        </span>
        <span className="palette-text">
          <span className="palette-label">{p.label}</span>
          {p.description && <span className="palette-desc">{p.description}</span>}
        </span>
      </button>
    </li>
  );
});

const PaletteItem = memo(function PaletteItem({ b, moduleLabel, disabled }: { b: BlockSchema; moduleLabel?: string }& { disabled: boolean }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: `new:${b.type}`, data: { kind: 'new', type: b.type, label: b.label }, disabled });
  return (
    <li>
      <button
        ref={setNodeRef}
        className={`palette-item${isDragging ? ' dragging' : ''}`}
        {...listeners}
        {...attributes}
        disabled={disabled}
        aria-label={`Insert ${b.label}${b.description ? ': ' + b.description : ''}`}
        aria-describedby={undefined}
        onClick={() => {
          if (!clickSuppressed()) insertBlock(b.type);
        }}
        title={b.description ?? `Insert ${b.label}`}
      >
        <span className="palette-icon">
          <Icon name={blockIcon(b.icon, b.category)} size={18} />
        </span>
        <span className="palette-text">
          <span className="palette-label">
            {b.label}
            {moduleLabel && <span className="mini-badge">{moduleLabel}</span>}
          </span>
          {b.description && <span className="palette-desc">{b.description}</span>}
        </span>
      </button>
    </li>
  );
});

export function InsertPanel() {
  const blocks = useStore(editor, (s) => s.runtime?.blocks ?? []);
  const presets = useStore(editor, (s) => s.runtime?.presets ?? []);
  const modules = useStore(editor, (s) => s.runtime?.modules ?? []);
  const canEdit = useStore(editor, (s) => s.canEdit && !!s.tree);
  const hasSel = useStore(editor, (s) => s.selection?.mode === 'page');
  const [q, setQ] = useState('');
  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = blocks.filter((b) => !b.internal && b.type !== 'core:page' && (!needle || `${b.label} ${b.description ?? ''} ${b.type} ${b.category ?? ''}`.toLowerCase().includes(needle)));
    const by = new Map<string, BlockSchema[]>();
    for (const b of list) {
      const c = b.category ?? 'Other';
      by.set(c, [...(by.get(c) ?? []), b]);
    }
    return [...by.entries()].sort((a, b) => {
      const ia = CATEGORY_ORDER.indexOf(a[0]);
      const ib = CATEGORY_ORDER.indexOf(b[0]);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a[0].localeCompare(b[0]);
    });
  }, [blocks, q]);
  const presetList = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return presets.filter((p) => !needle || `${p.label} ${p.description ?? ''} ${p.category ?? ''}`.toLowerCase().includes(needle));
  }, [presets, q]);
  const modLabel = (name: string) => (name === 'core' ? undefined : modules.find((m) => m.name === name)?.label ?? name);
  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Insert</h2>
        <p className="muted small">{hasSel ? 'Click to add after the selection, or drag onto the page.' : 'Click to add to the page, or drag onto the canvas.'}</p>
        <div className="search-box">
          <Icon name="search" size={15} />
          <input
            id="insert-search"
            className="input"
            type="search"
            placeholder="Search blocks  ( / )"
            aria-label="Search blocks"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && groups[0]?.[1][0]) {
                insertBlock(groups[0][1][0].type);
                setQ('');
              }
              if (e.key === 'Escape') {
                setQ('');
                (e.target as HTMLInputElement).blur();
              }
            }}
          />
        </div>
      </div>
      <div className="panel-body">
        {groups.length === 0 && presetList.length === 0 && <Empty>No blocks match “{q}”.</Empty>}
        {presetList.length > 0 && (
          <section className="palette-group" aria-label="Layouts & sections">
            <h3>Layouts &amp; sections</h3>
            <ul className="palette">
              {presetList.map((p) => (
                <PresetItem key={p.id} p={p} disabled={!canEdit} />
              ))}
            </ul>
          </section>
        )}
        {groups.map(([cat, list]) => (
          <section key={cat} className="palette-group" aria-label={cat}>
            <h3>{cat}</h3>
            <ul className="palette">
              {list.map((b) => (
                <PaletteItem key={b.type} b={b} moduleLabel={modLabel(b.module)} disabled={!canEdit} />
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
