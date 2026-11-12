export interface CollectionNode<T> {
  item: T;
  depth: number;
}

interface TreeItem {
  id: string;
  parentId?: string | null;
}

/**
 * 把扁平集合列表整理为深度优先的树形顺序。
 * 父集合折叠时，其全部后代不会出现在结果中。
 */
export function buildCollectionTree<T extends TreeItem>(
  items: T[],
  collapsed: Record<string, boolean> = {},
): CollectionNode<T>[] {
  const known = new Set(items.map((item) => item.id));
  const byParent = new Map<string, T[]>();
  for (const item of items) {
    const key = item.parentId && known.has(item.parentId) ? item.parentId : '';
    const list = byParent.get(key) ?? [];
    list.push(item);
    byParent.set(key, list);
  }

  const result: CollectionNode<T>[] = [];
  const visit = (parentId: string, depth: number) => {
    for (const item of byParent.get(parentId) ?? []) {
      if (!isHiddenByCollapsed(item, items, collapsed)) {
        result.push({ item, depth });
      }
      visit(item.id, depth + 1);
    }
  };
  visit('', 0);
  return result;
}

function isHiddenByCollapsed<T extends TreeItem>(
  item: T,
  items: T[],
  collapsed: Record<string, boolean>,
): boolean {
  const byId = new Map(items.map((entry) => [entry.id, entry]));
  let cursor = item.parentId ?? '';
  let guard = 0;
  while (cursor && guard < 100) {
    if (collapsed[cursor]) return true;
    cursor = byId.get(cursor)?.parentId ?? '';
    guard += 1;
  }
  return false;
}
