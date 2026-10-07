import { useState } from 'react';
import type { PageNode } from '@modulo/core';
import { errorMessage } from '../../api.ts';
import { describeOp, navLinkOp, setPropOp } from '../../lib/layout-ops.ts';
import { useStore } from '../../lib/store.ts';
import { findNode } from '../../lib/tree.ts';
import { Row, TextInput, useUid } from '../../ui/controls.tsx';
import { Icon } from '../../ui/Icon.tsx';
import { toast } from '../../ui/toast.ts';
import { actions, editor } from '../state.ts';

function LayoutTree({ node, depth, provenance }: { node: PageNode; depth: number; provenance: Record<string, string> }) {
  const schemas = useStore(editor, (s) => s.schemas);
  const sel = useStore(editor, (s) => (s.selection?.mode === 'layout' ? s.selection.id : null));
  const label = schemas.get(node.type)?.label ?? node.type;
  const prov = provenance[node.id];
  const isOutlet = node.type === 'core:outlet';
  return (
    <li style={{ ['--depth' as any]: depth }}>
      <button
        className={`layer-main layout-node${sel === node.id ? ' selected' : ''}`}
        disabled={isOutlet || node.type === 'core:page'}
        onClick={() => actions.select({ id: node.id, mode: 'layout' })}
        onMouseEnter={() => actions.hover(node.id)}
        onMouseLeave={() => actions.hover(null)}
      >
        <Icon name={isOutlet ? 'file' : 'layout'} size={13} />
        <span className="layer-label">{isOutlet ? 'Page content' : label}</span>
        <span className="layer-snippet">{String(node.props.label ?? node.props.text ?? '')}</span>
        {prov && prov !== 'template' && prov !== 'core' && <span className="mini-badge">{prov}</span>}
      </button>
      {Object.entries(node.slots ?? {}).map(([slot, kids]) =>
        isOutlet ? null : (
          <ul key={slot} className="layout-slot">
            {Object.keys(node.slots ?? {}).length > 1 && (
              <li className="slot-name" style={{ ['--depth' as any]: depth + 1 }}>
                #{slot}
              </li>
            )}
            {kids.map((k) => (
              <LayoutTree key={k.id} node={k} depth={depth + 1} provenance={provenance} />
            ))}
          </ul>
        ),
      )}
    </li>
  );
}

