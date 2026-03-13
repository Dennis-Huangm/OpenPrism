import path from 'path';
import { promises as fs } from 'fs';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import { Awareness } from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { ensureDir, readJson, writeJson } from '../../utils/fsUtils.js';
import { COLLAB_FLUSH_DEBOUNCE_MS } from '../../config/constants.js';

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const MAX_WS_MESSAGE_BYTES = 2 * 1024 * 1024;

const docs = new Map();
const pendingDocs = new Map();
const evictedProjects = new Set();
const removingProjects = new Set();
const mutatingPaths = new Map();

function getProjectIdFromKey(key) {
  const separatorIndex = key.indexOf(':');
  return separatorIndex === -1 ? '' : key.slice(0, separatorIndex);
}

function getRelativePathFromKey(key) {
  const separatorIndex = key.indexOf(':');
  return separatorIndex === -1 ? '' : key.slice(separatorIndex + 1);
}

function isProjectEvicted(projectId) {
  return Boolean(projectId) && evictedProjects.has(projectId);
}

function isProjectRemoving(projectId) {
  return Boolean(projectId) && removingProjects.has(projectId);
}

function createProjectRemovedError(projectId) {
  const error = new Error(`Project removed: ${projectId}`);
  error.code = 'PROJECT_REMOVED';
  return error;
}

function createPathMutationError(targetPath) {
  const error = new Error(`Path mutating: ${targetPath}`);
  error.code = 'PATH_MUTATING';
  return error;
}

function readAwarenessClients(update) {
  try {
    const decoder = decoding.createDecoder(update);
    const count = decoding.readVarUint(decoder);
    const clients = [];
    for (let i = 0; i < count; i += 1) {
      const clientId = decoding.readVarUint(decoder);
      decoding.readVarUint(decoder);
      decoding.readVarString(decoder);
      clients.push(clientId);
    }
    return clients;
  } catch {
    return [];
  }
}

function sendMessage(conn, payload) {
  if (!conn?.socket || conn.socket.readyState !== 1) return;
  conn.socket.send(payload);
}

function broadcast(doc, payload, origin) {
  for (const conn of doc.conns) {
    if (origin && conn === origin) continue;
    sendMessage(conn, payload);
  }
}

function clearFlushTimer(doc) {
  if (doc.flushTimer) {
    clearTimeout(doc.flushTimer);
    doc.flushTimer = null;
  }
}

async function flushDoc(doc) {
  const projectId = getProjectIdFromKey(doc.key);
  const relativePath = getRelativePathFromKey(doc.key);
  if (isProjectEvicted(projectId) || isProjectRemoving(projectId) || isPathMutating(projectId, relativePath)) {
    doc.lastError = null;
    return;
  }
  const text = doc.text.toString();
  await ensureDir(path.dirname(doc.absPath));
  await fs.writeFile(doc.absPath, text, 'utf8');
  if (doc.metaPath) {
    try {
      const meta = await readJson(doc.metaPath);
      const next = { ...meta, updatedAt: new Date().toISOString() };
      await writeJson(doc.metaPath, next);
    } catch {
      // ignore
    }
  }
  doc.lastError = null;
}

function scheduleFlush(doc) {
  if (doc.flushTimer) return;
  doc.flushTimer = setTimeout(async () => {
    doc.flushTimer = null;
    try {
      await flushDoc(doc);
    } catch (err) {
      doc.lastError = String(err);
    }
  }, COLLAB_FLUSH_DEBOUNCE_MS);
}

function registerDocHandlers(doc) {
  doc.ydoc.on('update', (update, origin) => {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeUpdate(encoder, update);
    broadcast(doc, encoding.toUint8Array(encoder), origin);
    scheduleFlush(doc);
  });

  doc.awareness.on('update', ({ added, updated, removed }, origin) => {
    const update = awarenessProtocol.encodeAwarenessUpdate(
      doc.awareness,
      added.concat(updated).concat(removed)
    );
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(encoder, update);
    broadcast(doc, encoding.toUint8Array(encoder), origin);
  });
}

async function createDoc({ key, absPath, metaPath }) {
  const projectId = getProjectIdFromKey(key);
  const relativePath = getRelativePathFromKey(key);
  if (isProjectEvicted(projectId) || isProjectRemoving(projectId)) {
    throw createProjectRemovedError(projectId);
  }
  if (isPathMutating(projectId, relativePath)) {
    throw createPathMutationError(relativePath);
  }
  const ydoc = new Y.Doc();
  const awareness = new Awareness(ydoc);
  const text = ydoc.getText('content');
  let content = '';
  try {
    content = await fs.readFile(absPath, 'utf8');
  } catch {
    content = '';
  }
  if (text.length === 0 && content) {
    text.insert(0, content);
  }
  const doc = {
    key,
    absPath,
    metaPath,
    ydoc,
    awareness,
    text,
    conns: new Set(),
    flushTimer: null,
    lastError: null,
    cleanupTimer: null
  };
  registerDocHandlers(doc);
  if (isProjectEvicted(projectId) || isProjectRemoving(projectId)) {
    ydoc.destroy();
    throw createProjectRemovedError(projectId);
  }
  if (isPathMutating(projectId, relativePath)) {
    ydoc.destroy();
    throw createPathMutationError(relativePath);
  }
  const existing = docs.get(key);
  if (existing) {
    ydoc.destroy();
    return existing;
  }
  docs.set(key, doc);
  return doc;
}

