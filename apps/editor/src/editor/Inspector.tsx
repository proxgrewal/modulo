import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import type { PageNode } from '@modulo/core';
import { errorMessage, pagesPath, patch } from '../api.ts';
import { setPropOp } from '../lib/layout-ops.ts';
import { useStore } from '../lib/store.ts';
import { findNode, INSTANCE_TYPE, locateNode, nodeSnippet, PAGE_ROOT } from '../lib/tree.ts';
import { Row, useUid } from '../ui/controls.tsx';
import { blockIcon, Icon } from '../ui/Icon.tsx';
import { toast } from '../ui/toast.ts';
import { FieldList } from './FieldControls.tsx';
import { DetachedNote, InstanceNote } from './panels/LibraryPanel.tsx';
import { actions, editor } from './state.ts';
import { layoutTarget, pageTarget, PresetEditor, StylePanel } from './style/StylePanel.tsx';

export function Inspector() {
  const selection = useStore(editor, (s) => s.selection);
  const editingPreset = useStore(editor, (s) => s.editingPreset);
  return (
    <aside className="inspector" aria-label="Inspector">
      {editingPreset ? <PresetEditor name={editingPreset} key={`preset:${editingPreset}`} /> : selection ? <NodeInspector id={selection.id} mode={selection.mode} key={`${selection.mode}:${selection.id}`} /> : <PageSettings />}
    </aside>
  );
}

const NodeInspector = memo(function NodeInspector({ id, mode }: { id: string; mode: 'page' | 'layout' }) {
  const node = useStore(editor, (s) => (mode === 'page' ? findNode(s.tree, id) : findNode(s.layout?.tree ?? null, id)));
  const schema = useStore(editor, (s) => (node ? s.schemas.get(node.type) : undefined));
  const modules = useStore(editor, (s) => s.runtime?.modules ?? []);
  const provenance = useStore(editor, (s) => (mode === 'layout' ? s.layout?.provenance?.[id] : undefined));
  const tab = useStore(editor, (s) => s.inspectorTab);
  const canEdit = useStore(editor, (s) => s.canEdit);
  const parentLabel = useStore(editor, (s) => {
    if (mode !== 'page') return null;
    const loc = locateNode(s.tree, id);
    if (!loc || loc.parent.id === PAGE_ROOT) return null;
    return s.schemas.get(loc.parent.type)?.label ?? loc.parent.type;
  });

  const onProp = useCallback(
    (key: string, v: unknown) => {
      if (mode === 'page') actions.setProps(id, { [key]: v });
      else actions.layoutEdit([setPropOp(id, key, v)]);
    },
    [id, mode],
  );

  if (!node) {
    return (
      <div className="insp-empty">
        <p>The selected block no longer exists.</p>
        <button className="btn" onClick={() => actions.select(null)}>
          Back to page settings
        </button>
      </div>
    );
  }
  const isInstance = node.type === INSTANCE_TYPE;
  const moduleName = schema?.module;
  const moduleLabel = modules.find((m) => m.name === moduleName)?.label ?? moduleName;
  const locked = !!node.locked;
  const disabled = !canEdit || locked;
  return (
    <div className="insp">
      <header className="insp-head">
        <div className="insp-title">
          <span className="insp-icon">
            <Icon name={blockIcon(schema?.icon, schema?.category)} size={16} />
          </span>
          <div>
            <h2>{node.name || (schema?.label ?? node.type)}</h2>
            <p className="muted small">
              {nodeSnippet(node) || node.type}
              {parentLabel && <> · in {parentLabel}</>}
            </p>
          </div>
          <button className="icon-btn" aria-label="Close inspector (deselect)" title="Deselect (Esc)" onClick={() => actions.select(null)}>
            <Icon name="x" size={16} />
          </button>
        </div>
        <div className="badges">
          {node.name && <span className="badge">{schema?.label ?? node.type}</span>}
          {moduleName && moduleName !== 'core' && !isInstance && (
            <span className="badge module" title={`Block provided by the ${moduleLabel} module`}>
              <Icon name="puzzle" size={12} /> from {moduleLabel} module
            </span>
          )}
          {moduleName === 'core' && <span className="badge">Core block</span>}
          {mode === 'layout' && (
            <span className="badge layout" title="Part of the site layout, shared by every page">
              <Icon name="layout" size={12} /> Site layout{provenance && provenance !== 'template' ? ` · ${provenance}` : ''}
            </span>
          )}
          {node.origin && node.origin !== 'user' && mode === 'page' && <span className="badge">added by {node.origin}</span>}
          {locked && (
            <span className="badge locked">
              <Icon name="lock" size={12} /> Locked
            </span>
          )}
          {node.bind && Object.keys(node.bind).length > 0 && <span className="badge" title={Object.entries(node.bind).map(([k, v]) => `${k} ← ${v}`).join('\n')}>bound data</span>}
        </div>
        {mode === 'layout' && <p className="note">Changes here apply to the header/footer on every page.</p>}
        {isInstance && mode === 'page' && <InstanceNote node={node} disabled={disabled} />}
        {!isInstance && mode === 'page' && <DetachedNote node={node} disabled={disabled} />}
        {schema?.unpackable && mode === 'page' && (
          <button className="btn sm" disabled={disabled} onClick={() => actions.unpack(id)} title="Replace this block with boxes, headings, text and buttons you can style individually">
            <Icon name="unpack" size={13} /> Unpack into editable parts
          </button>
        )}
        {locked && <p className="note">This block is locked by its template and can’t be edited or moved.</p>}
        <div className="tabs" role="tablist" aria-label="Inspector sections">
          {(['content', 'style'] as const).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'active' : ''} onClick={() => editor.set({ inspectorTab: t })}>
              {t === 'content' ? 'Content' : 'Style'}
            </button>
          ))}
        </div>
      </header>
      <div className="insp-body" role="tabpanel">
        {tab === 'content' ? (
          isInstance ? (
            <p className="muted small">A synced instance has no content of its own: pick the component above, or detach it to edit a copy.</p>
          ) : (
            <FieldList fields={schema?.fields ?? {}} props={node.props} onChange={onProp} disabled={disabled} />
          )
        ) : (
          <StyleTab node={node} mode={mode} disabled={disabled} />
        )}
      </div>
    </div>
  );
});

