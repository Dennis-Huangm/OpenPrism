import crypto from 'crypto';
import path from 'path';
import { readJson } from '../utils/fsUtils.js';
import { getProjectRoot } from '../services/projectService.js';
import { normalizeProjectPath, safeJoin } from '../utils/pathUtils.js';
import { isTextFile } from '../utils/texUtils.js';
import { issueToken, verifyToken } from '../services/collab/tokenService.js';
import { getOrCreateDoc, setupConnection, flushDocNow, getDocDiagnostics } from '../services/collab/docStore.js';
import { authorizeProjectAccess, requireAuthIfRemote, requireOwnerAuth } from '../utils/authUtils.js';

export function registerCollabRoutes(fastify) {
  const pendingJoinTokens = new Map();

  const mintJoinToken = (collabToken) => {
    const joinToken = crypto.randomUUID();
    pendingJoinTokens.set(joinToken, collabToken);
    setTimeout(() => {
      if (pendingJoinTokens.get(joinToken) === collabToken) {
        pendingJoinTokens.delete(joinToken);
      }
    }, 5 * 60 * 1000);
    return joinToken;
  };

  const requireProjectAccess = async (req, reply) => {
    const authz = authorizeProjectAccess(req, req.params?.id, requireAuthIfRemote(req));
    if (!authz.ok) {
      reply.code(authz.statusCode).send({ ok: false, error: authz.error });
    }
  };

  const requireOwnerProjectAccess = async (req, reply) => {
    const ownerAuth = requireOwnerAuth(req);
    if (!ownerAuth.ok) {
      reply.code(401).send({ ok: false, error: 'Unauthorized' });
      return;
    }
    const authz = authorizeProjectAccess(req, req.params?.id, ownerAuth);
    if (!authz.ok) {
      reply.code(authz.statusCode).send({ ok: false, error: authz.error });
    }
  };

  fastify.post('/api/projects/:id/collab/invite', { preHandler: requireOwnerProjectAccess }, async (req) => {
    const { id } = req.params;
    await getProjectRoot(id);
    const token = issueToken({ projectId: id, role: 'admin' });
    const joinToken = mintJoinToken(token);
    return { ok: true, token, joinToken };
  });

  fastify.post('/api/collab/resolve', async (req, reply) => {
    const { joinToken } = req.body || {};
    const tokenValue = typeof joinToken === 'string' ? pendingJoinTokens.get(joinToken) || '' : '';
    if (joinToken && tokenValue) {
      pendingJoinTokens.delete(joinToken);
    }
    const payload = verifyToken(tokenValue);
    if (!payload) {
      reply.code(401);
      return { ok: false, error: 'Invalid token' };
    }
    const projectRoot = await getProjectRoot(payload.projectId);
    let projectName = payload.projectId;
    try {
      const meta = await readJson(path.join(projectRoot, 'project.json'));
      projectName = meta?.name || projectName;
    } catch {
      // ignore
    }
    return { ok: true, projectId: payload.projectId, projectName, role: payload.role, token: tokenValue };
  });

  fastify.post('/api/projects/:id/collab/flush', { preHandler: requireProjectAccess }, async (req) => {
    const { id } = req.params;
    const { path: filePath } = req.body || {};
    const normalizedPath = normalizeProjectPath(filePath);
    if (!normalizedPath) return { ok: false, error: 'Missing path' };
    await getProjectRoot(id);
    const key = `${id}:${normalizedPath}`;
    await flushDocNow(key);
    return { ok: true };
  });

  fastify.get('/api/projects/:id/collab/status', { preHandler: requireProjectAccess }, async (req) => {
    const { id } = req.params;
    const { path: filePath } = req.query || {};
    const normalizedPath = normalizeProjectPath(filePath);
    if (!normalizedPath) return { ok: false, error: 'Missing path' };
    await getProjectRoot(id);
    const key = `${id}:${normalizedPath}`;
    const diagnostics = getDocDiagnostics(key);
    return { ok: true, diagnostics };
  });

  fastify.get('/api/collab', { websocket: true }, async (socket, req) => {
    const { projectId, file } = req.query || {};
    const protocols = req.headers['sec-websocket-protocol'];
    const tokenValue = Array.isArray(protocols)
      ? protocols[0]
      : String(protocols || '').split(',').map((item) => item.trim()).find((item) => item.startsWith('openprism-collab.'))?.slice('openprism-collab.'.length) || '';
    const rawFilePath = Array.isArray(file) ? file[0] : file;
    const filePath = normalizeProjectPath(rawFilePath);
    const projectParam = Array.isArray(projectId) ? projectId[0] : projectId;
    let payload = null;
    if (tokenValue) {
      payload = verifyToken(tokenValue);
      if (!payload) {
        socket.close(1008, 'Unauthorized');
        return;
      }
    } else {
      socket.close(1008, 'Unauthorized');
      return;
    }
    const effectiveProjectId = payload?.projectId || projectParam;
    if (!effectiveProjectId || !filePath) {
      socket.close(1008, 'Missing project or file');
      return;
    }
    if (payload && projectParam && payload.projectId !== projectParam) {
      socket.close(1008, 'Project mismatch');
      return;
    }
    let projectRoot = '';
    try {
      projectRoot = await getProjectRoot(effectiveProjectId);
    } catch {
      socket.close(1008, 'Project not found');
      return;
    }
    if (!isTextFile(filePath)) {
      socket.close(1003, 'Binary file');
      return;
    }
    let absPath = '';
    try {
      absPath = safeJoin(projectRoot, filePath);
    } catch {
      socket.close(1008, 'Invalid path');
      return;
    }
    const metaPath = path.join(projectRoot, 'project.json');
    const key = `${effectiveProjectId}:${filePath}`;
    try {
      const doc = await getOrCreateDoc({ key, absPath, metaPath });
      setupConnection(doc, socket);
    } catch (err) {
      if (err?.code === 'PROJECT_REMOVED') {
        socket.close(1008, 'Project removed');
        return;
      }
      if (err?.code === 'PATH_MUTATING') {
        socket.close(1013, 'Path mutating');
        return;
      }
      socket.close(1011, 'Collab unavailable');
    }
  });
}
