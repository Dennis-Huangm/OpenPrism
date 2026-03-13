import path from 'path';
import { safeJoin, sanitizeUploadPath } from '../utils/pathUtils.js';
import { ensureDir } from '../utils/fsUtils.js';
import { getProjectRoot } from '../services/projectService.js';
import { resolveLLMConfig, callOpenAICompatible } from '../services/llmService.js';
import { runPythonPlot } from '../services/plotService.js';
import { authorizeProjectAccess } from '../utils/authUtils.js';

export function registerPlotRoutes(fastify) {
  fastify.post('/api/plot/from-table', async (req, reply) => {
    const { projectId, tableLatex, chartType, title, prompt, filename, llmConfig, retries } = req.body || {};
    if (!projectId) return { ok: false, error: 'Missing projectId.' };
    const authz = authorizeProjectAccess(req, projectId);
    if (!authz.ok) {
      return reply.code(authz.statusCode).send({ ok: false, error: authz.error });
    }
    if (!tableLatex) return { ok: false, error: 'Missing tableLatex.' };
    const projectRoot = await getProjectRoot(projectId);
    const safeNameBase = sanitizeUploadPath(filename || `plot_${Date.now()}.png`) || `plot_${Date.now()}.png`;
    const ext = path.extname(safeNameBase);
    const finalName = ext ? safeNameBase : `${safeNameBase}.png`;
    const assetRel = path.join('assets', 'plots', finalName);
    const abs = safeJoin(projectRoot, assetRel);
    await ensureDir(path.dirname(abs));

    const resolved = resolveLLMConfig(llmConfig);
    if (!resolved.apiKey) {
      return { ok: false, error: 'OPENPRISM_LLM_API_KEY not set' };
    }
    const baseSystem = [
      'You generate python plotting code using matplotlib (and seaborn if available).',
      'You are given: rows (list of rows), header (list of column names).',
      'If pandas is available, df and df_numeric are provided; otherwise df is None.',
      'Do not import packages. Do not call plt.savefig.',
      'Use chart_type if helpful.',
      'Return ONLY python code.'
    ].join(' ');

    const buildUser = (note, errorText, lastCode) => [
      `chart_type: ${chartType || 'bar'}`,
      note ? `user_prompt: ${note}` : '',
      errorText ? `runtime_error:\n${errorText}` : '',
      lastCode ? `previous_code:\n${lastCode}` : ''
    ].filter(Boolean).join('\n');

    let plotCode = '';
    let lastError = '';
    const maxRetries = Math.min(5, Math.max(0, Number(retries ?? 2)));
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const codeRes = await callOpenAICompatible({
        messages: [
          { role: 'system', content: baseSystem },
          { role: 'user', content: buildUser(prompt, lastError, plotCode) }
        ],
        model: resolved.model,
        endpoint: resolved.endpoint,
        apiKey: resolved.apiKey
      });
      if (!codeRes.ok || !codeRes.content) {
        return { ok: false, error: codeRes.error || 'Plot code generation failed.' };
      }
      plotCode = String(codeRes.content)
        .replace(/```python/g, '')
        .replace(/```/g, '')
        .trim();

      const payload = {
        tableLatex,
        chartType,
        title,
        outputPath: abs,
        plotCode
      };
      const result = await runPythonPlot(payload);
      if (result.ok) {
        return { ok: true, assetPath: assetRel.replace(/\\/g, '/') };
      }
      lastError = result.error || 'Plot render failed.';
    }
    return { ok: false, error: lastError || 'Plot render failed.' };
  });
}
