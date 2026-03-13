import path from 'path';
import { Transform } from 'stream';
import { promises as fs, createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import tar from 'tar';
import unzipper from 'unzipper';
import crypto from 'crypto';
import { DATA_DIR, MAX_IMPORT_ARCHIVE_BYTES, MAX_IMPORT_ARCHIVE_ENTRY_BYTES, MAX_IMPORT_ARCHIVE_FILES, TEMPLATE_DIR } from '../config/constants.js';
import { ensureDir, readJson, writeJson, copyDir, listFilesRecursive } from '../utils/fsUtils.js';
import { normalizeProjectPath, safeJoin, sanitizeUploadPath } from '../utils/pathUtils.js';
import { isTextFile, extractDocumentBody, mergeTemplateBody } from '../utils/texUtils.js';
import { readTemplateManifest, copyTemplateIntoProject } from '../services/templateService.js';
import { getProjectRoot } from '../services/projectService.js';
import { downloadArxivSource, extractArxivId } from '../services/arxivService.js';
import { beginPathMutation, endPathMutation, flushDocsForPath, hasDocsForPath, removeDocsForPath, renameDocsForPath, evictDocsForProject, markProjectRemoving, restoreProjectDocs, writeDocContent } from '../services/collab/docStore.js';
import { getLang, t } from '../i18n/index.js';
import { authorizeProjectAccess, isLocalBootstrapAllowed, requireAuthIfRemote, requireOwnerAuth } from '../utils/authUtils.js';

export function registerProjectRoutes(fastify) {
  const createArchiveLimitStream = (state) => new Transform({
    transform(chunk, _encoding, callback) {
      const size = Buffer.isBuffer(chunk) ? chunk.byteLength : Buffer.byteLength(chunk);
      state.entryBytes += size;
      state.totalBytes += size;
      if (state.entryBytes > MAX_IMPORT_ARCHIVE_ENTRY_BYTES) {
        callback(new Error('Archive entry exceeds size limit'));
        return;
      }
      if (state.totalBytes > MAX_IMPORT_ARCHIVE_BYTES) {
        callback(new Error('Archive exceeds size limit'));
        return;
      }
      callback(null, chunk);
    }
  });

  const requireOwnerAccess = async (req, reply) => {
    if (isLocalBootstrapAllowed(req)) {
      return;
    }
    const auth = requireOwnerAuth(req);
    if (!auth.ok) {
      reply.code(401).send({ ok: false, error: 'Unauthorized' });
    }
  };

  const requireProjectAccess = async (req, reply) => {
    if (isLocalBootstrapAllowed(req)) {
      return;
    }
    const authz = authorizeProjectAccess(req, req.params?.id);
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

  const isReservedProjectPath = (filePath) => normalizeProjectPath(filePath) === 'project.json';

  const requireOwnerReservedPathAccess = async (req, reply, targetPath) => {
    if (!isReservedProjectPath(targetPath)) {
      return false;
    }
    const ownerAuth = requireOwnerAuth(req);
    if (!ownerAuth.ok) {
      reply.code(403).send({ ok: false, error: 'Forbidden' });
      return true;
    }
    return false;
  };

  const requireProjectMintingAccess = async (req, reply) => {
    if (isLocalBootstrapAllowed(req)) {
      return;
    }
    const ownerAuth = requireOwnerAuth(req);
    if (ownerAuth.ok) {
      return;
    }
    const auth = requireAuthIfRemote(req);
    if (!auth.ok) {
      reply.code(401).send({ ok: false, error: 'Unauthorized' });
      return;
    }
    if (auth.payload) {
      reply.code(403).send({ ok: false, error: 'Forbidden' });
      return;
    }
    reply.code(401).send({ ok: false, error: 'Unauthorized' });
  };
  fastify.get('/api/projects', { preHandler: requireOwnerAccess }, async () => {
    await ensureDir(DATA_DIR);
    const entries = await fs.readdir(DATA_DIR, { withFileTypes: true });
    const projects = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const metaPath = path.join(DATA_DIR, entry.name, 'project.json');
      try {
        const meta = await readJson(metaPath);
        projects.push({
          ...meta,
          updatedAt: meta.updatedAt || meta.createdAt,
          tags: meta.tags || [],
          archived: meta.archived || false,
          trashed: meta.trashed || false,
          trashedAt: meta.trashedAt || null
        });
      } catch {
        // ignore
      }
    }
    return { projects };
  });

  fastify.post('/api/projects', { preHandler: requireOwnerAccess }, async (req, reply) => {
    await ensureDir(DATA_DIR);
    const { name = 'Untitled', template } = req.body || {};
    const id = crypto.randomUUID();
    const projectRoot = path.join(DATA_DIR, id);
    await ensureDir(projectRoot);
    let mainFile = '';
    if (template) {
      const { templates } = await readTemplateManifest();
      const templateMeta = templates.find((item) => item.id === template);
      mainFile = templateMeta?.mainFile || '';
      const templateRoot = path.join(TEMPLATE_DIR, template);
      await copyDir(templateRoot, projectRoot);
    }
    const meta = { id, name, createdAt: new Date().toISOString(), ...(mainFile ? { mainFile } : {}) };
    await writeJson(path.join(projectRoot, 'project.json'), meta);
    reply.send(meta);
  });

  fastify.post('/api/projects/import-zip', { preHandler: requireOwnerAccess }, async (req) => {
    const lang = getLang(req);
    await ensureDir(DATA_DIR);
    const id = crypto.randomUUID();
    const projectRoot = path.join(DATA_DIR, id);
    await ensureDir(projectRoot);
    let projectName = 'Imported Project';
    let hasZip = false;

    try {
      let importedFiles = 0;
      let importedBytes = 0;
      const parts = req.parts();
      for await (const part of parts) {
        if (part.type === 'field' && part.fieldname === 'projectName') {
          projectName = String(part.value || '').trim() || projectName;
          continue;
        }
        if (part.type !== 'file') continue;
        hasZip = true;
        const zipStream = part.file.pipe(unzipper.Parse({ forceStream: true }));
        for await (const entry of zipStream) {
          if (entry.type === 'SymbolicLink' || entry.type === 'FileLink') {
            entry.autodrain();
            continue;
          }
          const relPath = sanitizeUploadPath(entry.path);
          if (!relPath || relPath.endsWith('project.json')) {
            entry.autodrain();
            continue;
          }
          importedFiles += 1;
          if (importedFiles > MAX_IMPORT_ARCHIVE_FILES) {
            throw new Error('Archive contains too many files');
          }
          const abs = safeJoin(projectRoot, relPath);
          if (entry.type === 'Directory') {
            await ensureDir(abs);
            entry.autodrain();
            continue;
          }
          await ensureDir(path.dirname(abs));
          const archiveState = { entryBytes: 0, totalBytes: importedBytes };
          await pipeline(entry, createArchiveLimitStream(archiveState), createWriteStream(abs));
          importedBytes = archiveState.totalBytes;
        }
      }
    } catch (err) {
      await fs.rm(projectRoot, { recursive: true, force: true });
      return { ok: false, error: t(lang, 'zip_extract_failed', { error: String(err) }) };
    }

    if (!hasZip) {
      return { ok: false, error: 'Missing zip file.' };
    }

    const meta = { id, name: projectName, createdAt: new Date().toISOString() };
    await writeJson(path.join(projectRoot, 'project.json'), meta);
    return { ok: true, project: meta };
  });

  fastify.get('/api/projects/import-arxiv-sse', { preHandler: requireOwnerAccess }, async (req, reply) => {
    const lang = getLang(req);
    await ensureDir(DATA_DIR);
    const { arxivIdOrUrl, projectName } = req.query;
    const arxivId = extractArxivId(arxivIdOrUrl);
    req.log.info({ arxivId, arxivIdOrUrl }, 'import-arxiv-sse: parsed id');

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    });
    const send = (event, data) => {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    if (!arxivId) {
      send('error', { error: 'Invalid arXiv ID.' });
      reply.raw.end();
      return reply;
    }

    const id = crypto.randomUUID();
    const projectRoot = path.join(DATA_DIR, id);
    await ensureDir(projectRoot);
    const meta = {
      id,
      name: projectName || `arxiv-${arxivId}`,
      createdAt: new Date().toISOString()
    };

    const tmpTar = path.join(projectRoot, '__arxiv_source.tar.gz');
    try {
      let extractedFiles = 0;
      let extractedBytes = 0;
      send('progress', { phase: 'download', percent: 0 });
      await downloadArxivSource(arxivId, tmpTar, ({ received, total }) => {
        if (received > MAX_IMPORT_ARCHIVE_BYTES) {
          throw new Error('Archive download exceeds size limit');
        }
        const percent = total > 0 ? Math.round((received / total) * 100) : -1;
        send('progress', { phase: 'download', percent, received, total });
      });

      send('progress', { phase: 'extract', percent: -1 });
      await tar.x({
        file: tmpTar,
        cwd: projectRoot,
        filter: (entryPath, entry) => {
          if (!entryPath) return false;
          if (path.isAbsolute(entryPath)) return false;
          if (entry?.type !== 'File' && entry?.type !== 'Directory') return false;
          extractedFiles += 1;
          if (extractedFiles > MAX_IMPORT_ARCHIVE_FILES) {
            throw new Error('Archive contains too many files');
          }
          if (entry?.type === 'File') {
            const entrySize = Number(entry.size || 0);
            if (entrySize > MAX_IMPORT_ARCHIVE_ENTRY_BYTES) {
              throw new Error('Archive entry exceeds size limit');
            }
            extractedBytes += entrySize;
            if (extractedBytes > MAX_IMPORT_ARCHIVE_BYTES) {
              throw new Error('Archive exceeds size limit');
            }
          }
          return !entryPath.split(/[\\/]/).some((part) => part === '..');
        }
      });
    } catch (err) {
      await fs.rm(projectRoot, { recursive: true, force: true });
      send('error', { error: t(lang, 'arxiv_download_failed', { error: String(err) }) });
      reply.raw.end();
      return reply;
    } finally {
      await fs.rm(tmpTar, { force: true });
    }

    await writeJson(path.join(projectRoot, 'project.json'), meta);
    send('done', { ok: true, project: meta });
    reply.raw.end();
    return reply;
  });

  fastify.post('/api/projects/:id/rename-project', { preHandler: requireOwnerProjectAccess }, async (req) => {
    const { id } = req.params;
    const { name } = req.body || {};
    if (!name) return { ok: false, error: 'Missing name' };
    const projectRoot = await getProjectRoot(id);
    const metaPath = path.join(projectRoot, 'project.json');
    const meta = await readJson(metaPath);
    const next = { ...meta, name };
    await writeJson(metaPath, next);
    return { ok: true, project: next };
  });

  fastify.post('/api/projects/:id/copy', { preHandler: requireProjectMintingAccess }, async (req) => {
    const { id } = req.params;
    const { name } = req.body || {};
    const srcRoot = await getProjectRoot(id);
    const srcMeta = await readJson(path.join(srcRoot, 'project.json'));
    const newId = crypto.randomUUID();
    const destRoot = path.join(DATA_DIR, newId);
    await copyDir(srcRoot, destRoot);
    const newMeta = {
      ...srcMeta,
      id: newId,
      name: name || `${srcMeta.name} (Copy)`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      trashed: false,
      trashedAt: null,
    };
    await writeJson(path.join(destRoot, 'project.json'), newMeta);
    return { ok: true, project: newMeta };
  });

  fastify.delete('/api/projects/:id', { preHandler: requireOwnerProjectAccess }, async (req) => {
    const { id } = req.params;
    const projectRoot = await getProjectRoot(id);
    const metaPath = path.join(projectRoot, 'project.json');
    const meta = await readJson(metaPath);
    const next = { ...meta, trashed: true, trashedAt: new Date().toISOString() };
    await writeJson(metaPath, next);
    return { ok: true };
  });

  fastify.delete('/api/projects/:id/permanent', { preHandler: requireOwnerProjectAccess }, async (req) => {
    const { id } = req.params;
    const projectRoot = await getProjectRoot(id);
    markProjectRemoving(id);
    try {
      await fs.rm(projectRoot, { recursive: true, force: true });
      await evictDocsForProject(id);
      return { ok: true };
    } catch (err) {
      restoreProjectDocs(id);
      throw err;
    }
  });

  fastify.patch('/api/projects/:id/tags', { preHandler: requireOwnerProjectAccess }, async (req) => {
    const { id } = req.params;
    const { tags } = req.body || {};
    if (!Array.isArray(tags)) return { ok: false, error: 'tags must be an array' };
    const projectRoot = await getProjectRoot(id);
    const metaPath = path.join(projectRoot, 'project.json');
    const meta = await readJson(metaPath);
    const next = { ...meta, tags, updatedAt: new Date().toISOString() };
    await writeJson(metaPath, next);
    return { ok: true, project: next };
  });

  fastify.patch('/api/projects/:id/archive', { preHandler: requireOwnerProjectAccess }, async (req) => {
    const { id } = req.params;
    const { archived } = req.body || {};
    const projectRoot = await getProjectRoot(id);
    const metaPath = path.join(projectRoot, 'project.json');
    const meta = await readJson(metaPath);
    const next = { ...meta, archived: !!archived, updatedAt: new Date().toISOString() };
    await writeJson(metaPath, next);
    return { ok: true, project: next };
  });

  fastify.patch('/api/projects/:id/trash', { preHandler: requireOwnerProjectAccess }, async (req) => {
    const { id } = req.params;
    const { trashed } = req.body || {};
    const projectRoot = await getProjectRoot(id);
    const metaPath = path.join(projectRoot, 'project.json');
    const meta = await readJson(metaPath);
    const next = {
      ...meta,
      trashed: !!trashed,
      trashedAt: trashed ? new Date().toISOString() : null,
      updatedAt: new Date().toISOString()
    };
    await writeJson(metaPath, next);
    return { ok: true, project: next };
  });

  fastify.get('/api/projects/:id/tree', { preHandler: requireProjectAccess }, async (req) => {
    const { id } = req.params;
    const projectRoot = await getProjectRoot(id);
    const items = await listFilesRecursive(projectRoot);
    let fileOrder = {};
    let mainFile = '';
    try {
      const meta = await readJson(path.join(projectRoot, 'project.json'));
      const rawOrder = meta?.fileOrder || {};
      mainFile = typeof meta?.mainFile === 'string' ? meta.mainFile.replace(/\\/g, '/') : '';
      fileOrder = {};
      for (const key in rawOrder) {
        const normalizedKey = key.replace(/\\/g, '/');
        fileOrder[normalizedKey] = rawOrder[key].map(p => p.replace(/\\/g, '/'));
      }
    } catch {
      fileOrder = {};
      mainFile = '';
    }
    return { items, fileOrder, mainFile };
  });

  fastify.post('/api/projects/:id/file-order', { preHandler: requireOwnerProjectAccess }, async (req) => {
    const { id } = req.params;
    const { folder = '', order } = req.body || {};
    if (!Array.isArray(order)) {
      return { ok: false, error: 'Missing order.' };
    }
    const projectRoot = await getProjectRoot(id);
    const metaPath = path.join(projectRoot, 'project.json');
    const meta = await readJson(metaPath);
    const next = { ...meta, fileOrder: { ...(meta.fileOrder || {}), [folder]: order } };
    await writeJson(metaPath, next);
    return { ok: true };
  });

  fastify.post('/api/projects/:id/main-file', { preHandler: requireOwnerProjectAccess }, async (req) => {
    const { id } = req.params;
    const rawMainFile = req.body?.mainFile;
    if (typeof rawMainFile !== 'string') {
      return { ok: false, error: 'Missing mainFile.' };
    }
    const mainFile = rawMainFile.replace(/\\/g, '/').trim();
    const projectRoot = await getProjectRoot(id);
    const metaPath = path.join(projectRoot, 'project.json');
    const meta = await readJson(metaPath);
    if (!mainFile) {
      const next = { ...meta, mainFile: '', updatedAt: new Date().toISOString() };
      await writeJson(metaPath, next);
      return { ok: true, mainFile: '' };
    }
    const abs = safeJoin(projectRoot, mainFile);
    let stat;
    try {
      stat = await fs.stat(abs);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return { ok: false, error: 'Main file not found.' };
      }
      throw error;
    }
    if (!stat.isFile()) {
      return { ok: false, error: 'Main file is not a file.' };
    }
    const next = { ...meta, mainFile, updatedAt: new Date().toISOString() };
    await writeJson(metaPath, next);
    return { ok: true, mainFile: next.mainFile };
  });

  fastify.get('/api/projects/:id/file', { preHandler: requireProjectAccess }, async (req) => {
    const { id } = req.params;
    const { path: filePath } = req.query;
    if (!filePath) return { content: '' };
    const projectRoot = await getProjectRoot(id);
    const abs = safeJoin(projectRoot, filePath);
    const content = await fs.readFile(abs, 'utf8');
    return { content };
  });

  fastify.get('/api/projects/:id/blob', { preHandler: requireProjectAccess }, async (req, reply) => {
    const { id } = req.params;
    const { path: filePath } = req.query;
    if (!filePath) return reply.code(400).send('Missing path');
    const projectRoot = await getProjectRoot(id);
    const abs = safeJoin(projectRoot, filePath);
    const buffer = await fs.readFile(abs);
    const ext = path.extname(filePath).toLowerCase();
    const contentTypes = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.svg': 'application/octet-stream',
      '.pdf': 'application/pdf',
      '.eps': 'application/postscript'
    };
    const contentType = contentTypes[ext] || 'application/octet-stream';
    reply.header('Content-Type', contentType);
    if (ext === '.svg') {
      reply.header('Content-Disposition', `attachment; filename="${path.basename(filePath)}"`);
      reply.header('X-Content-Type-Options', 'nosniff');
    }
    return reply.send(buffer);
  });

  fastify.post('/api/projects/:id/upload', { preHandler: requireProjectAccess }, async (req, reply) => {
    const { id } = req.params;
    const projectRoot = await getProjectRoot(id);
    const saved = [];
    const parts = req.parts();
    for await (const part of parts) {
      if (part.type !== 'file') continue;
      const relPath = sanitizeUploadPath(part.filename);
      if (!relPath) continue;
      if (await requireOwnerReservedPathAccess(req, reply, relPath)) {
        return reply;
      }
      const abs = safeJoin(projectRoot, relPath);
      await ensureDir(path.dirname(abs));
      await pipeline(part.file, createWriteStream(abs));
      saved.push(relPath);
    }
    return { ok: true, files: saved };
  });

  fastify.put('/api/projects/:id/file', { preHandler: requireProjectAccess }, async (req, reply) => {
    const { id } = req.params;
    const { path: filePath, content } = req.body || {};
    const normalizedPath = normalizeProjectPath(filePath);
    if (!normalizedPath) return { ok: false, error: 'Missing file path' };
    if (await requireOwnerReservedPathAccess(req, reply, normalizedPath)) {
      return reply;
    }
    const projectRoot = await getProjectRoot(id);
    const abs = safeJoin(projectRoot, normalizedPath);
    const metaPath = path.join(projectRoot, 'project.json');
    const nextContent = content ?? '';
    if (isTextFile(normalizedPath)) {
      try {
        const synced = await writeDocContent({
          key: `${id}:${normalizedPath}`,
          absPath: abs,
          metaPath,
          content: nextContent
        });
        if (synced) {
          return { ok: true };
        }
      } catch (err) {
        if (err?.code === 'PROJECT_REMOVED') {
          return { ok: false, error: 'Project removed' };
        }
        if (err?.code === 'PATH_MUTATING') {
          return { ok: false, error: 'Path is mutating' };
        }
        throw err;
      }
    }
    await ensureDir(path.dirname(abs));
    await fs.writeFile(abs, nextContent, 'utf8');
    try {
      const meta = await readJson(metaPath);
      await writeJson(metaPath, { ...meta, updatedAt: new Date().toISOString() });
    } catch { /* ignore */ }
    return { ok: true };
  });

  fastify.get('/api/projects/:id/files', { preHandler: requireProjectAccess }, async (req) => {
    const { id } = req.params;
    const projectRoot = await getProjectRoot(id);
    const items = await listFilesRecursive(projectRoot);
    const files = [];
    for (const item of items) {
      if (item.type !== 'file') continue;
      const abs = path.join(projectRoot, item.path);
      const buffer = await fs.readFile(abs);
      if (isTextFile(item.path)) {
        files.push({ path: item.path, content: buffer.toString('utf8'), encoding: 'utf8' });
      } else {
        files.push({ path: item.path, content: buffer.toString('base64'), encoding: 'base64' });
      }
    }
    return { files };
  });

  fastify.post('/api/projects/:id/convert-template', { preHandler: requireOwnerProjectAccess }, async (req) => {
    const { id } = req.params;
    const { targetTemplate, mainFile } = req.body || {};
    if (!targetTemplate) return { ok: false, error: 'Missing targetTemplate' };
    const { templates } = await readTemplateManifest();
    const template = templates.find((item) => item.id === targetTemplate);
    if (!template) return { ok: false, error: 'Unknown template' };

    try {
      const projectRoot = await getProjectRoot(id);
      const metaPath = path.join(projectRoot, 'project.json');
      const meta = await readJson(metaPath);
      const sourceMainFile = typeof mainFile === 'string' && mainFile ? mainFile : (meta.mainFile || 'main.tex');
      const currentMainPath = safeJoin(projectRoot, sourceMainFile);
      const templateRoot = path.join(TEMPLATE_DIR, template.id);
      const templateMain = template.mainFile || 'main.tex';
      const templateMainPath = path.join(templateRoot, templateMain);

      let currentTex = '';
      try {
        currentTex = await fs.readFile(currentMainPath, 'utf8');
      } catch {
        currentTex = '';
      }

      const templateTex = await fs.readFile(templateMainPath, 'utf8');
      const body = extractDocumentBody(currentTex);
      const merged = mergeTemplateBody(templateTex, body);
      const changedFiles = await copyTemplateIntoProject(templateRoot, projectRoot, templateMain);
      await fs.writeFile(safeJoin(projectRoot, templateMain), merged, 'utf8');
      changedFiles.push(templateMain);
      await writeJson(metaPath, { ...meta, mainFile: templateMain, updatedAt: new Date().toISOString() });
      return { ok: true, mainFile: templateMain, changedFiles };
    } catch (err) {
      return { ok: false, error: `Template convert failed: ${String(err)}` };
    }
  });

  fastify.post('/api/projects/:id/template', { preHandler: requireOwnerProjectAccess }, async (req) => {
    const { id } = req.params;
    const { template } = req.body || {};
    const projectRoot = await getProjectRoot(id);
    if (!template) return { ok: false };
    const { templates } = await readTemplateManifest();
    const templateMeta = templates.find((item) => item.id === template);
    if (!templateMeta) return { ok: false, error: 'Unknown template' };
    const templateRoot = path.join(TEMPLATE_DIR, template);
    await copyDir(templateRoot, projectRoot);
    const metaPath = path.join(projectRoot, 'project.json');
    const meta = await readJson(metaPath);
    await writeJson(metaPath, { ...meta, mainFile: templateMeta.mainFile, updatedAt: new Date().toISOString() });
    return { ok: true, mainFile: templateMeta.mainFile };
  });

  fastify.post('/api/projects/:id/folder', { preHandler: requireProjectAccess }, async (req) => {
    const { id } = req.params;
    const { path: folderPath } = req.body || {};
    if (!folderPath) return { ok: false };
    const projectRoot = await getProjectRoot(id);
    const abs = safeJoin(projectRoot, folderPath);
    await ensureDir(abs);
    return { ok: true };
  });

  fastify.post('/api/projects/:id/rename', { preHandler: requireProjectAccess }, async (req, reply) => {
    const { id } = req.params;
    const { from, to } = req.body || {};
    const normalizedFrom = normalizeProjectPath(from);
    const normalizedTo = normalizeProjectPath(to);
    if (!normalizedFrom || !normalizedTo || normalizedFrom === normalizedTo) return { ok: false };
    if (await requireOwnerReservedPathAccess(req, reply, normalizedFrom) || await requireOwnerReservedPathAccess(req, reply, normalizedTo)) {
      return reply;
    }
    const projectRoot = await getProjectRoot(id);
    beginPathMutation(id, normalizedFrom);
    beginPathMutation(id, normalizedTo);
    try {
      await flushDocsForPath(id, normalizedFrom, { allowMutating: true });
      if (hasDocsForPath(id, normalizedTo)) {
        return { ok: false, error: 'Target path is busy' };
      }
      const absFrom = safeJoin(projectRoot, normalizedFrom);
      const absTo = safeJoin(projectRoot, normalizedTo);
      try {
        await fs.stat(absTo);
        return { ok: false, error: 'Target path already exists' };
      } catch (err) {
        if (err?.code !== 'ENOENT') {
          throw err;
        }
      }
      await ensureDir(path.dirname(absTo));
      await fs.rename(absFrom, absTo);
      await renameDocsForPath(id, normalizedFrom, normalizedTo, projectRoot);
      return { ok: true };
    } finally {
      endPathMutation(id, normalizedTo);
      endPathMutation(id, normalizedFrom);
    }
  });

  fastify.delete('/api/projects/:id/file', { preHandler: requireProjectAccess }, async (req, reply) => {
    const { id } = req.params;
    const { path: filePath } = req.query || {};
    const normalizedPath = normalizeProjectPath(filePath);
    if (!normalizedPath) return { ok: false, error: 'Missing file path' };
    if (await requireOwnerReservedPathAccess(req, reply, normalizedPath)) {
      return reply;
    }
    const projectRoot = await getProjectRoot(id);
    beginPathMutation(id, normalizedPath);
    try {
      await flushDocsForPath(id, normalizedPath, { allowMutating: true });
      const abs = safeJoin(projectRoot, normalizedPath);
      // Check if it's a directory
      try {
        const stat = await fs.stat(abs);
        if (stat.isDirectory()) {
          await fs.rm(abs, { recursive: true, force: true });
        } else {
          await fs.rm(abs, { force: true });
        }
      } catch (err) {
        if (err.code === 'ENOENT') {
          return { ok: false, error: 'File not found' };
        }
        throw err;
      }
      await removeDocsForPath(id, normalizedPath);
      return { ok: true };
    } finally {
      endPathMutation(id, normalizedPath);
    }
  });
}
