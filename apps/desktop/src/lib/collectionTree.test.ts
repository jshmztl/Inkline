import { describe, expect, it } from 'vitest';
import { buildCollectionTree } from './collectionTree';

interface Item {
  id: string;
  parentId?: string | null;
  name: string;
}

const items: Item[] = [
  { id: 'a', name: 'A' },
  { id: 'b', parentId: 'a', name: 'A-1' },
  { id: 'c', parentId: 'b', name: 'A-1-1' },
  { id: 'd', name: 'D' },
  { id: 'orphan', parentId: 'missing', name: '孤儿子集合' },
];

describe('buildCollectionTree', () => {
  it('returns depth-first order with nested depth', () => {
    const nodes = buildCollectionTree(items);
    expect(nodes.map((node) => [node.item.id, node.depth])).toEqual([
      ['a', 0],
      ['b', 1],
      ['c', 2],
      ['d', 0],
      ['orphan', 0],
    ]);
  });

  it('hides descendants when an ancestor is collapsed', () => {
    const nodes = buildCollectionTree(items, { a: true });
    expect(nodes.map((node) => node.item.id)).toEqual(['a', 'd', 'orphan']);
  });

  it('hides children when a middle ancestor is collapsed', () => {
    const nodes = buildCollectionTree(items, { b: true });
    expect(nodes.map((node) => node.item.id)).toEqual(['a', 'b', 'd', 'orphan']);
    expect(nodes.find((node) => node.item.id === 'c')).toBeUndefined();
  });
});
