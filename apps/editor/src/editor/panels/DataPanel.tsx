import { useCallback, useEffect, useMemo, useState } from 'react';
import { del, errorMessage, get, patch, post, sitePath } from '../../api.ts';
import { cellText, coerceModelValue, editableModelFields, formatModelValue, humanize, modelControlFor } from '../../lib/fields.ts';
import { useStore } from '../../lib/store.ts';
import type { ModelFieldDef, ModelInfo } from '../../types.ts';
import { Dialog } from '../../ui/Dialog.tsx';
import { Empty, Row, Spinner, Switch, useUid } from '../../ui/controls.tsx';
import { Icon } from '../../ui/Icon.tsx';
import { toast } from '../../ui/toast.ts';
import { ImageControl } from '../FieldControls.tsx';
import { RichText } from '../RichText.tsx';
import { actions, editor } from '../state.ts';

const PAGE_SIZE = 20;

function RefSelect({ id, model, value, onChange }: { id: string; model: string; value: string; onChange: (v: string) => void }) {
  const site = editor.get().site;
  const [opts, setOpts] = useState<{ id: string; title: string }[] | null>(null);
  useEffect(() => {
    Promise.all([actions.loadModels(), get<{ items: any[] }>(sitePath(site, `/data/${encodeURIComponent(model)}?limit=200`))])
      .then(([models, r]) => {
        const m = models.find((x) => x.name === model);
        const tf = m?.titleField ?? 'id';
        setOpts(r.items.map((it) => ({ id: it.id, title: String(it[tf] ?? it.id) })));
      })
      .catch(() => setOpts([]));
  }, [model, site]);
  return (
    <select id={id} className="input" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{opts ? '— none —' : 'Loading…'}</option>
      {opts?.map((o) => (
        <option key={o.id} value={o.id}>
          {o.title}
        </option>
      ))}
    </select>
  );
}

function ModelInput({ f, id, value, onChange }: { f: ModelFieldDef; id: string; value: unknown; onChange: (v: unknown) => void }) {
  const c = modelControlFor(f);
  const v = formatModelValue(f, value);
  switch (c) {
    case 'switch':
      return <Switch id={id} label={f.label ?? humanize(f.name)} checked={!!v} onChange={onChange} />;
    case 'textarea':
      return <textarea id={id} className="input" rows={4} value={String(v)} onChange={(e) => onChange(e.target.value)} />;
    case 'json':
      return <textarea id={id} className="input mono" rows={6} value={typeof value === 'string' ? value : String(v)} onChange={(e) => onChange(e.target.value)} spellCheck={false} />;
    case 'richtext':
      return <RichText id={id} label={f.label ?? humanize(f.name)} value={String(v)} onChange={onChange} />;
    case 'select':
      return (
        <select id={id} className="input" value={String(v)} onChange={(e) => onChange(e.target.value)}>
          {!f.required && <option value="">—</option>}
          {(f.options ?? []).map((o) => (
            <option key={o} value={o}>
              {humanize(o)}
            </option>
          ))}
        </select>
      );
    case 'ref':
      return <RefSelect id={id} model={f.model ?? ''} value={String(v)} onChange={onChange} />;
    case 'media':
      return <ImageControl id={id} label={f.label ?? humanize(f.name)} value={String(v)} onChange={onChange} />;
    case 'int':
    case 'float':
    case 'money':
      return <input id={id} className="input" type="number" step={c === 'int' ? 1 : c === 'money' ? 0.01 : 'any'} value={String(v)} onChange={(e) => onChange(e.target.value)} />;
    case 'date':
      return <input id={id} className="input" type="date" value={String(v)} onChange={(e) => onChange(e.target.value)} />;
    case 'datetime':
      return <input id={id} className="input" type="datetime-local" value={String(v)} onChange={(e) => onChange(e.target.value)} />;
    case 'email':
      return <input id={id} className="input" type="email" value={String(v)} onChange={(e) => onChange(e.target.value)} />;
    case 'url':
      return <input id={id} className="input" type="text" inputMode="url" placeholder="https://… or /path" value={String(v)} onChange={(e) => onChange(e.target.value)} />;
    case 'slug':
      return <input id={id} className="input" value={String(v)} placeholder="auto-generated if empty" onChange={(e) => onChange(e.target.value)} />;
    default:
      return <input id={id} className="input" maxLength={f.max} value={String(v)} onChange={(e) => onChange(e.target.value)} />;
  }
}