/* ───────── style tab ───────── */

function StyleTab({ node, mode, disabled }: { node: PageNode; mode: 'page' | 'layout'; disabled: boolean }) {
  const canDesign = useStore(editor, (s) => !!s.runtime && (s.runtime.user.isSuperadmin || s.runtime.user.permissions.some((p) => p === '*' || p === 'core.design')));
  const target = useMemo(() => (mode === 'page' ? pageTarget(node, disabled) : layoutTarget(node, disabled || !canDesign)), [node, mode, disabled, canDesign]);
  return <StylePanel target={target} presetBar />;
}

/* ───────── nothing selected: page settings ───────── */

function PageSettings() {
  const page = useStore(editor, (s) => s.pages.find((p) => p.id === s.pageId) ?? null);
  const site = useStore(editor, (s) => s.site);
  const count = useStore(editor, (s) => s.tree?.slots?.default?.length ?? 0);
  const uid = useUid('pg');
  const [title, setTitle] = useState(page?.title ?? '');
  const [path, setPath] = useState(page?.path ?? '');
  const [desc, setDesc] = useState(page?.description ?? '');
  useEffect(() => {
    setTitle(page?.title ?? '');
    setPath(page?.path ?? '');
    setDesc(page?.description ?? '');
  }, [page?.id, page?.title, page?.path, page?.description]);
  if (!page) return <div className="insp-empty muted">Select a page to edit.</div>;
  const dirty = title !== page.title || path !== page.path || desc !== (page.description ?? '');
  const save = async () => {
    try {
      await patch(pagesPath(site, `/pages/${page.id}`), { title, path, description: desc });
      await actions.reloadPages();
      toast.success('Page settings saved');
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  return (
    <div className="insp">
      <header className="insp-head">
        <div className="insp-title">
          <span className="insp-icon">
            <Icon name="file" size={16} />
          </span>
          <div>
            <h2>Page</h2>
            <p className="muted small">
              {count} top-level block{count === 1 ? '' : 's'} · {page.status === 'published' ? (page.hasUnpublishedChanges ? 'Published, with changes' : 'Published') : 'Draft'}
            </p>
          </div>
        </div>
        <p className="note">Click any block on the canvas to edit it. Drag blocks from Insert, or press “/” to search.</p>
      </header>
      <form
        className="insp-body"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <Row label="Title" htmlFor={`${uid}-t`}>
          <input id={`${uid}-t`} className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
        </Row>
        <Row label="URL path" htmlFor={`${uid}-p`} help="Lowercase letters, digits and dashes, e.g. /about">
          <input id={`${uid}-p`} className="input" value={path} onChange={(e) => setPath(e.target.value)} />
        </Row>
        <Row label="SEO description" htmlFor={`${uid}-d`}>
          <textarea id={`${uid}-d`} className="input" rows={3} value={desc} onChange={(e) => setDesc(e.target.value)} />
        </Row>
        <button className="btn primary" type="submit" disabled={!dirty}>
          Save page settings
        </button>
      </form>
    </div>
  );
}
