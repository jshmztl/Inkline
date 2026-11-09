import type { SavedRequest } from './api';

export interface MergeFieldDiff {
  field: string;
  label: string;
  base: string;
  local: string;
  remote: string;
}

export interface MergeConflict {
  id: string;
  name: string;
  local: SavedRequest;
  remote: SavedRequest;
  fields: MergeFieldDiff[];
}

export interface MergePlan {
  localChanges: SavedRequest[];
  remoteChanges: SavedRequest[];
  conflicts: MergeConflict[];
  identical: number;
}

const trackedFields: { key: keyof SavedRequest; label: string }[] = [
  { key: 'name', label: '名称' },
  { key: 'method', label: '方法' },
  { key: 'url', label: 'URL' },
  { key: 'headers', label: '请求头' },
  { key: 'body', label: 'Body' },
  { key: 'dataLevel', label: '分级' },
];

function serialize(value: unknown) {
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function fieldValue(request: SavedRequest, key: keyof SavedRequest) {
  return serialize(request[key]);
}

export function planThreeWayMerge(
  base: SavedRequest[],
  local: SavedRequest[],
  remote: SavedRequest[],
): MergePlan {
  const plan: MergePlan = {
    localChanges: [],
    remoteChanges: [],
    conflicts: [],
    identical: 0,
  };

  const ids = new Set([...local.map((item) => item.id), ...remote.map((item) => item.id)]);

  for (const id of ids) {
    const baseRequest = base.find((item) => item.id === id) ?? null;
    const localRequest = local.find((item) => item.id === id) ?? null;
    const remoteRequest = remote.find((item) => item.id === id) ?? null;

    if (localRequest && !remoteRequest) {
      plan.localChanges.push(localRequest);
      continue;
    }

    if (!localRequest && remoteRequest) {
      if (baseRequest) continue;
      plan.remoteChanges.push(remoteRequest);
      continue;
    }

    if (!localRequest || !remoteRequest) continue;

    const reference = baseRequest ?? remoteRequest;
    const diffs: MergeFieldDiff[] = [];

    for (const { key, label } of trackedFields) {
      const baseValue = fieldValue(reference, key);
      const localValue = fieldValue(localRequest, key);
      const remoteValue = fieldValue(remoteRequest, key);

      const localChanged = localValue !== baseValue;
      const remoteChanged = remoteValue !== baseValue;

      if (localChanged && remoteChanged && localValue !== remoteValue) {
        diffs.push({ field: key, label, base: baseValue, local: localValue, remote: remoteValue });
      }
    }

    if (diffs.length > 0) {
      plan.conflicts.push({
        id,
        name: localRequest.name || remoteRequest.name,
        local: localRequest,
        remote: remoteRequest,
        fields: diffs,
      });
      continue;
    }

    const localChanged = trackedFields.some(
      ({ key }) => fieldValue(localRequest, key) !== fieldValue(reference, key),
    );
    const remoteChanged = trackedFields.some(
      ({ key }) => fieldValue(remoteRequest, key) !== fieldValue(reference, key),
    );

    if (localChanged) plan.localChanges.push(localRequest);
    else if (remoteChanged) plan.remoteChanges.push(remoteRequest);
    else plan.identical += 1;
  }

  return plan;
}
