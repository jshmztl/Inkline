import { state } from './core.js';

function workspacePayload() {
  return state.workspace?.payload ?? null;
}

function contentCollections() {
  const payload = workspacePayload();
  return payload && Array.isArray(payload.collections) ? payload.collections : [];
}

function contentRequests() {
  const payload = workspacePayload();
  return payload && Array.isArray(payload.requests) ? payload.requests : [];
}

function contentDocuments() {
  const payload = workspacePayload();
  return payload && payload.documents && typeof payload.documents === 'object'
    ? payload.documents
    : {};
}

function contentCollection(id) {
  return contentCollections().find((item) => item.id === id) || null;
}

function contentRequest(id) {
  return contentRequests().find((item) => item.id === id) || null;
}

function contentDocument(requestId) {
  const docs = contentDocuments()[requestId];
  return Array.isArray(docs) ? docs : [];
}

export { workspacePayload, contentCollections, contentRequests, contentDocuments, contentCollection, contentRequest, contentDocument };
