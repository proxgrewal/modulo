import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { loadTree, readTree, Room } from '@modulo/collab';
import { sessionUser, type Kernel } from '@modulo/kernel';
import type { PageCache } from './publish.ts';

/**
 * Real-time co-editing: one Yjs room per page at
 *   ws(s)://host/api/sites/:site/collab/:pageId
 * Joining requires pages.edit (viewers join read-only). The room is seeded from
 * the page draft and persisted back (validated) after edits settle.
 */
interface RoomState {
  room: Room;
  siteId: string;
  pageId: string;
  timer: ReturnType<typeof setTimeout> | null;
  lastSaved: string;
  saving: Promise<void> | null;
}

export function attachCollab(server: Server, kernel: Kernel, opts: { saveDelayMs?: number; cache?: PageCache } = {}) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
  const rooms = new Map<string, RoomState>();
  const saveDelay = opts.saveDelayMs ?? 800;
  let connId = 0;

  async function persist(state: RoomState) {
    const tree = readTree(state.room.doc);
    if (!tree) return;
    const snapshot = JSON.stringify(tree);
    if (snapshot === state.lastSaved) return;
    try {
      const ctx = await kernel.context(state.siteId, null, { sudo: true });
      await ctx.service<any>('pages').saveDraft(state.pageId, tree);
      state.lastSaved = snapshot;
    } catch (e: any) {
      // Invalid intermediate states are not persisted; the next valid edit will be.
      console.warn(`[collab] not saved ${state.pageId}: ${e?.message}`);
    }
  }

  function schedule(state: RoomState) {
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      state.timer = null;
      state.saving = persist(state).finally(() => (state.saving = null));
    }, saveDelay);
  }

  async function getRoom(siteId: string, pageId: string): Promise<RoomState> {
    const key = `${siteId}:${pageId}`;
    const existing = rooms.get(key);
    if (existing) return existing;
    const ctx = await kernel.context(siteId, null, { sudo: true });
    const page = await ctx.repo('pages.page').get(pageId);
    const state: RoomState = { room: null as any, siteId, pageId, timer: null, lastSaved: JSON.stringify(page.draft), saving: null };
    state.room = new Room(key, () => schedule(state));
    loadTree(state.room.doc, page.draft);
    rooms.set(key, state);
    return state;
  }

  server.on('upgrade', async (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const m = /^\/api\/sites\/([^/]+)\/collab\/([0-9a-f-]{36})$/.exec(url.pathname);
    if (!m) return; // not ours (e.g. Vite HMR)
    try {
      const cookie = /(?:^|;\s*)modulo_session=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
      const token = url.searchParams.get('token') ?? (cookie ? decodeURIComponent(cookie) : null);
      const user = await sessionUser(kernel.db, token);
      if (!user) throw Object.assign(new Error('unauthorized'), { status: 401 });
      const ctx = await kernel.context(m[1]!, user.id);
      if (!ctx.user?.role && !ctx.user?.isSuperadmin) throw Object.assign(new Error('forbidden'), { status: 403 });
      const readOnly = !ctx.can('pages.edit');
      const state = await getRoom(ctx.site.id, m[2]!);
      wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
        const conn = { id: ++connId, send: (d: Uint8Array) => ws.readyState === 1 && ws.send(d) };
        state.room.join(conn);
        ws.on('message', (data: Buffer) => {
          try {
            state.room.handle(conn, new Uint8Array(data), { readOnly });
          } catch (e) {
            console.warn('[collab] bad message', e);
          }
        });
        ws.on('close', async () => {
          state.room.leave(conn);
          if (!state.room.conns.size) {
            if (state.timer) {
              clearTimeout(state.timer);
              state.timer = null;
            }
            await state.saving;
            await persist(state);
            if (!state.room.conns.size) {
              state.room.destroy();
              rooms.delete(`${state.siteId}:${state.pageId}`);
            }
          }
        });
      });
    } catch (e: any) {
      const status = e?.status ?? 404;
      socket.write(`HTTP/1.1 ${status} ${status === 401 ? 'Unauthorized' : status === 403 ? 'Forbidden' : 'Not Found'}\r\n\r\n`);
      socket.destroy();
    }
  });

  return {
    rooms,
    async flush() {
      for (const s of rooms.values()) {
        if (s.timer) clearTimeout(s.timer);
        await s.saving;
        await persist(s);
      }
    },
    close() {
      wss.close();
    },
  };
}
