import { useCallback, useEffect, useState } from 'react';
import { ApiError, errorMessage, get, post, put, sitePath } from '../../api.ts';
import { useStore } from '../../lib/store.ts';
import type { CatalogModule, ConflictInfo, InstalledModule } from '../../types.ts';
import { Dialog } from '../../ui/Dialog.tsx';
import { Empty, Spinner } from '../../ui/controls.tsx';
import { Icon } from '../../ui/Icon.tsx';
import { toast } from '../../ui/toast.ts';
import { FieldList } from '../FieldControls.tsx';
import { actions, editor } from '../state.ts';

interface ModuleChange {
  install?: Record<string, string>;
  uninstall?: string[];
  upgrade?: string[];
  cascade?: boolean;
}

interface Plan {
  added: { name: string; version: string }[];
  removed: { name: string; version: string }[];
  upgraded: { name: string; from: string; to: string }[];
  conflicts: ConflictInfo[];
  patchFailures: { template: string; patch: string; module: string; target: string; reason: string }[];
}

function describeChange(c: ModuleChange): string {
  if (c.install) return `Install ${Object.keys(c.install).join(', ')}`;
  if (c.uninstall) return `Uninstall ${c.uninstall.join(', ')}`;
  return `Upgrade ${c.upgrade?.join(', ')}`;
}

