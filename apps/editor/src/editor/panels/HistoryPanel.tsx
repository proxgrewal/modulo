import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage, get, pagesPath, post, sitePath } from '../../api.ts';
import { replacePageOps } from '../../lib/commands.ts';
import { useStore } from '../../lib/store.ts';
import { cloneWithNewIds } from '../../lib/tree.ts';
import type { RenderResult, Revision } from '../../types.ts';
import { Dialog } from '../../ui/Dialog.tsx';
import { Empty, Spinner } from '../../ui/controls.tsx';
import { Icon } from '../../ui/Icon.tsx';
import { toast } from '../../ui/toast.ts';
import { actions, editor } from '../state.ts';

function PreviewFrame({ rev }: { rev: Revision }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    const site = editor.get().site;
    post<RenderResult>(sitePath(site, '/render'), { tree: rev.tree, layout: true })
      .then((r) => {
        const doc = ref.current?.contentDocument;
        if (!doc) return;
        doc.open();
        doc.write(`<!doctype html><html><head><meta charset="utf-8"><style>${r.css}</style><style>m-slot{display:contents}iframe{pointer-events:none}</style></head><body>${r.html}</body></html>`);
        doc.close();
        doc.addEventListener('click', (e) => e.preventDefault(), true);
      })
      .catch((e) => setErr(errorMessage(e)));
  }, [rev]);
  return err ? <p className="form-error">{err}</p> : <iframe ref={ref} className="preview-frame" title={`Revision from ${new Date(rev.created_at).toLocaleString()}`} />;
}

export function HistoryPanel() {
  const site = useStore(editor, (s) => s.site);
  const pageId = useStore(editor, (s) => s.pageId);
  const [revs, setRevs] = useState<Revision[] | null>(null);
  const [preview, setPreview] = useState<Revision | null>(null);
  const load = useCallback(async () => {
    if (!pageId) return;
    try {
      const list = await get<Revision[]>(pagesPath(site, `/pages/${pageId}/revisions`));
      setRevs(list.sort((a, b) => b.created_at.localeCompare(a.created_at)));
    } catch (e) {
      toast.error(errorMessage(e));
      setRevs([]);
    }
  }, [site, pageId]);
  useEffect(() => {
    setRevs(null);
    load();
  }, [load]);

  const open = async (r: Revision) => {
    try {
      setPreview(await get<Revision>(pagesPath(site, `/pages/${pageId}/revisions/${r.id}`)));
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const restore = async (r: Revision) => {
    const full = r.tree ? r : await get<Revision>(pagesPath(site, `/pages/${pageId}/revisions/${r.id}`));
    const tree = editor.get().tree;
    if (!tree || !full.tree) return;
    // Restore through the live document so collaborators see it and it is undoable;
    // the server's restore endpoint would be overwritten by the open collab room.
    const nodes = (full.tree.slots?.default ?? []).map((n) => cloneWithNewIds(n));
    actions.apply(replacePageOps(tree, nodes), null);
    setPreview(null);
    toast.success('Revision restored. Press Ctrl+Z to undo.');
  };

  return (
    <div className="panel">
      <div className="panel-head">
        <div className="panel-title-row">
          <h2>History</h2>
          <button className="icon-btn" aria-label="Refresh revisions" onClick={load}>
            <Icon name="refresh" size={15} />
          </button>
        </div>
        <p className="muted small">Autosaves every few minutes while you edit, plus every publish.</p>
      </div>
      <div className="panel-body">
        {!revs ? (
          <div className="center-pad">
            <Spinner />
          </div>
        ) : revs.length === 0 ? (
          <Empty>No revisions yet.</Empty>
        ) : (
          <ol className="rev-list">
            {revs.map((r) => (
              <li key={r.id} className="rev">
                <span className={`rev-dot ${r.kind}`} aria-hidden="true" />
                <div className="rev-text">
                  <strong>{r.kind === 'publish' ? 'Published' : r.kind === 'autosave' ? 'Autosave' : 'Saved'}</strong>
                  <span className="muted small">
                    {new Date(r.created_at).toLocaleString()} {r.author ? `· ${r.author}` : ''}
                  </span>
                  {r.note && <span className="small">{r.note}</span>}
                </div>
                <button className="btn sm ghost" onClick={() => open(r)}>
                  Preview
                </button>
              </li>
            ))}
          </ol>
        )}
      </div>
      {preview && (
        <Dialog
          title={`Revision · ${new Date(preview.created_at).toLocaleString()}`}
          onClose={() => setPreview(null)}
          wide
          footer={
            <>
              <button className="btn ghost" onClick={() => setPreview(null)}>
                Close
              </button>
              <button className="btn primary" onClick={() => restore(preview)}>
                Restore this version
              </button>
            </>
          }
        >
          <PreviewFrame rev={preview} />
        </Dialog>
      )}
    </div>
  );
}
