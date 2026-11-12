import { saveCollection, saveRequest } from './api';
import { writeRemoteDocuments, type TeamSnapshot } from './team';

/**
 * 把服务端快照应用到本机工作区。
 * 只做增量写入与文档覆盖，不删除本机额外请求，避免首次接入时丢失本地数据。
 */
export async function applySnapshotToWorkspace(snapshot: TeamSnapshot): Promise<void> {
  for (const collection of snapshot.collections ?? []) {
    await saveCollection(collection);
  }

  for (const request of snapshot.requests) {
    await saveRequest(request);
  }

  writeRemoteDocuments(snapshot.documents ?? {});
}
