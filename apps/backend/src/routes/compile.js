import { runCompile, SUPPORTED_ENGINES } from '../services/compileService.js';
import { authorizeProjectAccess } from '../utils/authUtils.js';

export function registerCompileRoutes(fastify) {
  fastify.post('/api/compile', async (req, reply) => {
    const { projectId, mainFile = 'main.tex', engine = 'pdflatex' } = req.body || {};
    if (!projectId) {
      return { ok: false, error: 'Missing projectId.' };
    }
    const authz = authorizeProjectAccess(req, projectId);
    if (!authz.ok) {
      return reply.code(authz.statusCode).send({ ok: false, error: authz.error });
    }
    if (!SUPPORTED_ENGINES.includes(engine)) {
      return { ok: false, error: `Unsupported engine: ${engine}. Supported: ${SUPPORTED_ENGINES.join(', ')}` };
    }
    return runCompile({ projectId, mainFile, engine });
  });
}
