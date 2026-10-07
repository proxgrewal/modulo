import { useEffect, useMemo, useState } from 'react';
import type { PageNode } from '@modulo/core';
import { errorMessage } from '../../api.ts';
import { insertAfterSelection } from '../../lib/commands.ts';
import { shallowEqual, useStore } from '../../lib/store.ts';
import { copyOfComponent, findNode, instanceNode, INSTANCE_TYPE } from '../../lib/tree.ts';
import type { LibraryComponent } from '../../types.ts';
import { Empty, Row, Spinner, useUid } from '../../ui/controls.tsx';
import { Dialog } from '../../ui/Dialog.tsx';
import { blockIcon, Icon } from '../../ui/Icon.tsx';
import { toast } from '../../ui/toast.ts';
import { actions, editor, rememberDetached } from '../state.ts';

/* ───────── insert helpers ───────── */

function insertNode(node: PageNode) {
  const s = editor.get();
  if (!s.tree) return;
  const sel = s.selection?.mode === 'page' ? s.selection.id : null;
  actions.apply(insertAfterSelection(s.tree, sel, [node], s.schemas), node.id);
}

export function insertComponentCopy(c: LibraryComponent) {
  const copy = copyOfComponent(c.node);
  if (!copy.name) copy.name = c.name;
  insertNode(copy);
  rememberDetached(copy.id, c.id);
}

export function insertComponentInstance(c: LibraryComponent) {
  insertNode(instanceNode(c.id));
}

/** The selected page node, if any. */
function useSelectedNode() {
  return useStore(editor, (s) => (s.selection?.mode === 'page' ? findNode(s.tree, s.selection.id) : null));
}

/* ───────── save / edit dialog ───────── */

function ComponentDialog({ title, initial, categories, onSave, onClose }: { title: string; initial: { name: string; category: string; description: string }; categories: string[]; onSave: (v: { name: string; category: string; description: string }) => Promise<void>; onClose: () => void }) {
  const [v, setV] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const uid = useUid('cmp');
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!v.name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await onSave({ name: v.name.trim(), category: v.category.trim() || 'General', description: v.description.trim() });
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title={title} onClose={onClose}>
      <form className="form-stack" onSubmit={submit}>
        <Row label="Name" htmlFor={`${uid}-n`}>
          <input id={`${uid}-n`} className="input" autoFocus value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} placeholder="e.g. Promo banner" />
        </Row>
        <Row label="Category" htmlFor={`${uid}-c`}>
          <input id={`${uid}-c`} className="input" list={`${uid}-cats`} value={v.category} onChange={(e) => setV({ ...v, category: e.target.value })} placeholder="General" />
          <datalist id={`${uid}-cats`}>
            {categories.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </Row>
        <Row label="Description" htmlFor={`${uid}-d`}>
          <textarea id={`${uid}-d`} className="input" rows={2} value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} />
        </Row>
        {error && <p className="form-error">{error}</p>}
        <div className="row-btns">
          <button className="btn primary" disabled={busy || !v.name.trim()}>
            {busy ? 'Saving…' : 'Save'}
          </button>
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/* ───────── the panel ───────── */

