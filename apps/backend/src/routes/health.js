import { promises as fs, createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import path from 'path';
import unzipper from 'unzipper';
import { readTemplateManifest, addTemplateToManifest, listTemplateEntrypoints, listTemplateEntrypointsFromRoot, resolvePreferredTemplateMainFile } from '../services/templateService.js';
import { TEMPLATE_DIR } from '../config/constants.js';
import { ensureDir } from '../utils/fsUtils.js';
import { sanitizeUploadPath } from '../utils/pathUtils.js';
import { safeJoin } from '../utils/pathUtils.js';

function isValidTemplateId(templateId) {
  return /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(String(templateId || ''));
}

export function registerHealthRoutes(fastify) {
  fastify.get('/api/health', async () => ({ ok: true }));

  fastify.get('/api/templates', async () => {
    const { templates, categories } = await readTemplateManifest();
    return { templates, categories };
  });

  fastify.get('/api/templates/:templateId/files', async (req, reply) => {
    const { templateId } = req.params || {};
    if (!templateId) {
      return reply.code(400).send({ error: 'templateId is required.' });
    }

    const { templates } = await readTemplateManifest();
    const template = templates.find((item) => item.id === templateId);
    if (!template) {
      return reply.code(404).send({ error: `Template not found: ${templateId}` });
    }

    let files = [];
    try {
      files = await listTemplateEntrypoints(templateId);
    } catch {
      return reply.code(404).send({ error: `Template files not found: ${templateId}` });
    }

    return { files };
  });

  fastify.post('/api/templates/upload', async (req, reply) => {
    await ensureDir(TEMPLATE_DIR);
    let templateId = '';
    let templateLabel = '';
    let templateMainFile = '';
    let hasZip = false;
    let stagingRoot = '';

    try {
      const parts = req.parts();
      for await (const part of parts) {
        if (part.type === 'field' && part.fieldname === 'templateId') {
          templateId = String(part.value || '').trim();
          if (!isValidTemplateId(templateId)) {
            return reply.code(400).send({ ok: false, error: 'Invalid templateId.' });
          }
          continue;
        }
        if (part.type === 'field' && part.fieldname === 'templateLabel') {
          templateLabel = String(part.value || '').trim();
          continue;
        }
        if (part.type === 'field' && part.fieldname === 'mainFile') {
          templateMainFile = String(part.value || '').trim();
          continue;
        }
        if (part.type !== 'file') continue;
        if (!templateId) {
          return reply.code(400).send({ ok: false, error: 'templateId is required before file.' });
        }
        hasZip = true;
        const templateRoot = safeJoin(TEMPLATE_DIR, templateId);
        stagingRoot = safeJoin(TEMPLATE_DIR, `.upload-${templateId}-${Date.now()}`);
        await fs.rm(stagingRoot, { recursive: true, force: true });
        await ensureDir(stagingRoot);

        const zipStream = part.file.pipe(unzipper.Parse({ forceStream: true }));
        for await (const entry of zipStream) {
          const relPath = sanitizeUploadPath(entry.path);
          if (!relPath) { entry.autodrain(); continue; }
          const abs = safeJoin(stagingRoot, relPath);
          if (entry.type === 'Directory') {
            await ensureDir(abs);
            entry.autodrain();
            continue;
          }
          await ensureDir(path.dirname(abs));
          await pipeline(entry, createWriteStream(abs));
        }

        const uploadedEntrypoints = await listTemplateEntrypointsFromRoot(stagingRoot);
        if (!uploadedEntrypoints.length) {
          await fs.rm(stagingRoot, { recursive: true, force: true });
          stagingRoot = '';
          return reply.code(400).send({ ok: false, error: 'Template archive does not contain a valid LaTeX entrypoint.' });
        }

        const resolvedMainFile = resolvePreferredTemplateMainFile(uploadedEntrypoints, templateMainFile);
        if (!resolvedMainFile) {
          await fs.rm(stagingRoot, { recursive: true, force: true });
          stagingRoot = '';
          return reply.code(400).send({
            ok: false,
            error: 'Template archive contains multiple entrypoints. Please specify mainFile.',
            code: 'MULTIPLE_TEMPLATE_ENTRYPOINTS',
            entrypoints: uploadedEntrypoints,
          });
        }
        templateMainFile = resolvedMainFile;

        await fs.rm(templateRoot, { recursive: true, force: true });
        await fs.rename(stagingRoot, templateRoot);
        stagingRoot = '';
      }
    } catch (err) {
      if (stagingRoot) {
        await fs.rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
      }
      fastify.log.error({ err }, 'template upload failed');
      return reply.code(500).send({ ok: false, error: 'Template upload failed.' });
    }

    if (!hasZip || !templateId) {
      return reply.code(400).send({ ok: false, error: 'Missing templateId or zip file.' });
    }

    await addTemplateToManifest({
      id: templateId,
      label: templateLabel || templateId,
      mainFile: templateMainFile,
      category: 'academic',
      description: templateLabel || templateId,
      descriptionEn: templateLabel || templateId,
      tags: [],
      author: 'User',
      featured: false,
    });

    return { ok: true, templateId };
  });
}
