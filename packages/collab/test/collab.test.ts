import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import type { PageNode } from '@modulo/core';
import { keyBetween, loadTree, readTree, Room, yInsert, yMove, yRemove, ySetProps, ySetStyle, type Conn } from '../src/index.ts';

const tree: PageNode = {
  id: 'root',
  type: 'core:page',
  props: {},
  slots: {
    default: [
      { id: 'a', type: 'core:heading', props: { text: 'A', level: 'h1' } },
      { id: 's', type: 'core:section', props: {}, slots: { default: [{ id: 'b', type: 'core:text', props: { html: 'B' } }] } },
    ],
  },
};

function sync(a: Y.Doc, b: Y.Doc) {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
}

describe('fractional keys', () => {
  it('always produce strictly ordered keys', () => {
    const keys: string[] = [];
    let lo = '';
    for (let i = 0; i < 200; i++) {
      const k = keyBetween(lo, keys[0] ?? null);
      keys.unshift(k); // always insert at start
      if (keys.length > 1) expect(keys[0]! < keys[1]!).toBe(true);
    }
    let a = 'V';
    let b = 'W';
    for (let i = 0; i < 100; i++) {
      const m = keyBetween(a, b);
      expect(a < m && m < b).toBe(true);
      b = m;
    }
  });
});

describe('ytree', () => {
  it('round-trips a tree', () => {
    const doc = new Y.Doc();
    loadTree(doc, tree);
    expect(readTree(doc)).toEqual(tree);
  });

  it('merges concurrent edits to different props and moves', () => {
    const d1 = new Y.Doc();
    loadTree(d1, tree);
    const d2 = new Y.Doc();
    sync(d1, d2);
    ySetProps(d1, 'a', { text: 'Edited by one' });
    ySetProps(d2, 'a', { level: 'h2' });
    yMove(d2, 'b', 'root', 'default', 0);
    ySetStyle(d1, 'a', { padding: 'token:space.lg' }, 'sm');
    sync(d1, d2);
    const t1 = readTree(d1)!;
    expect(t1).toEqual(readTree(d2));
    expect(t1.slots!.default!.map((n) => n.id)).toEqual(['b', 'a', 's']);
    expect(t1.slots!.default![1]).toMatchObject({ props: { text: 'Edited by one', level: 'h2' }, responsive: { sm: { padding: 'token:space.lg' } } });
  });

  it('handles concurrent inserts at the same index deterministically and subtree removal', () => {
    const d1 = new Y.Doc();
    loadTree(d1, tree);
    const d2 = new Y.Doc();
    sync(d1, d2);
    yInsert(d1, { id: 'x1', type: 'core:divider', props: {} }, 'root', 'default', 1);
    yInsert(d2, { id: 'x2', type: 'core:divider', props: {} }, 'root', 'default', 1);
    yRemove(d1, 's');
    sync(d1, d2);
    expect(readTree(d1)).toEqual(readTree(d2));
    const ids = readTree(d1)!.slots!.default!.map((n) => n.id);
    expect(ids).toEqual(['a', 'x1', 'x2']);
    expect(d1.getMap('nodes').has('b')).toBe(false);
  });

  it('survives concurrent moves that would create a cycle', () => {
    const t: PageNode = { id: 'root', type: 'core:page', props: {}, slots: { default: [{ id: 'p', type: 'core:section', props: {}, slots: { default: [] } }, { id: 'q', type: 'core:section', props: {}, slots: { default: [] } }] } };
    const d1 = new Y.Doc();
    loadTree(d1, t);
    const d2 = new Y.Doc();
    sync(d1, d2);
    yMove(d1, 'p', 'q', 'default', 0);
    yMove(d2, 'q', 'p', 'default', 0);
    sync(d1, d2);
    const r = readTree(d1)!;
    expect(r).toEqual(readTree(d2));
    expect(r.slots!.default).toEqual([]); // both detached into a cycle: unreachable, not an infinite loop
  });
});

describe('room protocol', () => {
  it('syncs two clients through a room', async () => {
    let saved = 0;
    const room = new Room('page', () => saved++);
    loadTree(room.doc, tree);
    const docs = [new Y.Doc(), new Y.Doc()];
    const conns: Conn[] = [];
    // Wire client docs to the room using the same message format as the provider.
    const { CollabProvider } = await import('../src/protocol.ts');
    class FakeWS {
      readyState = 1;
      binaryType = 'arraybuffer';
      onopen?: () => void;
      onmessage?: (e: any) => void;
      onclose?: () => void;
      onerror?: () => void;
      conn: Conn;
      constructor() {
        this.conn = { id: conns.length, send: (d) => queueMicrotask(() => this.onmessage?.({ data: d.slice().buffer })) };
        conns.push(this.conn);
        room.join(this.conn);
        queueMicrotask(() => this.onopen?.());
      }
      send(d: Uint8Array) {
        room.handle(this.conn, d);
      }
      close() {
        room.leave(this.conn);
      }
    }
    const p1 = new CollabProvider('ws://x', docs[0]!, { WebSocketImpl: FakeWS });
    const p2 = new CollabProvider('ws://x', docs[1]!, { WebSocketImpl: FakeWS });
    await new Promise((r) => setTimeout(r, 20));
    expect(readTree(docs[0]!)).toEqual(tree);
    ySetProps(docs[0]!, 'a', { text: 'live' });
    p2.awareness.setLocalStateField('user', { name: 'Bo' });
    await new Promise((r) => setTimeout(r, 20));
    expect(readTree(docs[1]!)!.slots!.default![0]!.props.text).toBe('live');
    expect(readTree(room.doc)!.slots!.default![0]!.props.text).toBe('live');
    expect([...p1.awareness.getStates().values()].some((s: any) => s.user?.name === 'Bo')).toBe(true);
    expect(saved).toBeGreaterThan(0);
    p1.destroy();
    p2.destroy();
    room.destroy();
  });
});
