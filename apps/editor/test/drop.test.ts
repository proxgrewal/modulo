import { describe, expect, it } from 'vitest';
import { detectFlow, gridTrackCount, indicatorFor, insertionIndex, layerDropZone, resolveDrop, type Rect, type SlotGeom } from '../src/lib/drop.ts';

const r = (left: number, top: number, w: number, h: number): Rect => ({ left, top, right: left + w, bottom: top + h });

describe('insertionIndex', () => {
  const col = [r(0, 0, 100, 40), r(0, 50, 100, 40), r(0, 100, 100, 40)];
  it('column flow: before the first child whose midpoint is below the pointer', () => {
    expect(insertionIndex(col, { x: 10, y: 5 }, 'column')).toBe(0);
    expect(insertionIndex(col, { x: 10, y: 25 }, 'column')).toBe(1);
    expect(insertionIndex(col, { x: 10, y: 69 }, 'column')).toBe(1);
  });
  it('column flow: after the last child', () => {
    expect(insertionIndex(col, { x: 10, y: 130 }, 'column')).toBe(3);
    expect(insertionIndex([], { x: 0, y: 0 }, 'column')).toBe(0);
  });
  it('row flow with wrapping lines (grid)', () => {
    // 2x2 grid: [0][1] / [2][3]
    const grid = [r(0, 0, 100, 50), r(110, 0, 100, 50), r(0, 60, 100, 50), r(110, 60, 100, 50)];
    expect(insertionIndex(grid, { x: 20, y: 20 }, 'row')).toBe(0);
    expect(insertionIndex(grid, { x: 80, y: 20 }, 'row')).toBe(1);
    expect(insertionIndex(grid, { x: 200, y: 20 }, 'row')).toBe(2); // end of first line
    expect(insertionIndex(grid, { x: 170, y: 80 }, 'row')).toBe(4);
    expect(insertionIndex(grid, { x: 120, y: 80 }, 'row')).toBe(3);
  });
});

describe('detectFlow', () => {
  it('reads flex direction and grid tracks', () => {
    expect(detectFlow({ display: 'flex', flexDirection: 'row' })).toBe('row');
    expect(detectFlow({ display: 'flex', flexDirection: 'column' })).toBe('column');
    expect(detectFlow({ display: 'inline-flex', flexDirection: 'row-reverse' })).toBe('row');
    expect(detectFlow({ display: 'grid', gridTemplateColumns: '200px 200px 200px' })).toBe('row');
    expect(detectFlow({ display: 'grid', gridTemplateColumns: 'repeat(1, minmax(0px, 1fr))' })).toBe('column');
    expect(detectFlow({ display: 'grid', gridTemplateColumns: 'none' })).toBe('column');
    expect(detectFlow({ display: 'block' })).toBe('column');
  });
  it('falls back to child positions', () => {
    expect(detectFlow(null, [r(0, 0, 50, 20), r(60, 0, 50, 20)])).toBe('row');
    expect(detectFlow(null, [r(0, 0, 50, 20), r(0, 30, 50, 20)])).toBe('column');
  });
});

describe('gridTrackCount', () => {
  it('counts top-level tracks', () => {
    expect(gridTrackCount('200px 200px 200px')).toBe(3);
    expect(gridTrackCount('minmax(0px, 1fr) minmax(0px, 1fr)')).toBe(2);
    expect(gridTrackCount('repeat(3, minmax(0, 1fr))')).toBe(3);
    expect(gridTrackCount('none')).toBe(0);
  });
});

describe('indicatorFor', () => {
  it('draws a horizontal line between stacked children', () => {
    const kids = [r(0, 0, 100, 40), r(0, 60, 100, 40)];
    const ind = indicatorFor(kids, 1, 'column', r(0, 0, 100, 100), null);
    expect(ind.kind).toBe('line');
    expect(ind.orientation).toBe('horizontal');
    expect((ind.rect.top + ind.rect.bottom) / 2).toBe(50);
  });
  it('draws a vertical line in rows and a box for empty slots', () => {
    const kids = [r(0, 0, 100, 40), r(120, 0, 100, 40)];
    const ind = indicatorFor(kids, 1, 'row', r(0, 0, 220, 40), null);
    expect(ind.orientation).toBe('vertical');
    expect((ind.rect.left + ind.rect.right) / 2).toBe(110);
    expect(indicatorFor([], 0, 'column', r(0, 0, 10, 10), r(5, 5, 50, 56)).kind).toBe('box');
  });
});