function PlanDialog({ change, onClose, onDone }: { change: ModuleChange; onClose: () => void; onDone: () => void }) {
  const site = editor.get().site;
  const [plan, setPlan] = useState<Plan | null>(null);
  const [err, setErr] = useState<{ message: string; dependents?: string[] } | null>(null);
  const [cascade, setCascade] = useState(!!change.cascade);
  const [busy, setBusy] = useState(false);
  const body = { ...change, cascade };
  useEffect(() => {
    setPlan(null);
    setErr(null);
    post<Plan>(sitePath(site, '/modules/plan'), body)
      .then(setPlan)
      .catch((e) => setErr({ message: errorMessage(e), dependents: e instanceof ApiError ? (e.details as any)?.dependents : undefined }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cascade]);
  const apply = async () => {
    setBusy(true);
    try {
      await post(sitePath(site, '/modules/apply'), body);
      toast.success(`${describeChange(change)}: done`);
      onDone();
      onClose();
    } catch (e) {
      setErr({ message: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  const destructive = !!plan?.removed.length;
  return (
    <Dialog
      title={describeChange(change)}
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className={`btn ${destructive ? 'danger' : 'primary'}`} disabled={!plan || busy} onClick={apply}>
            {busy ? 'Applying…' : 'Confirm'}
          </button>
        </>
      }
    >
      {!plan && !err && (
        <div className="center-pad">
          <Spinner label="Planning change" />
        </div>
      )}
      {err && (
        <div className="form-error" role="alert">
          <p>{err.message}</p>
          {err.dependents?.length ? (
            <label className="check">
              <input type="checkbox" checked={cascade} onChange={(e) => setCascade(e.target.checked)} /> Also uninstall {err.dependents.join(', ')}
            </label>
          ) : null}
        </div>
      )}
      {plan && (
        <div className="plan">
          <p className="muted small">Review what will change before applying. The change runs in a single transaction.</p>
          {plan.added.length > 0 && (
            <section>
              <h3 className="plan-h added">Will be installed</h3>
              <ul>
                {plan.added.map((m) => (
                  <li key={m.name}>
                    <strong>{m.name}</strong> <span className="muted">v{m.version}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {plan.upgraded.length > 0 && (
            <section>
              <h3 className="plan-h upgraded">Will be upgraded</h3>
              <ul>
                {plan.upgraded.map((m) => (
                  <li key={m.name}>
                    <strong>{m.name}</strong> <span className="muted">v{m.from} → v{m.to}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {plan.removed.length > 0 && (
            <section>
              <h3 className="plan-h removed">Will be removed</h3>
              <ul>
                {plan.removed.map((m) => (
                  <li key={m.name}>
                    <strong>{m.name}</strong> <span className="muted">v{m.version}</span>
                  </li>
                ))}
              </ul>
              <p className="note warn">Blocks from removed modules will show as missing on pages that use them. Data tables are kept.</p>
            </section>
          )}
          {plan.conflicts.length > 0 && (
            <section>
              <h3 className="plan-h conflict">Patch conflicts</h3>
              <ul>
                {plan.conflicts.map((c) => (
                  <li key={c.target + c.kind}>
                    <code>{c.target}</code> ({c.kind}): {c.modules.join(' vs ')} — <strong>{c.winner}</strong> wins by default
                  </li>
                ))}
              </ul>
            </section>
          )}
          {plan.patchFailures.length > 0 && (
            <section>
              <h3 className="plan-h conflict">Patches that won’t apply</h3>
              <ul>
                {plan.patchFailures.map((f, i) => (
                  <li key={i}>
                    {f.module}: <code>{f.target}</code> — {f.reason}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {!plan.added.length && !plan.removed.length && !plan.upgraded.length && <p>Nothing to change.</p>}
        </div>
      )}
    </Dialog>
  );
}

function SettingsDialog({ mod, onClose }: { mod: InstalledModule; onClose: () => void }) {
  const schema = useStore(editor, (s) => s.runtime?.settingsSchemas[mod.name] ?? {});
  const current = useStore(editor, (s) => s.runtime?.settings[mod.name] ?? {});
  const [values, setValues] = useState<Record<string, unknown>>(current);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await put(sitePath(editor.get().site, `/modules/${mod.name}/settings`), values);
      await actions.reloadRuntime();
      toast.success(`${mod.label} settings saved`);
      onClose();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={`${mod.label} settings`}
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy} onClick={save}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <FieldList fields={schema} props={values} onChange={(k, v) => setValues((s) => ({ ...s, [k]: v }))} idPrefix={`set-${mod.name}`} />
    </Dialog>
  );
}

export function ModulesPanel() {
  const site = useStore(editor, (s) => s.site);
  const conflicts = useStore(editor, (s) => s.runtime?.conflicts ?? []);
  const schemas = useStore(editor, (s) => s.runtime?.settingsSchemas ?? {});
  const isAdmin = useStore(editor, (s) => !!s.runtime && (s.runtime.user.isSuperadmin || s.runtime.user.permissions.includes('*')));
  const [data, setData] = useState<{ installed: InstalledModule[]; catalog: CatalogModule[] } | null>(null);
  const [tab, setTab] = useState<'installed' | 'catalog'>('installed');
  const [change, setChange] = useState<ModuleChange | null>(null);
  const [settings, setSettings] = useState<InstalledModule | null>(null);
  const load = useCallback(async () => {
    try {
      setData(await get(sitePath(site, '/modules')));
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }, [site]);
  useEffect(() => {
    load();
  }, [load]);
  const resolve = async (c: ConflictInfo, module: string) => {
    try {
      await post(sitePath(site, '/conflicts/resolve'), { key: `${c.target}|${c.kind}`, module });
      await actions.reloadRuntime();
      await actions.reloadLayout();
      toast.success(`${module} now wins ${c.target}`);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const installedNames = new Set(data?.installed.map((m) => m.name));
  const available = data?.catalog.filter((m) => !installedNames.has(m.name)) ?? [];
  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Modules</h2>
        <div className="tabs" role="tablist" aria-label="Module lists">
          <button role="tab" aria-selected={tab === 'installed'} className={tab === 'installed' ? 'active' : ''} onClick={() => setTab('installed')}>
            Installed {data ? `(${data.installed.length})` : ''}
          </button>
          <button role="tab" aria-selected={tab === 'catalog'} className={tab === 'catalog' ? 'active' : ''} onClick={() => setTab('catalog')}>
            Catalog {data ? `(${available.length})` : ''}
          </button>
        </div>
        {!isAdmin && <p className="note">Only site owners/admins can install or remove modules.</p>}
      </div>
      <div className="panel-body">
        {conflicts.length > 0 && (
          <section className="conflicts" aria-label="Patch conflicts">
            <h3>
              <Icon name="alert" size={14} /> Patch conflicts
            </h3>
            {conflicts.map((c) => (
              <div key={`${c.template}${c.target}${c.kind}`} className="conflict">
                <p>
                  <code>{c.target}</code> <span className="muted small">({c.kind})</span> is changed by {c.modules.join(' and ')}.
                </p>
                <label className="conflict-pick">
                  Winner
                  <select className="input" value={c.winner} disabled={!isAdmin} onChange={(e) => resolve(c, e.target.value)}>
                    {c.modules.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            ))}
          </section>
        )}
        {!data ? (
          <div className="center-pad">
            <Spinner />
          </div>
        ) : tab === 'installed' ? (
          <ul className="module-list">
            {data.installed.map((m) => (
              <li key={m.name} className="module-card">
                <div className="module-top">
                  <Icon name="puzzle" size={16} />
                  <strong>{m.label}</strong>
                  <span className="muted small">v{m.version}</span>
                  {m.required && <span className="mini-badge">required</span>}
                  {m.auto && <span className="mini-badge" title="Installed automatically as a dependency or glue module">auto</span>}
                </div>
                {m.description && <p className="muted small">{m.description}</p>}
                <div className="row-btns">
                  {schemas[m.name] && (
                    <button className="btn sm" onClick={() => setSettings(m)}>
                      <Icon name="settings" size={13} /> Settings
                    </button>
                  )}
                  {m.updateAvailable && (
                    <button className="btn sm primary" disabled={!isAdmin} onClick={() => setChange({ upgrade: [m.name] })}>
                      Upgrade to v{m.updateAvailable}
                    </button>
                  )}
                  {!m.required && (
                    <button className="btn sm ghost danger" disabled={!isAdmin} onClick={() => setChange({ uninstall: [m.name] })}>
                      Uninstall
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        ) : available.length === 0 ? (
          <Empty>Every module in the catalog is installed.</Empty>
        ) : (
          <ul className="module-list">
            {available.map((m) => (
              <li key={m.name} className="module-card">
                <div className="module-top">
                  <Icon name="box" size={16} />
                  <strong>{m.label}</strong>
                  <span className="muted small">v{m.versions[0]}</span>
                  {m.category && <span className="mini-badge">{m.category}</span>}
                </div>
                {m.description && <p className="muted small">{m.description}</p>}
                {Object.keys(m.depends).length > 0 && <p className="muted small">Requires: {Object.keys(m.depends).join(', ')}</p>}
                {m.activatesWhen?.length ? <p className="muted small">Activates automatically with {m.activatesWhen.join(' + ')}</p> : null}
                <div className="row-btns">
                  <button className="btn sm primary" disabled={!isAdmin || !!m.activatesWhen?.length} onClick={() => setChange({ install: { [m.name]: '*' } })}>
                    <Icon name="plus" size={13} /> Install
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
      {change && (
        <PlanDialog
          change={change}
          onClose={() => setChange(null)}
          onDone={async () => {
            await load();
            editor.set({ models: null });
            await actions.reloadRuntime();
            await actions.reloadLayout().catch(() => {});
            await actions.reloadPages().catch(() => {});
          }}
        />
      )}
      {settings && <SettingsDialog mod={settings} onClose={() => setSettings(null)} />}
    </div>
  );
}
