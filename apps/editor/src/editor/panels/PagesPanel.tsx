import { useEffect, useState } from 'react';
import { del, errorMessage, get, pagesPath, patch, post } from '../../api.ts';
import { navigate } from '../../router.ts';
import { useStore } from '../../lib/store.ts';
import type { PageSummary } from '../../types.ts';
import { Dialog } from '../../ui/Dialog.tsx';
import { Row, useUid } from '../../ui/controls.tsx';
import { Icon } from '../../ui/Icon.tsx';
import { toast } from '../../ui/toast.ts';
import { actions, editor } from '../state.ts';

export function slugifyPath(title: string): string {
  const s = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return '/' + s;
}

export function StatusBadge({ p }: { p: PageSummary }) {
  if (p.status !== 'published') return <span className="badge draft">Draft</span>;
  if (p.hasUnpublishedChanges) return <span className="badge changed" title="Published, with unpublished changes">Changed</span>;
  return <span className="badge live">Live</span>;
}

function PageDialog({ page, onClose }: { page?: PageSummary; onClose: () => void }) {
  const site = editor.get().site;
  const uid = useUid('pd');
  const [title, setTitle] = useState(page?.title ?? '');
  const [path, setPath] = useState(page?.path ?? '');
  const [pathTouched, setPathTouched] = useState(!!page);
  const [template, setTemplate] = useState('blank');
  const [templates, setTemplates] = useState<{ id: string; label: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!page) get<{ id: string; label: string }[]>(pagesPath(site, '/templates')).then(setTemplates).catch(() => setTemplates([{ id: 'blank', label: 'Blank' }]));
  }, [page, site]);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      if (page) {
        await patch(pagesPath(site, `/pages/${page.id}`), { title, path });
        await actions.reloadPages();
        toast.success('Page updated');
      } else {
        const created = await post<PageSummary>(pagesPath(site, '/pages'), { title, path, template });
        await actions.reloadPages();
        navigate({ name: 'editor', site, page: created.id });
        toast.success(`Created “${title}”`);
      }
      onClose();
    } catch (e2) {
      setErr(errorMessage(e2));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title={page ? 'Page settings' : 'New page'} onClose={onClose}>
      <form onSubmit={submit} className="form">
        <Row label="Title" htmlFor={`${uid}-t`}>
          <input
            id={`${uid}-t`}
            className="input"
            required
            autoFocus
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
              if (!pathTouched) setPath(slugifyPath(e.target.value));
            }}
          />
        </Row>
        <Row label="URL path" htmlFor={`${uid}-p`} help="Like /about or /services/design">
          <input
            id={`${uid}-p`}
            className="input"
            required
            value={path}
            onChange={(e) => {
              setPath(e.target.value);
              setPathTouched(true);
            }}
          />
        </Row>
        {!page && (
          <fieldset className="template-pick">
            <legend>Start from</legend>
            <div className="template-grid">
              {templates.map((t) => (
                <label key={t.id} className={`template-card${template === t.id ? ' active' : ''}`}>
                  <input type="radio" name="tpl" value={t.id} checked={template === t.id} onChange={() => setTemplate(t.id)} />
                  <span className={`template-thumb tpl-${t.id}`} aria-hidden="true">
                    <i />
                    <i />
                    <i />
                  </span>
                  <span>{t.label}</span>
                </label>
              ))}
            </div>
          </fieldset>
        )}
        {err && (
          <p className="form-error" role="alert">
            {err}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || !title || !path}>
            {busy ? 'Saving…' : page ? 'Save' : 'Create page'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

export function PagesPanel() {
  const pages = useStore(editor, (s) => s.pages);
  const pageId = useStore(editor, (s) => s.pageId);
  const site = useStore(editor, (s) => s.site);
  const [dialog, setDialog] = useState<{ page?: PageSummary } | null>(null);
  const [confirm, setConfirm] = useState<PageSummary | null>(null);
  const [q, setQ] = useState('');
  const list = pages.filter((p) => !q || `${p.title} ${p.path}`.toLowerCase().includes(q.toLowerCase()));

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      await actions.reloadPages();
      toast.success(ok);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  return (
    <div className="panel">
      <div className="panel-head">
        <div className="panel-title-row">
          <h2>Pages</h2>
          <button className="btn sm primary" onClick={() => setDialog({})}>
            <Icon name="plus" size={14} /> New page
          </button>
        </div>
        {pages.length > 6 && (
          <div className="search-box">
            <Icon name="search" size={15} />
            <input className="input" type="search" aria-label="Filter pages" placeholder="Filter pages" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
        )}
      </div>
      <div className="panel-body">
        <ul className="page-list">
          {list.map((p) => (
            <li key={p.id} className={`page-item${p.id === pageId ? ' current' : ''}`}>
              <button className="page-main" aria-current={p.id === pageId ? 'page' : undefined} onClick={() => navigate({ name: 'editor', site, page: p.id })}>
                <Icon name={p.path === '/' ? 'home' : 'file'} size={15} />
                <span className="page-text">
                  <span className="page-title">{p.title}</span>
                  <span className="page-path">{p.path}</span>
                </span>
                <StatusBadge p={p} />
              </button>
              <details className="menu">
                <summary className="icon-btn sm" aria-label={`More actions for ${p.title}`}>
                  <Icon name="dots" size={15} />
                </summary>
                <div className="menu-pop" role="menu">
                  <button role="menuitem" onClick={(e) => ((e.currentTarget.closest('details') as HTMLDetailsElement).open = false, setDialog({ page: p }))}>
                    <Icon name="edit" size={14} /> Rename / change URL
                  </button>
                  <button role="menuitem" onClick={(e) => ((e.currentTarget.closest('details') as HTMLDetailsElement).open = false, run(() => post(pagesPath(site, `/pages/${p.id}/duplicate`)), 'Page duplicated'))}>
                    <Icon name="copy" size={14} /> Duplicate
                  </button>
                  {p.status === 'published' ? (
                    <button role="menuitem" onClick={(e) => ((e.currentTarget.closest('details') as HTMLDetailsElement).open = false, run(() => post(pagesPath(site, `/pages/${p.id}/unpublish`)), 'Page set to draft'))}>
                      <Icon name="eye" size={14} /> Unpublish (set as draft)
                    </button>
                  ) : (
                    <button
                      role="menuitem"
                      onClick={(e) => {
                        (e.currentTarget.closest('details') as HTMLDetailsElement).open = false;
                        run(async () => {
                          if (p.id === pageId) await actions.flushDraft();
                          await post(pagesPath(site, `/pages/${p.id}/publish`));
                        }, 'Page published');
                      }}
                    >
                      <Icon name="rocket" size={14} /> Publish
                    </button>
                  )}
                  <a role="menuitem" href={`/s/${site}${p.path === '/' ? '' : p.path}${p.status === 'published' ? '' : '?preview=draft'}`} target="_blank" rel="noreferrer">
                    <Icon name="external" size={14} /> Open {p.status === 'published' ? 'live page' : 'preview'}
                  </a>
                  <button role="menuitem" className="danger" disabled={p.path === '/'} onClick={(e) => ((e.currentTarget.closest('details') as HTMLDetailsElement).open = false, setConfirm(p))}>
                    <Icon name="trash" size={14} /> Delete
                  </button>
                </div>
              </details>
            </li>
          ))}
        </ul>
      </div>
      {dialog && <PageDialog page={dialog.page} onClose={() => setDialog(null)} />}
      {confirm && (
        <Dialog
          title={`Delete “${confirm.title}”?`}
          onClose={() => setConfirm(null)}
          footer={
            <>
              <button className="btn ghost" onClick={() => setConfirm(null)}>
                Cancel
              </button>
              <button
                className="btn danger"
                onClick={async () => {
                  const p = confirm;
                  setConfirm(null);
                  await run(() => del(pagesPath(site, `/pages/${p.id}`)), 'Page deleted');
                  if (p.id === pageId) {
                    const home = editor.get().pages.find((x) => x.path === '/') ?? editor.get().pages[0];
                    navigate({ name: 'editor', site, page: home?.id }, true);
                  }
                }}
              >
                Delete page
              </button>
            </>
          }
        >
          <p>
            The page at <code>{confirm.path}</code> and its revision history will be permanently removed.
          </p>
        </Dialog>
      )}
    </div>
  );
}
