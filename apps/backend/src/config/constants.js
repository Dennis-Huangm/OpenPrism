import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function resolveDataDirPath(value) {
  if (!value) return path.join(REPO_ROOT, 'data');
  if (process.platform === 'win32') {
    const msysMatch = value.match(/^\/([a-zA-Z])\/(.*)$/);
    if (msysMatch) {
      const [, drive, rest] = msysMatch;
      return path.resolve(`${drive.toUpperCase()}:/${rest}`);
    }
  }
  return path.isAbsolute(value) ? value : path.resolve(REPO_ROOT, value);
}

export const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
export const DATA_DIR = resolveDataDirPath(process.env.OPENPRISM_DATA_DIR);
export const TEMPLATE_DIR = path.join(REPO_ROOT, 'templates');
export const TEMPLATE_MANIFEST = path.join(TEMPLATE_DIR, 'manifest.json');
export const PORT = Number(process.env.PORT || 8787);
export const COLLAB_TOKEN_SECRET = process.env.OPENPRISM_COLLAB_TOKEN_SECRET || 'openprism-collab-dev';
export const COLLAB_TOKEN_TTL = Number(process.env.OPENPRISM_COLLAB_TOKEN_TTL || 24 * 60 * 60);
const requireTokenEnv = process.env.OPENPRISM_COLLAB_REQUIRE_TOKEN;
export const COLLAB_REQUIRE_TOKEN = requireTokenEnv
  ? !['0', 'false', 'no'].includes(String(requireTokenEnv).toLowerCase())
  : true;
export const COLLAB_FLUSH_DEBOUNCE_MS = Number(process.env.OPENPRISM_COLLAB_FLUSH_DEBOUNCE_MS || 800);
export const TUNNEL_MODE = process.env.OPENPRISM_TUNNEL || 'false';

// MinerU API
export const MINERU_API_BASE = 'https://mineru.net/api/v4';
export const MINERU_POLL_INTERVAL_MS = 3000;
export const MINERU_MAX_POLL_ATTEMPTS = 200;
