import crypto from 'crypto';
import path from 'path';
import { promises as fs } from 'fs';
import { buildTransferGraph } from '../services/transferAgent/graph.js';
import { buildMineruTransferGraph } from '../services/transferAgent/graphMineru.js';
import { resolveLLMConfig } from '../services/llmService.js';
import { resolveMineruConfig } from '../services/mineruService.js';
import { readTemplateManifest, listTemplateEntrypoints } from '../services/templateService.js';
import { DATA_DIR, TEMPLATE_DIR } from '../config/constants.js';
import { ensureDir, readJson, writeJson, copyDir } from '../utils/fsUtils.js';

// In-memory job store: jobId → { graph, state, status, progressLog }
const jobs = new Map();

export function registerTransferRoutes(fastify) {

  /**
   * POST /api/transfer/start
   * Body: { sourceProjectId, sourceMainFile, targetTemplateId, targetMainFile,
   *         engine?, layoutCheck?, llmConfig? }
   * Creates a new project from the target template, then starts the transfer.
   * Returns: { jobId, newProjectId }
   */
  fastify.post('/api/transfer/start', async (request, reply) => {
    const {
      sourceProjectId, sourceMainFile,
      targetTemplateId, targetMainFile,
      engine = 'pdflatex',
      layoutCheck = false,
      llmConfig,
    } = request.body || {};

    if (!sourceProjectId || !sourceMainFile || !targetTemplateId || !targetMainFile) {
      return reply.code(400).send({ error: 'Missing required fields.' });
    }

    // Validate template exists
    const { templates } = await readTemplateManifest();
    const template = templates.find(t => t.id === targetTemplateId);
    if (!template) {
      return reply.code(400).send({ error: `Unknown template: ${targetTemplateId}` });
    }

    const allowedTargetFiles = await listTemplateEntrypoints(targetTemplateId);
    if (!allowedTargetFiles.includes(targetMainFile)) {
      return reply.code(400).send({ error: `Invalid targetMainFile for template ${targetTemplateId}: ${targetMainFile}` });
    }

    // Create a new project from the template
    await ensureDir(DATA_DIR);
    const newProjectId = crypto.randomUUID();
    const projectRoot = path.join(DATA_DIR, newProjectId);
    await ensureDir(projectRoot);

    // Read source project name for the new project name
    let sourceName = 'Untitled';
    try {
      const srcMeta = await readJson(path.join(DATA_DIR, sourceProjectId, 'project.json'));
      sourceName = srcMeta.name || 'Untitled';
    } catch { /* ignore */ }

    const meta = {
      id: newProjectId,
      name: `${sourceName} (${template.label})`,
      createdAt: new Date().toISOString(),
      mainFile: targetMainFile,
    };
    await writeJson(path.join(projectRoot, 'project.json'), meta);

    // Copy template files into the new project
    const templateRoot = path.join(TEMPLATE_DIR, targetTemplateId);
    await copyDir(templateRoot, projectRoot);

    // Build transfer graph
    const jobId = crypto.randomUUID();
    const graph = buildTransferGraph();

    const initialState = {
      sourceProjectId,
      sourceMainFile,
      targetProjectId: newProjectId,
      targetMainFile,
      engine,
      layoutCheck,
      llmConfig: resolveLLMConfig(llmConfig),
      jobId,
    };

    jobs.set(jobId, {
      graph,
      state: initialState,
      status: 'pending',
      progressLog: [],
      hasStarted: false,
      iterator: null,
    });

    return { jobId, newProjectId };
  });

  /**
   * POST /api/transfer/step
   * Body: { jobId }
   * Runs the graph one step forward.
   * Returns: { status, currentNode, progressLog }
   */
  fastify.post('/api/transfer/step', async (request, reply) => {
    const { jobId } = request.body || {};
    const job = jobs.get(jobId);
    if (!job) {
      return reply.code(404).send({ error: 'Job not found.' });
    }

    // If waiting for images, don't proceed
    if (job.status === 'waiting_images') {
      return { status: 'waiting_images', progressLog: job.progressLog };
    }

    try {
      job.status = 'running';
      const runConfig = { configurable: { thread_id: jobId } };
      const input = job.hasStarted ? null : job.state;
      const result = await job.graph.invoke(input, runConfig);
      job.hasStarted = true;
      job.state = result;
      job.progressLog = result.progressLog || [];
      job.status = result.status || 'running';

      return {
        status: job.status,
        progressLog: job.progressLog,
      };
    } catch (err) {
      fastify.log.error({ err }, 'transfer step failed');
      const msg = 'Transfer failed.';
      job.status = 'error';
      job.error = msg;
      return reply.code(500).send({
        error: msg,
        progressLog: job.progressLog,
      });
    }
  });

  /**
   * POST /api/transfer/submit-images
   * Body: { jobId, images: [{ page, base64, mime }] }
   * Frontend submits PDF page screenshots for VLM layout check.
   */
  fastify.post('/api/transfer/submit-images', async (request, reply) => {
    const { jobId, images } = request.body || {};
    const job = jobs.get(jobId);
    if (!job) {
      return reply.code(404).send({ error: 'Job not found.' });
    }

    if (job.status !== 'waiting_images') {
      return reply.code(400).send({ error: 'Job is not waiting for images.' });
    }

    // Inject images into checkpointed state so the next /step can resume from checkLayout.
    const updated = { pageImages: images || [], status: 'running' };
    try {
      if (job.hasStarted && typeof job.graph.updateState === 'function') {
        await job.graph.updateState(
          { configurable: { thread_id: jobId } },
          updated,
        );
      }
    } catch {
      // Fallback to in-memory state mutation if checkpoint update fails.
    }
    job.state = { ...job.state, ...updated };
    job.status = 'running';

    return { ok: true };
  });

  /**
   * GET /api/transfer/status/:jobId
   * Returns current job status and progress log.
   */
  fastify.get('/api/transfer/status/:jobId', async (request, reply) => {
    const job = jobs.get(request.params.jobId);
    if (!job) {
      return reply.code(404).send({ error: 'Job not found.' });
    }

    return {
      status: job.status,
      progressLog: job.progressLog,
      error: job.error || null,
    };
  });

  /**
   * POST /api/transfer/start-mineru
   * Body: { sourceProjectId?, sourceMainFile?, targetTemplateId, targetMainFile,
   *         engine?, layoutCheck?, llmConfig?, mineruConfig? }
   * MinerU-based transfer: PDF → Markdown → LaTeX.
   * If sourceProjectId is provided, compiles source to PDF first.
   * If not, expects PDF to be uploaded via /api/transfer/upload-pdf.
   * Returns: { jobId, newProjectId }
   */
  fastify.post('/api/transfer/start-mineru', async (request, reply) => {
    const {
      sourceProjectId, sourceMainFile,
      targetTemplateId, targetMainFile,
      engine = 'pdflatex',
      layoutCheck = false,
      llmConfig,
      mineruConfig,
    } = request.body || {};

    if (!targetTemplateId || !targetMainFile) {
      return reply.code(400).send({ error: 'Missing targetTemplateId or targetMainFile.' });
    }
    if (!!sourceProjectId !== !!sourceMainFile) {
      return reply.code(400).send({
        error: 'sourceProjectId and sourceMainFile must be provided together, or both omitted.',
      });
    }

    // Validate template
    const { templates } = await readTemplateManifest();
    const template = templates.find(t => t.id === targetTemplateId);
    if (!template) {
      return reply.code(400).send({ error: `Unknown template: ${targetTemplateId}` });
    }

    const allowedTargetFiles = await listTemplateEntrypoints(targetTemplateId);
    if (!allowedTargetFiles.includes(targetMainFile)) {
      return reply.code(400).send({ error: `Invalid targetMainFile for template ${targetTemplateId}: ${targetMainFile}` });
    }

    // Create new project from template
    await ensureDir(DATA_DIR);
    const newProjectId = crypto.randomUUID();
    const projectRoot = path.join(DATA_DIR, newProjectId);
    await ensureDir(projectRoot);

    let sourceName = 'Untitled';
    if (sourceProjectId) {
      try {
        const srcMeta = await readJson(path.join(DATA_DIR, sourceProjectId, 'project.json'));
        sourceName = srcMeta.name || 'Untitled';
      } catch { /* ignore */ }
    }

    const meta = {
      id: newProjectId,
      name: `${sourceName} (${template.label})`,
      createdAt: new Date().toISOString(),
      mainFile: targetMainFile,
    };
    await writeJson(path.join(projectRoot, 'project.json'), meta);

    const templateRoot = path.join(TEMPLATE_DIR, targetTemplateId);
    await copyDir(templateRoot, projectRoot);

    // Build MinerU transfer graph
    const jobId = crypto.randomUUID();
    const graph = buildMineruTransferGraph();

    const initialState = {
      sourceProjectId: sourceProjectId || '',
      sourceMainFile: sourceMainFile || '',
      targetProjectId: newProjectId,
      targetMainFile,
      engine,
      layoutCheck,
      llmConfig: resolveLLMConfig(llmConfig),
      mineruConfig: resolveMineruConfig(mineruConfig),
      transferMode: 'mineru',
      jobId,
    };

    jobs.set(jobId, {
      graph,
      state: initialState,
      status: 'pending',
      progressLog: [],
      hasStarted: false,
      iterator: null,
    });

    return { jobId, newProjectId };
  });

  /**
   * POST /api/transfer/upload-pdf
   * Multipart: { jobId, pdf: File }
   * Upload a PDF for MinerU-based transfer (when no source project).
   */
  fastify.post('/api/transfer/upload-pdf', async (request, reply) => {
    const parts = request.parts();
    let jobId = '';
    let pdfBuffer = null;

    for await (const part of parts) {
      if (part.fieldname === 'jobId' && part.type === 'field') {
        jobId = part.value;
      } else if (part.fieldname === 'pdf' && part.type === 'file') {
        const chunks = [];
        for await (const chunk of part.file) {
          chunks.push(chunk);
        }
        pdfBuffer = Buffer.concat(chunks);
      }
    }

    if (!jobId) {
      return reply.code(400).send({ error: 'Missing jobId.' });
    }

    const job = jobs.get(jobId);
    if (!job) {
      return reply.code(404).send({ error: 'Job not found.' });
    }
    if (job.state?.transferMode !== 'mineru') {
      return reply.code(400).send({ error: 'Job is not a MinerU transfer job.' });
    }

    if (!pdfBuffer) {
      return reply.code(400).send({ error: 'No PDF file uploaded.' });
    }

    // Save PDF to target project directory
    const pdfPath = path.join(job.state.targetProjectId
      ? path.join(DATA_DIR, job.state.targetProjectId)
      : DATA_DIR, '_uploaded_source.pdf');
    await ensureDir(path.dirname(pdfPath));
    await fs.writeFile(pdfPath, pdfBuffer);

    // Set sourcePdfPath in state so compileSource skips compilation
    job.state.sourcePdfPath = pdfPath;

    return { ok: true };
  });

} // end registerTransferRoutes