function RecordForm({ model, record, onClose, onSaved }: { model: ModelInfo; record: Record<string, any> | null; onClose: () => void; onSaved: () => void }) {
  const site = editor.get().site;
  const uid = useUid('rec');
  const fields = useMemo(() => editableModelFields(model), [model]);
  const [values, setValues] = useState<Record<string, unknown>>(() => {
    const v: Record<string, unknown> = {};
    for (const f of fields) v[f.name] = record ? (f.kind === 'json' ? formatModelValue(f, record[f.name]) : record[f.name]) : f.default ?? (f.kind === 'boolean' ? false : '');
    return v;
  });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      const body: Record<string, unknown> = {};
      for (const f of fields) {
        const out = coerceModelValue(f, values[f.name]);
        if (out === undefined) continue;
        if (record && JSON.stringify(out) === JSON.stringify(record[f.name])) continue;
        if (!record && (out === null || out === '') && !f.required) continue;
        body[f.name] = out;
      }
      if (record) await patch(sitePath(site, `/data/${model.name}/${record.id}`), body);
      else await post(sitePath(site, `/data/${model.name}`), body);
      toast.success(record ? 'Saved' : 'Created');
      onSaved();
      onClose();
    } catch (e2) {
      setErr(errorMessage(e2));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title={`${record ? 'Edit' : 'New'} ${model.label ?? model.name}`} onClose={onClose} wide>
      <form className="form" onSubmit={save}>
        {fields.map((f) => (
          <Row key={f.name} label={`${f.label ?? humanize(f.name)}${f.required ? ' *' : ''}`} htmlFor={`${uid}-${f.name}`} help={f.help}>
            <ModelInput f={f} id={`${uid}-${f.name}`} value={values[f.name]} onChange={(v) => setValues((s) => ({ ...s, [f.name]: v }))} />
          </Row>
        ))}
        {err && (
          <p className="form-error" role="alert">
            {err}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy}>
            {busy ? 'Saving…' : record ? 'Save changes' : 'Create'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function CollectionView({ model, columns, label, onBack }: { model: ModelInfo; columns?: string[]; label: string; onBack: () => void }) {
  const site = useStore(editor, (s) => s.site);
  const [q, setQ] = useState('');
  const [page, setPage] = useState(0);
  const [data, setData] = useState<{ items: any[]; total: number } | null>(null);
  const [edit, setEdit] = useState<{ record: Record<string, any> | null } | null>(null);
  const [confirm, setConfirm] = useState<any>(null);
  const cols = (columns?.length ? columns : [model.titleField ?? Object.keys(model.fields)[0]!, ...Object.keys(model.fields).filter((k) => k !== model.titleField).slice(0, 2)]).filter(Boolean);
  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(page * PAGE_SIZE) });
      if (q) params.set('q', q);
      setData(await get(sitePath(site, `/data/${encodeURIComponent(model.name)}?${params}`)));
    } catch (e) {
      toast.error(errorMessage(e));
      setData({ items: [], total: 0 });
    }
  }, [site, model.name, q, page]);
  useEffect(() => {
    const t = setTimeout(load, q ? 250 : 0);
    return () => clearTimeout(t);
  }, [load, q]);
  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;
  return (
    <div className="panel">
      <div className="panel-head">
        <div className="panel-title-row">
          <button className="icon-btn" aria-label="Back to collections" onClick={onBack}>
            <Icon name="chevron-left" />
          </button>
          <h2>{label}</h2>
          <button className="btn sm primary" onClick={() => setEdit({ record: null })}>
            <Icon name="plus" size={14} /> New
          </button>
        </div>
        <div className="search-box">
          <Icon name="search" size={15} />
          <input
            className="input"
            type="search"
            aria-label={`Search ${label}`}
            placeholder={`Search ${label.toLowerCase()}`}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setPage(0);
            }}
          />
        </div>
      </div>
      <div className="panel-body">
        {!data ? (
          <div className="center-pad">
            <Spinner />
          </div>
        ) : data.items.length === 0 ? (
          <Empty>{q ? 'No matches.' : `No ${label.toLowerCase()} yet.`}</Empty>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  {cols.map((c) => (
                    <th key={c} scope="col">
                      {model.fields[c]?.label ?? humanize(c)}
                    </th>
                  ))}
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((it) => (
                  <tr key={it.id}>
                    {cols.map((c, i) => (
                      <td key={c}>
                        {i === 0 ? (
                          <button className="link-btn" onClick={() => setEdit({ record: it })}>
                            {cellText(it[c])}
                          </button>
                        ) : (
                          cellText(it[c])
                        )}
                      </td>
                    ))}
                    <td className="actions">
                      <button className="icon-btn sm danger" aria-label={`Delete ${cellText(it[cols[0]!])}`} onClick={() => setConfirm(it)}>
                        <Icon name="trash" size={13} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data && data.total > PAGE_SIZE && (
          <nav className="pager" aria-label="Pagination">
            <button className="btn sm" disabled={page === 0} onClick={() => setPage(page - 1)}>
              Previous
            </button>
            <span className="muted small">
              Page {page + 1} of {pages} · {data.total} records
            </span>
            <button className="btn sm" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>
              Next
            </button>
          </nav>
        )}
      </div>
      {edit && <RecordForm model={model} record={edit.record} onClose={() => setEdit(null)} onSaved={load} />}
      {confirm && (
        <Dialog
          title="Delete record?"
          onClose={() => setConfirm(null)}
          footer={
            <>
              <button className="btn ghost" onClick={() => setConfirm(null)}>
                Cancel
              </button>
              <button
                className="btn danger"
                onClick={async () => {
                  const it = confirm;
                  setConfirm(null);
                  try {
                    await del(sitePath(site, `/data/${model.name}/${it.id}`));
                    toast.success('Deleted');
                    load();
                    if (model.name === 'pages.page') actions.reloadPages();
                  } catch (e) {
                    toast.error(errorMessage(e));
                  }
                }}
              >
                Delete
              </button>
            </>
          }
        >
          <p>“{cellText(confirm[cols[0]!])}” will be permanently deleted.</p>
        </Dialog>
      )}
    </div>
  );
}

export function DataPanel() {
  const contributions = useStore(editor, (s) => s.runtime?.editor ?? []);
  const modules = useStore(editor, (s) => s.runtime?.modules ?? []);
  const models = useStore(editor, (s) => s.models);
  const [open, setOpen] = useState<{ model: string; label: string; columns?: string[] } | null>(null);
  useEffect(() => {
    actions.loadModels().catch((e) => toast.error(errorMessage(e)));
  }, []);
  const collections = contributions.flatMap((c) => (c.collections ?? []).map((col) => ({ ...col, module: c.module })));
  const model = open && models?.find((m) => m.name === open.model);
  if (open && model) return <CollectionView model={model} label={open.label} columns={open.columns} onBack={() => setOpen(null)} />;
  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Data</h2>
        <p className="muted small">Collections contributed by your installed modules.</p>
      </div>
      <div className="panel-body">
        {!models ? (
          <div className="center-pad">
            <Spinner />
          </div>
        ) : collections.length === 0 ? (
          <Empty>No collections. Install modules like Blog or Shop to manage content here.</Empty>
        ) : (
          <ul className="collection-list">
            {collections.map((c) => (
              <li key={c.model}>
                <button className="collection-item" onClick={() => setOpen(c)} disabled={!models.some((m) => m.name === c.model)}>
                  <Icon name="database" size={16} />
                  <span>
                    <strong>{c.label}</strong>
                    <span className="muted small">{modules.find((m) => m.name === c.module)?.label ?? c.module} · {c.model}</span>
                  </span>
                  <Icon name="chevron-right" size={14} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
