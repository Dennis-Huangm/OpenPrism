import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import websocket from '@fastify/websocket';
import { ensureDir } from './utils/fsUtils.js';
import { ALLOW_LOCAL_AUTH_BYPASS, COLLAB_REQUIRE_TOKEN, COLLAB_TOKEN_SECRET, DATA_DIR, OWNER_TOKEN_SECRET, PORT, TUNNEL_MODE } from './config/constants.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerArxivRoutes } from './routes/arxiv.js';
import { registerProjectRoutes } from './routes/projects.js';
import { registerCompileRoutes } from './routes/compile.js';
import { registerLLMRoutes } from './routes/llm.js';
import { registerVisionRoutes } from './routes/vision.js';
import { registerPlotRoutes } from './routes/plot.js';
import { registerAgentRoutes } from './routes/agent.js';
import { registerCollabRoutes } from './routes/collab.js';
import { registerTransferRoutes } from './routes/transfer.js';
import { tryStartTunnel } from './services/tunnel.js';
import { isLocalBootstrapAllowed, requireAuthIfRemote } from './utils/authUtils.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

const fastify = Fastify({ logger: true });

await fastify.register(cors, { origin: true });
await fastify.register(multipart, {
  limits: {
    fileSize: 200 * 1024 * 1024
  }
});
await fastify.register(websocket);
fastify.decorateRequest('collabAuth', null);

const bootstrapAllowedAtStartup = ALLOW_LOCAL_AUTH_BYPASS && (TUNNEL_MODE === 'false' || TUNNEL_MODE === '0' || TUNNEL_MODE === 'no');
if (COLLAB_REQUIRE_TOKEN && !COLLAB_TOKEN_SECRET && !OWNER_TOKEN_SECRET && !bootstrapAllowedAtStartup) {
  throw new Error('Missing auth secrets: configure OPENPRISM_COLLAB_TOKEN_SECRET or OPENPRISM_OWNER_TOKEN_SECRET');
}

fastify.addHook('preHandler', async (req, reply) => {
  if (!req.url.startsWith('/api')) return;
  if (req.method === 'OPTIONS') return;
  if (req.url.startsWith('/api/health')) return;
  if (req.url.startsWith('/api/collab')) return;
  if (isLocalBootstrapAllowed(req)) {
    req.collabAuth = null;
    return;
  }
  const auth = requireAuthIfRemote(req);
  if (!auth.ok) {
    reply.code(401).send({ ok: false, error: 'Unauthorized' });
  }
  req.collabAuth = auth.payload || null;
});

registerHealthRoutes(fastify);
registerArxivRoutes(fastify);
registerProjectRoutes(fastify);
registerCompileRoutes(fastify);
registerLLMRoutes(fastify);
registerVisionRoutes(fastify);
registerPlotRoutes(fastify);
registerAgentRoutes(fastify);
registerCollabRoutes(fastify);
registerTransferRoutes(fastify);

// Serve frontend static files in tunnel/production mode
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const frontendDist = join(__dirname, '../../frontend/dist');

if (existsSync(frontendDist)) {
  const fastifyStatic = await import('@fastify/static');
  await fastify.register(fastifyStatic.default, {
    root: frontendDist,
    prefix: '/',
    wildcard: false,
  });

  // SPA fallback: serve index.html for non-API routes
  fastify.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api')) {
      reply.code(404).send({ error: 'Not Found' });
    } else {
      reply.sendFile('index.html');
    }
  });
}

await ensureDir(DATA_DIR);

await fastify.listen({ port: PORT, host: '0.0.0.0' });

console.log('');
console.log(`  OpenPrism started at http://localhost:${PORT}`);
console.log('');

const tunnelMode = TUNNEL_MODE.toLowerCase().trim();
if (tunnelMode !== 'false' && tunnelMode !== '0' && tunnelMode !== 'no') {
  console.log('  Tunnel starting...');
  const result = await tryStartTunnel(PORT);
  if (result) {
    console.log(`  Tunnel active (${result.provider}):`);
    console.log(`  Public URL: ${result.url}`);
    console.log('  Share this URL to collaborate remotely!');
    console.log('');
  } else {
    console.log('  Tunnel failed to start. Check that the provider is installed.');
    console.log('');
  }
} else {
  console.log('  Want remote collaboration? Start with tunnel:');
  console.log('    OPENPRISM_TUNNEL=localtunnel npm start');
  console.log('    OPENPRISM_TUNNEL=cloudflared npm start');
  console.log('    OPENPRISM_TUNNEL=ngrok npm start');
  console.log('');
}
