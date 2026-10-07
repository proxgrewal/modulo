import { useEffect, useState } from 'react';
import { errorMessage, get, pagesPath, post } from '../api.ts';
import { navigate } from '../router.ts';
import { shallowEqual, useStore } from '../lib/store.ts';
import type { Device, PageSummary, Site } from '../types.ts';
import { Segmented } from '../ui/controls.tsx';
import { Icon } from '../ui/Icon.tsx';
import { toast } from '../ui/toast.ts';
import { StatusBadge } from './panels/PagesPanel.tsx';
import { actions, colorFor, editor, initials, isMac, type SaveState } from './state.ts';

const STATUS: Record<SaveState, { label: string; icon: string }> = {
  saved: { label: 'Saved', icon: 'cloud' },
  saving: { label: 'Saving…', icon: 'refresh' },
  offline: { label: 'Offline', icon: 'cloud-off' },
  connecting: { label: 'Connecting…', icon: 'refresh' },
};

export function liveUrl(slug: string, path: string, draft = false) {
  return `/s/${slug}${path === '/' ? '' : path}${draft ? '?preview=draft' : ''}`;
}

export function TopBar({ onLogout }: { onLogout: () => void }) {
  const { site, runtime, pages, pageId, saveState, canUndo, canRedo, device, peers, canEdit } = useStore(
    editor,
    (s) => ({ site: s.site, runtime: s.runtime, pages: s.pages, pageId: s.pageId, saveState: s.saveState, canUndo: s.canUndo, canRedo: s.canRedo, device: s.device, peers: s.peers, canEdit: s.canEdit }),
    shallowEqual,
  );
  const [sites, setSites] = useState<Site[]>([]);
  const [publishing, setPublishing] = useState(false);
  useEffect(() => {
    get<Site[]>('/api/sites').then(setSites).catch(() => {});
  }, [site]);
  const page = pages.find((p) => p.id === pageId);
  const mod = isMac ? '⌘' : 'Ctrl+';
  const canPublish = !!runtime && (runtime.user.isSuperadmin || runtime.user.permissions.some((p) => p === '*' || p === 'pages.publish'));
  const st = STATUS[saveState];

  const preview = async () => {
    if (!page) return;
    const w = window.open('about:blank', '_blank');
    try {
      await actions.flushDraft();
    } catch {
      /* the room will have persisted most edits anyway */
    }
    if (w) w.location.href = liveUrl(site, page.path, true);
  };

  const publish = async () => {
    if (!page) return;
    setPublishing(true);
    try {
      await actions.flushDraft();
      await post<PageSummary>(pagesPath(site, `/pages/${page.id}/publish`), {});
      await actions.reloadPages();
      toast.success(`“${page.title}” is live`, { href: liveUrl(site, page.path), label: 'View site' });
    } catch (e) {
      toast.error(`Publish failed: ${errorMessage(e)}`);
    } finally {
      setPublishing(false);
    }
  };

  return (
    <header className="topbar">
      <div className="tb-left">
        <button className="brand" onClick={() => navigate({ name: 'sites' })} aria-label="All sites" title="All sites">
          <svg viewBox="0 0 32 32" width="26" height="26" aria-hidden="true">
            <rect width="32" height="32" rx="8" fill="var(--accent)" />
            <path d="M8 22V10l8 7 8-7v12" stroke="#fff" strokeWidth="3" fill="none" strokeLinejoin="round" />
          </svg>
        </button>
        <label className="sr-only" htmlFor="site-switch">
          Site
        </label>
        <select id="site-switch" className="tb-select" value={site} onChange={(e) => (e.target.value === '__new' ? navigate({ name: 'new-site' }) : navigate({ name: 'editor', site: e.target.value }))}>
          {!sites.some((s) => s.slug === site) && <option value={site}>{runtime?.site.name ?? site}</option>}
          {sites.map((s) => (
            <option key={s.id} value={s.slug}>
              {s.name}
            </option>
          ))}
          <option value="__new">+ New site…</option>
        </select>
        <span className="tb-sep" aria-hidden="true">
          /
        </span>
        <label className="sr-only" htmlFor="page-switch">
          Page
        </label>
        <select id="page-switch" className="tb-select" value={pageId ?? ''} onChange={(e) => navigate({ name: 'editor', site, page: e.target.value })}>
          {pages.map((p) => (
            <option key={p.id} value={p.id}>
              {p.title} — {p.path}
            </option>
          ))}
        </select>
        {page && <StatusBadge p={page} />}
      </div>
      <div className="tb-center">
        <Segmented<Device>
          label="Preview device"
          value={device}
          onChange={actions.setDevice}
          options={[
            { value: 'desktop', label: <Icon name="desktop" size={16} title="Desktop" />, title: 'Desktop' },
            { value: 'tablet', label: <Icon name="tablet" size={16} title="Tablet" />, title: 'Tablet · 1024px' },
            { value: 'mobile', label: <Icon name="mobile" size={16} title="Mobile" />, title: 'Mobile · 640px' },
            { value: 'small', label: <Icon name="small" size={16} title="Small phone" />, title: 'Small phone · 420px' },
          ]}
        />
        <div className="tb-group">
          <button className="icon-btn" aria-label="Undo" title={`Undo (${mod}Z)`} disabled={!canUndo} onClick={actions.undo}>
            <Icon name="undo" />
          </button>
          <button className="icon-btn" aria-label="Redo" title={`Redo (${isMac ? '⇧⌘Z' : 'Ctrl+Shift+Z'})`} disabled={!canRedo} onClick={actions.redo}>
            <Icon name="redo" />
          </button>
        </div>
      </div>
      <div className="tb-right">
        {peers.length > 0 && (
          <ul className="presence" aria-label={`${peers.length} other editor${peers.length > 1 ? 's' : ''} here`}>
            {peers.slice(0, 5).map((p) => (
              <li key={p.clientId} className="avatar" style={{ background: p.color }} title={p.name}>
                {initials(p.name)}
              </li>
            ))}
            {peers.length > 5 && <li className="avatar more">+{peers.length - 5}</li>}
          </ul>
        )}
        <span className={`save-status ${saveState}`} role="status" aria-live="polite">
          <Icon name={st.icon} size={15} />
          {canEdit ? st.label : 'View only'}
        </span>
        <button className="btn ghost" onClick={preview} disabled={!page}>
          <Icon name="eye" size={16} /> Preview
        </button>
        <button className="btn primary" onClick={publish} disabled={!page || publishing || !canPublish} title={canPublish ? 'Publish this page' : 'You do not have permission to publish'}>
          <Icon name="rocket" size={16} /> {publishing ? 'Publishing…' : 'Publish'}
        </button>
        <details className="menu user-menu">
          <summary className="avatar me" style={{ background: colorFor(runtime?.user.id ?? 'me') }} aria-label="Account menu">
            {initials(runtime?.user.name || runtime?.user.email || '?')}
          </summary>
          <div className="menu-pop right" role="menu">
            <div className="menu-info">
              <strong>{runtime?.user.name || 'Signed in'}</strong>
              <span className="muted small">{runtime?.user.email}</span>
              <span className="muted small">Role: {runtime?.user.isSuperadmin ? 'superadmin' : runtime?.user.role}</span>
            </div>
            <a role="menuitem" href={liveUrl(site, '/')} target="_blank" rel="noreferrer">
              <Icon name="globe" size={14} /> Open live site
            </a>
            <button role="menuitem" onClick={() => navigate({ name: 'sites' })}>
              <Icon name="home" size={14} /> All sites
            </button>
            <button role="menuitem" onClick={onLogout}>
              <Icon name="logout" size={14} /> Sign out
            </button>
          </div>
        </details>
      </div>
    </header>
  );
}
