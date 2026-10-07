import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';

/** Wire protocol compatible with y-websocket: [varUint type][payload]. */
export const MSG_SYNC = 0;
export const MSG_AWARENESS = 1;

export interface Conn {
  id: number;
  send(data: Uint8Array): void;
  /** Awareness client ids controlled by this connection. */
  clients?: Set<number>;
}

/**
 * Server-side room for one document: applies sync messages, fans out updates
 * and awareness (cursors/selection) to every other connection.
 */
export class Room {
  readonly doc = new Y.Doc();
  readonly awareness = new awarenessProtocol.Awareness(this.doc);
  readonly conns = new Set<Conn>();
  private onUpdate: (update: Uint8Array, origin: unknown) => void;

  constructor(readonly name: string, onChange?: (doc: Y.Doc) => void) {
    this.awareness.setLocalState(null);
    this.onUpdate = (update, origin) => {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_SYNC);
      syncProtocol.writeUpdate(enc, update);
      const msg = encoding.toUint8Array(enc);
      for (const c of this.conns) if (c !== origin) c.send(msg);
      if (origin !== 'load') onChange?.(this.doc);
    };
    this.doc.on('update', this.onUpdate);
    this.awareness.on('update', ({ added, updated, removed }: any, origin: any) => {
      const changed = [...added, ...updated, ...removed];
      if (origin && (origin as Conn).clients) {
        for (const id of added) (origin as Conn).clients!.add(id);
        for (const id of removed) (origin as Conn).clients!.delete(id);
      }
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_AWARENESS);
      encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed));
      const msg = encoding.toUint8Array(enc);
      for (const c of this.conns) c.send(msg);
    });
  }

  join(conn: Conn) {
    conn.clients ??= new Set();
    this.conns.add(conn);
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeSyncStep1(enc, this.doc);
    conn.send(encoding.toUint8Array(enc));
    const states = [...this.awareness.getStates().keys()];
    if (states.length) {
      const a = encoding.createEncoder();
      encoding.writeVarUint(a, MSG_AWARENESS);
      encoding.writeVarUint8Array(a, awarenessProtocol.encodeAwarenessUpdate(this.awareness, states));
      conn.send(encoding.toUint8Array(a));
    }
  }

  leave(conn: Conn) {
    this.conns.delete(conn);
    if (conn.clients?.size) awarenessProtocol.removeAwarenessStates(this.awareness, [...conn.clients], null);
  }

  handle(conn: Conn, data: Uint8Array, opts: { readOnly?: boolean } = {}) {
    const dec = decoding.createDecoder(data);
    const type = decoding.readVarUint(dec);
    if (type === MSG_SYNC) {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_SYNC);
      if (opts.readOnly) {
        // Answer step1 (send our state) but ignore incoming updates.
        const sub = decoding.readVarUint(dec);
        if (sub === syncProtocol.messageYjsSyncStep1) syncProtocol.writeSyncStep2(enc, this.doc, decoding.readVarUint8Array(dec));
      } else syncProtocol.readSyncMessage(dec, enc, this.doc, conn);
      if (encoding.length(enc) > 1) conn.send(encoding.toUint8Array(enc));
    } else if (type === MSG_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(dec), conn);
    }
  }

  destroy() {
    this.doc.off('update', this.onUpdate);
    this.awareness.destroy();
    this.doc.destroy();
  }
}

export interface ProviderOptions {
  /** WebSocket constructor (browser global by default; pass `ws` in Node). */
  WebSocketImpl?: any;
  onStatus?: (status: 'connecting' | 'connected' | 'disconnected') => void;
  onSynced?: () => void;
}

/** Minimal client provider (browser or Node) with reconnect + awareness. */
export class CollabProvider {
  readonly awareness: awarenessProtocol.Awareness;
  private ws: any = null;
  private closed = false;
  private retry = 0;
  synced = false;
  private onDocUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === this) return;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeUpdate(enc, update);
    this.send(encoding.toUint8Array(enc));
  };
  private onAwareness = ({ added, updated, removed }: any, origin: unknown) => {
    if (origin === this) return;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_AWARENESS);
    encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(this.awareness, [...added, ...updated, ...removed]));
    this.send(encoding.toUint8Array(enc));
  };

  constructor(
    readonly url: string,
    readonly doc: Y.Doc,
    private opts: ProviderOptions = {},
  ) {
    this.awareness = new awarenessProtocol.Awareness(doc);
    doc.on('update', this.onDocUpdate);
    this.awareness.on('update', this.onAwareness);
    this.connect();
  }

  private send(data: Uint8Array) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(data);
  }

  private connect() {
    if (this.closed) return;
    const WS = this.opts.WebSocketImpl ?? (globalThis as any).WebSocket;
    this.opts.onStatus?.('connecting');
    const ws = new WS(this.url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.opts.onStatus?.('connected');
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_SYNC);
      syncProtocol.writeSyncStep1(enc, this.doc);
      this.send(encoding.toUint8Array(enc));
      if (this.awareness.getLocalState() !== null) {
        const a = encoding.createEncoder();
        encoding.writeVarUint(a, MSG_AWARENESS);
        encoding.writeVarUint8Array(a, awarenessProtocol.encodeAwarenessUpdate(this.awareness, [this.doc.clientID]));
        this.send(encoding.toUint8Array(a));
      }
    };
    ws.onmessage = (ev: any) => {
      const data = new Uint8Array(ev.data as ArrayBuffer);
      const dec = decoding.createDecoder(data);
      const type = decoding.readVarUint(dec);
      if (type === MSG_SYNC) {
        const enc = encoding.createEncoder();
        encoding.writeVarUint(enc, MSG_SYNC);
        const sub = syncProtocol.readSyncMessage(dec, enc, this.doc, this);
        if (encoding.length(enc) > 1) this.send(encoding.toUint8Array(enc));
        if (sub === syncProtocol.messageYjsSyncStep2 && !this.synced) {
          this.synced = true;
          this.opts.onSynced?.();
        }
      } else if (type === MSG_AWARENESS) {
        awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(dec), this);
      }
    };
    ws.onclose = () => {
      this.opts.onStatus?.('disconnected');
      if (this.closed) return;
      const delay = Math.min(1000 * 2 ** this.retry++, 15000);
      setTimeout(() => this.connect(), delay);
    };
    ws.onerror = () => ws.close();
  }

  destroy() {
    this.closed = true;
    awarenessProtocol.removeAwarenessStates(this.awareness, [this.doc.clientID], 'destroy');
    this.doc.off('update', this.onDocUpdate);
    this.awareness.off('update', this.onAwareness);
    this.ws?.close();
  }
}
