import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorMessage, get, sitePath } from '../api.ts';
import { Dialog } from '../ui/Dialog.tsx';
import { Empty, Spinner } from '../ui/controls.tsx';
import { Icon } from '../ui/Icon.tsx';
import { toast } from '../ui/toast.ts';
import { editor } from './state.ts';

interface Asset {
  id: string;
  filename: string;
  url: string;
  mime: string;
  width?: number | null;
  height?: number | null;
  alt?: string;
}

export async function uploadMedia(site: string, file: File): Promise<Asset> {
  const fd = new FormData();
  fd.append('file', file);
  return api<Asset>('POST', sitePath(site, '/media'), fd);
}

/** Media library: browse, search, upload (button or drop) and pick an asset. */
export function MediaPicker({ onPick, onClose, accept = 'image/*' }: { onPick: (a: Asset) => void; onClose: () => void; accept?: string }) {
  const site = editor.get().site;
  const [items, setItems] = useState<Asset[] | null>(null);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      setItems(await get<Asset[]>(sitePath(site, `/m/media/assets${q ? `?q=${encodeURIComponent(q)}` : ''}`)));
    } catch (e) {
      toast.error(errorMessage(e));
      setItems([]);
    }
  }, [site, q]);
  useEffect(() => {
    const t = setTimeout(load, q ? 200 : 0);
    return () => clearTimeout(t);
  }, [load, q]);

  const upload = async (files: FileList | File[]) => {
    setBusy(true);
    try {
      let lastAsset: Asset | null = null;
      for (const f of Array.from(files)) lastAsset = await uploadMedia(site, f);
      await load();
      if (lastAsset && Array.from(files).length === 1) toast.success(`Uploaded ${lastAsset.filename}`);
    } catch (e) {
      toast.error(`Upload failed: ${errorMessage(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const images = (items ?? []).filter((a) => accept !== 'image/*' || a.mime.startsWith('image/'));
  return (
    <Dialog
      title="Media library"
      onClose={onClose}
      wide
      footer={
        <>
          <input ref={fileRef} type="file" accept={accept} multiple hidden onChange={(e) => e.target.files && upload(e.target.files)} />
          <button className="btn" onClick={() => fileRef.current?.click()} disabled={busy}>
            <Icon name="upload" size={16} /> {busy ? 'Uploading…' : 'Upload'}
          </button>
          <span className="grow" />
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
        </>
      }
    >
      <div
        className={`media-drop${over ? ' over' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          if (e.dataTransfer.files.length) upload(e.dataTransfer.files);
        }}
      >
        <div className="search-box">
          <Icon name="search" size={15} />
          <input className="input" placeholder="Search media" aria-label="Search media" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        {items === null ? (
          <div className="center-pad">
            <Spinner />
          </div>
        ) : images.length === 0 ? (
          <Empty>
            <Icon name="image" size={28} />
            <p>No media yet. Drop files here or use Upload.</p>
          </Empty>
        ) : (
          <ul className="media-grid" role="listbox" aria-label="Media assets">
            {images.map((a) => (
              <li key={a.id}>
                <button className="media-item" role="option" aria-selected={false} onClick={() => onPick(a)} title={a.filename}>
                  {a.mime.startsWith('image/') ? <img src={a.url} alt={a.alt || a.filename} loading="lazy" /> : <Icon name="file" size={28} />}
                  <span>{a.filename}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Dialog>
  );
}
