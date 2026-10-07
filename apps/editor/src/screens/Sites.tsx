import { useEffect, useState } from 'react';
import { errorMessage, get, post, sitePath } from '../api.ts';
import { navigate } from '../router.ts';
import type { CatalogModule, Site, User } from '../types.ts';
import { Empty, Row, Spinner, useUid } from '../ui/controls.tsx';
import { Icon } from '../ui/Icon.tsx';
import { colorFor, initials } from '../editor/state.ts';
import { Logo } from './Auth.tsx';

function Header({ user, onLogout }: { user: User; onLogout: () => void }) {
  return (
    <header className="home-head">
      <Logo />
      <span className="grow" />
      <span className="avatar" style={{ background: colorFor(user.id) }} aria-hidden="true">
        {initials(user.name || user.email)}
      </span>
      <span className="muted small">{user.email}</span>
      <button className="btn ghost sm" onClick={onLogout}>
        <Icon name="logout" size={14} /> Sign out
      </button>
    </header>
  );
}

export function SitesScreen({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [sites, setSites] = useState<Site[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    get<Site[]>('/api/sites')
      .then(setSites)
      .catch((e) => setErr(errorMessage(e)));
  }, []);
  return (
    <div className="home">
      <Header user={user} onLogout={onLogout} />
      <main className="home-main">
        <div className="home-title">
          <h1>Your sites</h1>
          <button className="btn primary" onClick={() => navigate({ name: 'new-site' })}>
            <Icon name="plus" size={16} /> New site
          </button>
        </div>
        {err && <p className="form-error">{err}</p>}
        {!sites ? (
          <div className="center-pad">
            <Spinner />
          </div>
        ) : sites.length === 0 ? (
          <Empty>
            <Icon name="globe" size={32} />
            <p>No sites yet. Create your first one.</p>
            <button className="btn primary" onClick={() => navigate({ name: 'new-site' })}>
              Create a site
            </button>
          </Empty>
        ) : (
          <ul className="site-grid">
            {sites.map((s) => (
              <li key={s.id}>
                <button className="site-card" onClick={() => navigate({ name: 'editor', site: s.slug })}>
                  <span className="site-thumb" style={{ background: `linear-gradient(135deg, ${colorFor(s.slug)}, ${colorFor(s.id)})` }} aria-hidden="true">
                    {initials(s.name)}
                  </span>
                  <span className="site-meta">
                    <strong>{s.name}</strong>
                    <span className="muted small">/s/{s.slug}{s.domain ? ` · ${s.domain}` : ''}</span>
                    {s.role && <span className="mini-badge">{s.role}</span>}
                  </span>
                </button>
                <a className="site-open" href={`/s/${s.slug}`} target="_blank" rel="noreferrer" aria-label={`Open ${s.name} live site`}>
                  <Icon name="external" size={15} />
                </a>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}

function slugify(s: string) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

export function NewSiteScreen({ user, onLogout }: { user: User; onLogout: () => void }) {
  const uid = useUid('ns');
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [catalog, setCatalog] = useState<CatalogModule[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    get<CatalogModule[]>('/api/catalog')
      .then((all) => setCatalog(all.filter((m) => !m.required && !m.activatesWhen?.length)))
      .catch(() => setCatalog([]));
  }, []);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const site = await post<Site>('/api/sites', { name, slug, modules: [...picked] });
      navigate({ name: 'editor', site: site.slug });
    } catch (e2) {
      setErr(errorMessage(e2));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="home">
      <Header user={user} onLogout={onLogout} />
      <main className="home-main narrow">
        <button className="link-btn back" onClick={() => navigate({ name: 'sites' })}>
          <Icon name="chevron-left" size={14} /> All sites
        </button>
        <h1>Create a site</h1>
        <form className="card form" onSubmit={submit}>
          <Row label="Site name" htmlFor={`${uid}-n`}>
            <input
              id={`${uid}-n`}
              className="input"
              required
              autoFocus
              value={name}
              placeholder="Acme Studio"
              onChange={(e) => {
                setName(e.target.value);
                if (!slugTouched) setSlug(slugify(e.target.value));
              }}
            />
          </Row>
          <Row label="Address" htmlFor={`${uid}-s`} help={slug ? `Your site will be at /s/${slug}` : 'Lowercase letters, digits and dashes.'}>
            <input
              id={`${uid}-s`}
              className="input"
              required
              pattern="[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
              value={slug}
              placeholder="acme"
              onChange={(e) => {
                setSlug(e.target.value);
                setSlugTouched(true);
              }}
            />
          </Row>
          <fieldset className="module-pick">
            <legend>Modules (optional)</legend>
            {catalog === null ? (
              <Spinner />
            ) : catalog.length === 0 ? (
              <p className="muted small">Core, Pages and Media are always included. You can add more modules later from the Modules panel.</p>
            ) : (
              <div className="module-checks">
                {catalog.map((m) => (
                  <label key={m.name} className={`module-check${picked.has(m.name) ? ' on' : ''}`}>
                    <input
                      type="checkbox"
                      checked={picked.has(m.name)}
                      onChange={(e) =>
                        setPicked((p) => {
                          const n = new Set(p);
                          e.target.checked ? n.add(m.name) : n.delete(m.name);
                          return n;
                        })
                      }
                    />
                    <span>
                      <strong>{m.label}</strong>
                      {m.description && <span className="muted small">{m.description}</span>}
                    </span>
                  </label>
                ))}
              </div>
            )}
          </fieldset>
          {err && (
            <p className="form-error" role="alert">
              {err}
            </p>
          )}
          <button className="btn primary" disabled={busy || !name || !slug}>
            {busy ? 'Creating…' : 'Create site'}
          </button>
        </form>
      </main>
    </div>
  );
}