export function LibraryPanel() {
  const { library, canEdit, hasTree } = useStore(editor, (s) => ({ library: s.library, canEdit: s.canEdit, hasTree: !!s.tree }), shallowEqual);
  const selected = useSelectedNode();
  const schemas = useStore(editor, (s) => s.schemas);
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<null | { mode: 'create' } | { mode: 'edit'; c: LibraryComponent }>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  useEffect(() => {
    actions.loadLibrary().catch((e) => setError(errorMessage(e)));
  }, []);
  const categories = useMemo(() => [...new Set((library ?? []).map((c) => c.category || 'General'))].sort(), [library]);
  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = (library ?? []).filter((c) => (!cat || (c.category || 'General') === cat) && (!needle || `${c.name} ${c.description ?? ''} ${c.category}`.toLowerCase().includes(needle)));
    const by = new Map<string, LibraryComponent[]>();
    for (const c of list) by.set(c.category || 'General', [...(by.get(c.category || 'General') ?? []), c]);
    return [...by.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [library, q, cat]);
  const selectedIsInstance = selected?.type === INSTANCE_TYPE;
  const canSave = canEdit && !!selected && !selectedIsInstance;

  const updateFromSelection = async (c: LibraryComponent) => {
    if (!selected || selectedIsInstance) return;
    try {
      await actions.updateComponent(c.id, { node: structuredClone(selected) });
      toast.success(`“${c.name}” updated: synced instances now show the new version`);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  return (
    <div className="panel library-panel">
      <div className="panel-head">
        <div className="panel-title-row">
          <h2>Library</h2>
          <button className="icon-btn sm" aria-label="Reload library" title="Reload" onClick={() => actions.loadLibrary(true).catch((e) => setError(errorMessage(e)))}>
            <Icon name="refresh" size={14} />
          </button>
        </div>
        <p className="muted small">Reusable components. Insert a copy, or a synced instance that updates everywhere when the component changes.</p>
        <button className="btn sm primary block" disabled={!canSave} title={selectedIsInstance ? 'Select regular blocks (not a synced instance)' : selected ? 'Save the selected block and everything inside it' : 'Select a block on the canvas first'} onClick={() => setDialog({ mode: 'create' })}>
          <Icon name="plus" size={13} /> Save selection as component
        </button>
        <div className="search-box">
          <Icon name="search" size={15} />
          <input className="input" type="search" placeholder="Search components" aria-label="Search components" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        {categories.length > 1 && (
          <select className="input sm" aria-label="Filter by category" value={cat} onChange={(e) => setCat(e.target.value)}>
            <option value="">All categories</option>
            {categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        )}
      </div>
      <div className="panel-body">
        {error && <p className="form-error">{error}</p>}
        {!library && !error && <Spinner label="Loading library" />}
        {library && library.length === 0 && <Empty>No components yet. Select a block and choose “Save selection as component”.</Empty>}
        {library && library.length > 0 && groups.length === 0 && <Empty>No components match.</Empty>}
        {groups.map(([category, list]) => (
          <section key={category} className="palette-group" aria-label={category}>
            <h3>{category}</h3>
            <ul className="lib-list">
              {list.map((c) => {
                const rootSchema = schemas.get(c.node?.type);
                return (
                  <li key={c.id} className="lib-item" data-component-id={c.id}>
                    <div className="lib-head">
                      <span className="palette-icon">
                        <Icon name={blockIcon(rootSchema?.icon, rootSchema?.category)} size={16} />
                      </span>
                      <div className="lib-text">
                        <strong className="lib-name">{c.name}</strong>
                        {c.description && <span className="palette-desc">{c.description}</span>}
                      </div>
                    </div>
                    <div className="lib-actions">
                      <button className="btn sm" disabled={!canEdit || !hasTree} onClick={() => insertComponentCopy(c)} title="Insert an independent copy you can edit freely">
                        <Icon name="copy" size={12} /> Insert copy
                      </button>
                      <button className="btn sm" disabled={!canEdit || !hasTree} onClick={() => insertComponentInstance(c)} title="Insert a synced instance: it follows changes to the component">
                        <Icon name="sync" size={12} /> Insert synced
                      </button>
                      <details className="menu">
                        <summary className="icon-btn sm" aria-label={`More actions for ${c.name}`}>
                          <Icon name="dots" size={14} />
                        </summary>
                        <div className="menu-pop right" role="menu">
                          <button role="menuitem" onClick={() => setDialog({ mode: 'edit', c })}>
                            <Icon name="edit" size={13} /> Rename / category
                          </button>
                          <button role="menuitem" disabled={!selected || selectedIsInstance} onClick={() => updateFromSelection(c)}>
                            <Icon name="upload" size={13} /> Update from selection
                          </button>
                          <button role="menuitem" className="danger" onClick={() => setConfirmDelete(c.id)}>
                            <Icon name="trash" size={13} /> Delete
                          </button>
                        </div>
                      </details>
                    </div>
                    {confirmDelete === c.id && (
                      <div className="lib-confirm" role="alert">
                        <span>Delete “{c.name}”? Synced instances will render empty.</span>
                        <button
                          className="btn sm danger"
                          onClick={async () => {
                            setConfirmDelete(null);
                            try {
                              await actions.deleteComponent(c.id);
                              toast.info(`Deleted “${c.name}”`);
                            } catch (e) {
                              toast.error(errorMessage(e));
                            }
                          }}
                        >
                          Delete
                        </button>
                        <button className="btn sm ghost" onClick={() => setConfirmDelete(null)}>
                          Keep
                        </button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
      {dialog?.mode === 'create' && selected && (
        <ComponentDialog
          title="Save as component"
          initial={{ name: selected.name || (schemas.get(selected.type)?.label ?? 'Component'), category: cat || 'General', description: '' }}
          categories={categories}
          onClose={() => setDialog(null)}
          onSave={async (v) => {
            const rec = await actions.createComponent({ ...v, node: structuredClone(selected) });
            rememberDetached(selected.id, rec.id);
            toast.success(`Saved “${rec.name}” to the library`);
          }}
        />
      )}
      {dialog?.mode === 'edit' && (
        <ComponentDialog
          title="Edit component"
          initial={{ name: dialog.c.name, category: dialog.c.category || 'General', description: dialog.c.description ?? '' }}
          categories={categories}
          onClose={() => setDialog(null)}
          onSave={async (v) => {
            await actions.updateComponent(dialog.c.id, v);
          }}
        />
      )}
    </div>
  );
}

/* ───────── inspector notes ───────── */

function useComponent(id: string | undefined) {
  const library = useStore(editor, (s) => s.library);
  useEffect(() => {
    if (!library) actions.loadLibrary().catch(() => {});
  }, [library]);
  return id ? (library?.find((c) => c.id === id) ?? null) : null;
}

/** Inspector header for a synced instance. */
export function InstanceNote({ node, disabled }: { node: PageNode; disabled: boolean }) {
  const comp = useComponent(String(node.props.component ?? '') || undefined);
  const library = useStore(editor, (s) => s.library);
  const detach = () => {
    if (!comp) return;
    const copy = copyOfComponent(comp.node);
    if (!copy.name) copy.name = comp.name;
    // The instance's own styling (on its wrapper) carries over onto the copy's root.
    if (node.style) copy.style = { ...(copy.style ?? {}), ...node.style };
    if (actions.replaceNode(node.id, copy)) {
      rememberDetached(copy.id, comp.id);
      toast.success('Detached: this is now an independent copy');
    }
  };
  return (
    <div className="instance-note" role="note">
      <div className="in-title">
        <Icon name="sync" size={14} />
        <span>
          Synced component: <strong>{comp?.name ?? (node.props.component ? 'Loading…' : 'none chosen')}</strong>
        </span>
      </div>
      <select className="input sm" aria-label="Component" disabled={disabled || !library} value={String(node.props.component ?? '')} onChange={(e) => actions.setProps(node.id, { component: e.target.value })}>
        {!node.props.component && <option value="">Choose a component…</option>}
        {!!node.props.component && !comp && <option value={String(node.props.component)}>{library ? 'Missing component' : 'Loading…'}</option>}
        {(library ?? []).map((c) => (
          <option key={c.id} value={c.id}>
            {c.name} · {c.category || 'General'}
          </option>
        ))}
      </select>
      <p className="muted small">Its content comes from the library. Detach to edit a copy, then update the component from it to change every instance.</p>
      <div className="row-btns">
        <button className="btn sm" disabled={disabled || !comp} onClick={detach}>
          <Icon name="unlink" size={12} /> Detach
        </button>
        <button className="btn sm ghost" onClick={() => editor.set({ leftTab: 'library' })}>
          <Icon name="library" size={12} /> Open library
        </button>
      </div>
    </div>
  );
}

/** Inspector note for a node that is a (detached) copy of a library component. */
export function DetachedNote({ node, disabled }: { node: PageNode; disabled: boolean }) {
  const compId = useStore(editor, (s) => s.detached[node.id]);
  const comp = useComponent(compId);
  const [busy, setBusy] = useState(false);
  if (!compId || !comp) return null;
  const update = async () => {
    setBusy(true);
    try {
      await actions.updateComponent(comp.id, { node: structuredClone(node) });
      toast.success(`“${comp.name}” updated from this copy`);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const relink = () => {
    const inst = instanceNode(comp.id);
    if (actions.replaceNode(node.id, inst)) rememberDetached(node.id, null);
  };
  return (
    <div className="instance-note detached" role="note">
      <div className="in-title">
        <Icon name="component" size={14} />
        <span>
          Copy of component <strong>{comp.name}</strong>
        </span>
      </div>
      <div className="row-btns">
        <button className="btn sm" disabled={disabled || busy} onClick={update}>
          <Icon name="upload" size={12} /> Update component from this copy
        </button>
        <button className="btn sm ghost" disabled={disabled} onClick={relink} title="Replace this copy with a synced instance">
          <Icon name="sync" size={12} /> Re-link
        </button>
        <button className="icon-btn sm" title="Forget the link to the component" aria-label="Forget link" onClick={() => rememberDetached(node.id, null)}>
          <Icon name="x" size={12} />
        </button>
      </div>
    </div>
  );
}