export function LayoutPanel() {
  const layout = useStore(editor, (s) => s.layout);
  const pages = useStore(editor, (s) => s.pages);
  const canDesign = useStore(editor, (s) => !!s.runtime && (s.runtime.user.isSuperadmin || s.runtime.user.permissions.some((p) => p === '*' || p === 'core.design')));
  const uid = useUid('lay');
  const [label, setLabel] = useState('');
  const [href, setHref] = useState('');
  if (!layout?.tree) return <div className="panel"><div className="panel-head"><h2>Layout</h2><p className="muted">No site layout template is installed.</p></div></div>;
  const header = findNode(layout.tree, 'header');
  const footer = findNode(layout.tree, 'footer');
  const navLinks = header?.slots?.nav ?? [];
  const siteFailures = layout.failures.filter((f) => f.module === 'site');
  const otherFailures = layout.failures.filter((f) => f.module !== 'site' && f.reason !== 'lost conflict');

  const addLink = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!label.trim() || !href.trim()) return;
    try {
      await actions.layoutEdit([navLinkOp(label.trim(), href.trim())], true);
      setLabel('');
      setHref('');
      toast.success('Link added to the header');
    } catch (e2) {
      toast.error(errorMessage(e2));
    }
  };
  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Layout</h2>
        <p className="muted small">The header and footer are shared by every page. Changes are stored as site-level patches on top of module templates.</p>
      </div>
      <div className="panel-body">
        <section className="sub">
          <h3>Navigation</h3>
          <ul className="nav-links">
            {navLinks.map((n) => (
              <li key={n.id}>
                <button className="link-btn" onClick={() => actions.select({ id: n.id, mode: 'layout' })}>
                  {String(n.props.label ?? n.id)}
                </button>
                <span className="muted small">{String(n.props.href ?? '')}</span>
                {layout.provenance[n.id] && !['template', 'core', 'site'].includes(layout.provenance[n.id]!) && <span className="mini-badge">{layout.provenance[n.id]}</span>}
                <button className="icon-btn sm danger" aria-label={`Remove ${String(n.props.label ?? n.id)} from navigation`} disabled={!canDesign} onClick={() => actions.layoutEdit([{ op: 'remove', target: n.id }], true)}>
                  <Icon name="trash" size={13} />
                </button>
              </li>
            ))}
          </ul>
          <form className="add-link" onSubmit={addLink}>
            <Row label="Link label" htmlFor={`${uid}-l`}>
              <input id={`${uid}-l`} className="input" value={label} placeholder="About" disabled={!canDesign} onChange={(e) => setLabel(e.target.value)} />
            </Row>
            <Row label="Link target" htmlFor={`${uid}-h`}>
              <div className="link-control">
                <input id={`${uid}-h`} className="input" value={href} placeholder="/about or https://…" disabled={!canDesign} onChange={(e) => setHref(e.target.value)} />
                <select
                  className="input"
                  aria-label="Pick a page"
                  disabled={!canDesign}
                  value=""
                  onChange={(e) => {
                    const p = pages.find((x) => x.path === e.target.value);
                    if (p) {
                      setHref(p.path);
                      if (!label) setLabel(p.title);
                    }
                  }}
                >
                  <option value="">Pick a page…</option>
                  {pages.map((p) => (
                    <option key={p.id} value={p.path}>
                      {p.title} ({p.path})
                    </option>
                  ))}
                </select>
              </div>
            </Row>
            <button className="btn sm primary" disabled={!canDesign || !label || !href}>
              <Icon name="plus" size={13} /> Add link
            </button>
          </form>
        </section>
        {footer && (
          <section className="sub">
            <h3>Footer</h3>
            <Row label="Footer text" htmlFor={`${uid}-f`} help={footer.bind?.text ? `Bound to ${footer.bind.text}: the bound value is shown on the site while the binding exists.` : undefined}>
              <TextInput id={`${uid}-f`} value={String(footer.props.text ?? '')} disabled={!canDesign} onChange={(v) => actions.layoutEdit([setPropOp('footer', 'text', v)])} />
            </Row>
          </section>
        )}
        <section className="sub">
          <h3>Structure</h3>
          <p className="muted small">Select a node to edit it in the inspector.</p>
          <ul className="layout-tree">
            <LayoutTree node={layout.tree} depth={0} provenance={layout.provenance} />
          </ul>
        </section>
        <section className="sub">
          <h3>Site customisations ({layout.ops.length})</h3>
          {layout.ops.length === 0 ? (
            <p className="muted small">None yet.</p>
          ) : (
            <ul className="ops-list">
              {layout.ops.map((op, i) => (
                <li key={i}>
                  <span>{describeOp(op)}</span>
                  <button className="icon-btn sm" aria-label={`Undo customisation: ${describeOp(op)}`} disabled={!canDesign} onClick={() => actions.setLayoutOps(layout.ops.filter((_, j) => j !== i)).catch((e) => toast.error(errorMessage(e)))}>
                    <Icon name="x" size={13} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          {layout.ops.length > 0 && (
            <button className="btn sm ghost danger" disabled={!canDesign} onClick={() => actions.setLayoutOps([]).catch((e) => toast.error(errorMessage(e)))}>
              Reset layout to module defaults
            </button>
          )}
        </section>
        {(siteFailures.length > 0 || otherFailures.length > 0) && (
          <section className="sub">
            <h3>
              <Icon name="alert" size={14} /> Patches that didn’t apply
            </h3>
            <ul className="ops-list">
              {[...siteFailures, ...otherFailures].map((f, i) => (
                <li key={i}>
                  <span>
                    <strong>{f.module}</strong> {f.op} <code>{f.target}</code>: {f.reason}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}