export async function getOrCreateDoc({ key, absPath, metaPath }) {
  const existing = docs.get(key);
  if (existing) return existing;
  const pending = pendingDocs.get(key);
  if (pending) return pending;
  const creation = createDoc({ key, absPath, metaPath });
  pendingDocs.set(key, creation);
  try {
    return await creation;
  } finally {
    if (pendingDocs.get(key) === creation) {
      pendingDocs.delete(key);
    }
  }
}

export function setupConnection(doc, socket) {
  const conn = { socket, awarenessClientIds: new Set() };
  doc.conns.add(conn);
  if (doc.cleanupTimer) {
    clearTimeout(doc.cleanupTimer);
    doc.cleanupTimer = null;
  }

  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeSyncStep1(encoder, doc.ydoc);
  sendMessage(conn, encoding.toUint8Array(encoder));

  if (doc.awareness.getStates().size > 0) {
    const awarenessUpdate = awarenessProtocol.encodeAwarenessUpdate(
      doc.awareness,
      Array.from(doc.awareness.getStates().keys())
    );
    const awarenessEncoder = encoding.createEncoder();
    encoding.writeVarUint(awarenessEncoder, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(awarenessEncoder, awarenessUpdate);
    sendMessage(conn, encoding.toUint8Array(awarenessEncoder));
  }

  socket.on('message', (data) => {
    const projectId = getProjectIdFromKey(doc.key);
    const relativePath = getRelativePathFromKey(doc.key);
    if (isProjectEvicted(projectId) || isProjectRemoving(projectId) || isPathMutating(projectId, relativePath)) {
      return;
    }
    try {
      const buffer = data instanceof Buffer ? data : Buffer.from(data);
      if (buffer.byteLength > MAX_WS_MESSAGE_BYTES) {
        socket.close(1009, 'Message too large');
        return;
      }
      const decoder = decoding.createDecoder(buffer);
      const messageType = decoding.readVarUint(decoder);
      if (messageType === MESSAGE_SYNC) {
        const replyEncoder = encoding.createEncoder();
        encoding.writeVarUint(replyEncoder, MESSAGE_SYNC);
        syncProtocol.readSyncMessage(decoder, replyEncoder, doc.ydoc, conn);
        if (encoding.length(replyEncoder) > 1) {
          sendMessage(conn, encoding.toUint8Array(replyEncoder));
        }
        return;
      }
      if (messageType === MESSAGE_AWARENESS) {
        const update = decoding.readVarUint8Array(decoder);
        const clients = readAwarenessClients(update);
        clients.forEach((id) => conn.awarenessClientIds.add(id));
        awarenessProtocol.applyAwarenessUpdate(doc.awareness, update, conn);
      }
    } catch {
      socket.close(1003, 'Invalid message');
    }
  });

  socket.on('close', () => {
    doc.conns.delete(conn);
    if (conn.awarenessClientIds.size > 0) {
      awarenessProtocol.removeAwarenessStates(doc.awareness, Array.from(conn.awarenessClientIds), conn);
    }
    if (doc.conns.size === 0) {
      doc.cleanupTimer = setTimeout(() => {
        docs.delete(doc.key);
      }, 60_000);
    }
  });

  socket.on('error', () => {
    // ignore
  });
}

function matchesPathKey(key, projectId, targetPath) {
  const exactKey = `${projectId}:${targetPath}`;
  const nestedPrefix = `${exactKey}/`;
  return key === exactKey || key.startsWith(nestedPrefix);
}

function isPathAffected(candidatePath, targetPath) {
  return candidatePath === targetPath || candidatePath.startsWith(`${targetPath}/`);
}

function isPathMutating(projectId, targetPath) {
  const paths = mutatingPaths.get(projectId);
  if (!paths || paths.size === 0) {
    return false;
  }
  return Array.from(paths).some((candidate) => isPathAffected(targetPath, candidate));
}

export function beginPathMutation(projectId, targetPath) {
  const paths = mutatingPaths.get(projectId) || new Set();
  paths.add(targetPath);
  mutatingPaths.set(projectId, paths);
}

export function endPathMutation(projectId, targetPath) {
  const paths = mutatingPaths.get(projectId);
  if (!paths) {
    return;
  }
  paths.delete(targetPath);
  if (paths.size === 0) {
    mutatingPaths.delete(projectId);
  }
}

function matchesProjectKey(key, projectId) {
  const prefix = `${projectId}:`;
  return key.startsWith(prefix);
}

function getDocsForPath(projectId, targetPath) {
  return Array.from(docs.entries()).filter(([key]) => matchesPathKey(key, projectId, targetPath));
}

export function hasDocsForPath(projectId, targetPath) {
  return getDocsForPath(projectId, targetPath).length > 0;
}

function getDocsForProject(projectId) {
  return Array.from(docs.entries()).filter(([key]) => matchesProjectKey(key, projectId));
}

async function settlePendingDocs(match) {
  const entries = Array.from(pendingDocs.entries()).filter(([key]) => match(key));
  if (entries.length === 0) return;
  await Promise.all(entries.map(([, pending]) => pending.catch(() => null)));
}

function disposeDoc(doc) {
  clearFlushTimer(doc);
  if (doc.cleanupTimer) {
    clearTimeout(doc.cleanupTimer);
    doc.cleanupTimer = null;
  }
  for (const conn of doc.conns) {
    try {
      conn.socket?.close(1000, 'Document removed');
    } catch {
      // ignore
    }
  }
  doc.conns.clear();
  try {
    doc.ydoc.destroy();
  } catch {
    // ignore
  }
}

export function getDocDiagnostics(key) {
  const doc = docs.get(key);
  if (!doc) return null;
  return {
    conns: doc.conns.size,
    lastError: doc.lastError
  };
}

export async function flushDocNow(key) {
  const pending = pendingDocs.get(key);
  if (pending) {
    try {
      await pending;
    } catch {
      return;
    }
  }
  const doc = docs.get(key);
  if (!doc) return;
  clearFlushTimer(doc);
  await flushDoc(doc);
}

export async function flushDocsForPath(projectId, targetPath, options = {}) {
  const { allowMutating = false } = options;
  await settlePendingDocs((key) => matchesPathKey(key, projectId, targetPath));
  const entries = getDocsForPath(projectId, targetPath);
  for (const [, doc] of entries) {
    clearFlushTimer(doc);
    if (allowMutating) {
      const text = doc.text.toString();
      await ensureDir(path.dirname(doc.absPath));
      await fs.writeFile(doc.absPath, text, 'utf8');
      continue;
    }
    await flushDoc(doc);
  }
}

export async function writeDocContent({ key, absPath, metaPath, content }) {
  const projectId = getProjectIdFromKey(key);
  const relativePath = getRelativePathFromKey(key);
  if (isProjectRemoving(projectId)) {
    throw createProjectRemovedError(projectId);
  }
  if (isPathMutating(projectId, relativePath)) {
    throw createPathMutationError(relativePath);
  }
  let doc = docs.get(key);
  const hadLiveDoc = Boolean(doc || pendingDocs.get(key));
  if (!doc) {
    const pending = pendingDocs.get(key);
    try {
      doc = pending ? await pending : await getOrCreateDoc({ key, absPath, metaPath });
    } catch (err) {
      if (err?.code === 'PROJECT_REMOVED' || err?.code === 'PATH_MUTATING') {
        throw err;
      }
      return false;
    }
  }
  if (!doc) return false;
  if (isPathMutating(projectId, relativePath)) {
    throw createPathMutationError(relativePath);
  }
  doc.absPath = absPath;
  doc.metaPath = metaPath;
  const nextContent = content ?? '';
  if (doc.text.toString() !== nextContent) {
    doc.ydoc.transact(() => {
      if (doc.text.length > 0) {
        doc.text.delete(0, doc.text.length);
      }
      if (nextContent) {
        doc.text.insert(0, nextContent);
      }
    });
  }
  clearFlushTimer(doc);
  await flushDoc(doc);
  if (!hadLiveDoc && doc.conns.size === 0) {
    docs.delete(key);
    disposeDoc(doc);
  }
  return true;
}

export async function renameDocsForPath(projectId, fromPath, toPath, projectRoot) {
  await settlePendingDocs((key) => matchesPathKey(key, projectId, fromPath));
  const entries = getDocsForPath(projectId, fromPath);
  if (entries.length === 0) return;
  const exactKey = `${projectId}:${fromPath}`;
  const updated = entries.map(([key, doc]) => {
    const suffix = key === exactKey ? '' : key.slice(exactKey.length);
    const nextPath = `${toPath}${suffix}`;
    const nextKey = `${projectId}:${nextPath}`;
    return {
      key,
      nextKey,
      nextAbsPath: path.join(projectRoot, ...nextPath.split('/')),
      doc
    };
  });
  updated.forEach(({ key }) => docs.delete(key));
  updated.forEach(({ nextKey, nextAbsPath, doc }) => {
    doc.key = nextKey;
    doc.absPath = nextAbsPath;
    docs.set(nextKey, doc);
  });
}

export async function removeDocsForPath(projectId, targetPath) {
  await settlePendingDocs((key) => matchesPathKey(key, projectId, targetPath));
  const entries = getDocsForPath(projectId, targetPath);
  entries.forEach(([key, doc]) => {
    docs.delete(key);
    disposeDoc(doc);
  });
}

export function markProjectRemoving(projectId) {
  removingProjects.add(projectId);
}

export async function evictDocsForProject(projectId) {
  evictedProjects.add(projectId);
  removingProjects.delete(projectId);
  await settlePendingDocs((key) => matchesProjectKey(key, projectId));
  getDocsForProject(projectId).forEach(([key, doc]) => {
    docs.delete(key);
    disposeDoc(doc);
  });
}

export function restoreProjectDocs(projectId) {
  evictedProjects.delete(projectId);
  removingProjects.delete(projectId);
}