describe('resolveDrop', () => {
  // Page (root) contains: section S1 (y 0-200) with a heading + grid G (y 60-180, 2 columns), and section S2 (y 220-400, empty slot).
  const slots: SlotGeom[] = [
    { parentId: 'root', parentType: 'core:page', slot: 'default', ancestors: ['root'], depth: 1, parentRect: r(0, 0, 800, 400), emptyRect: null, flow: 'column', children: [{ id: 'S1', rect: r(0, 0, 800, 200) }, { id: 'S2', rect: r(0, 220, 800, 180) }] },
    { parentId: 'S1', parentType: 'core:section', slot: 'default', ancestors: ['root', 'S1'], depth: 2, parentRect: r(0, 0, 800, 200), emptyRect: null, flow: 'column', children: [{ id: 'H', rect: r(100, 20, 600, 30) }, { id: 'G', rect: r(100, 60, 600, 120) }] },
    { parentId: 'G', parentType: 'core:grid', slot: 'default', ancestors: ['root', 'S1', 'G'], depth: 3, parentRect: r(100, 60, 600, 120), emptyRect: null, flow: 'row', children: [{ id: 'C1', rect: r(100, 60, 290, 120) }, { id: 'C2', rect: r(410, 60, 290, 120) }] },
    { parentId: 'S2', parentType: 'core:section', slot: 'default', ancestors: ['root', 'S2'], depth: 2, parentRect: r(0, 220, 800, 180), emptyRect: r(100, 280, 600, 56), flow: 'column', children: [] },
  ];
  const any = { accepts: () => true };

  it('picks the deepest slot under the pointer and the index inside it', () => {
    const t = resolveDrop(slots, { x: 600, y: 120 }, any)!;
    expect(t.parentId).toBe('G');
    expect(t.index).toBe(2); // right half of C2
    expect(t.indicator.orientation).toBe('vertical');
  });

  it('drops into an empty slot with a box indicator', () => {
    const t = resolveDrop(slots, { x: 300, y: 300 }, any)!;
    expect(t).toMatchObject({ parentId: 'S2', slot: 'default', index: 0 });
    expect(t.indicator.kind).toBe('box');
  });

  it('respects slot allow lists by skipping slots that refuse the block', () => {
    const t = resolveDrop(slots, { x: 600, y: 120 }, { accepts: (s) => s.parentType !== 'core:grid' })!;
    expect(t.parentId).toBe('S1');
    expect(t.index).toBe(2); // after the grid (pointer below its midpoint)
  });

  it('prefers the enclosing slot near a container edge (drop between sections)', () => {
    const t = resolveDrop(slots, { x: 400, y: 3 }, any)!;
    expect(t.parentId).toBe('root');
    expect(t.index).toBe(0);
    const t2 = resolveDrop(slots, { x: 400, y: 397 }, any)!;
    expect(t2.parentId).toBe('root');
    expect(t2.index).toBe(2);
  });

  it('never targets the dragged subtree and ignores the dragged node when indexing', () => {
    const t = resolveDrop(slots, { x: 600, y: 120 }, { accepts: () => true, draggedId: 'G' })!;
    expect(t.parentId).toBe('S1');
    // Children without G: [H] -> pointer is below H's midpoint
    expect(t.index).toBe(1);
  });

  it('returns null outside every slot', () => {
    expect(resolveDrop(slots, { x: 900, y: 900 }, any)).toBeNull();
    expect(resolveDrop(slots, { x: 10, y: 10 }, { accepts: () => false })).toBeNull();
  });
});

describe('layerDropZone', () => {
  it('splits rows into before / inside / after', () => {
    expect(layerDropZone(100, 28, 102, true)).toBe('before');
    expect(layerDropZone(100, 28, 114, true)).toBe('inside');
    expect(layerDropZone(100, 28, 126, true)).toBe('after');
    expect(layerDropZone(100, 28, 114, false)).toBe('after');
    expect(layerDropZone(100, 28, 110, false)).toBe('before');
  });
});
