import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
export const DATA_DIR = path.resolve(REPO_ROOT, process.env.OPENPRISM_DATA_DIR || 'data');
export const TEMPLATE_DIR = path.join(REPO_ROOT, 'templates');
export const TEMPLATE_MANIFEST = path.join(TEMPLATE_DIR, 'manifest.json');
export const PORT = Number(process.env.PORT || 8787);
export const COLLAB_TOKEN_SECRET = process.env.OPENPRISM_COLLAB_TOKEN_SECRET || '';
export const COLLAB_TOKEN_TTL = Number(process.env.OPENPRISM_COLLAB_TOKEN_TTL || 24 * 60 * 60);
const requireTokenEnv = process.env.OPENPRISM_COLLAB_REQUIRE_TOKEN;
export const COLLAB_REQUIRE_TOKEN = requireTokenEnv
  ? !['0', 'false', 'no'].includes(String(requireTokenEnv).toLowerCase())
  : true;
export const COLLAB_FLUSH_DEBOUNCE_MS = Number(process.env.OPENPRISM_COLLAB_FLUSH_DEBOUNCE_MS || 800);
export const TUNNEL_MODE = process.env.OPENPRISM_TUNNEL || 'false';
export const OWNER_TOKEN_SECRET = process.env.OPENPRISM_OWNER_TOKEN_SECRET || '';
const localBypassEnv = process.env.OPENPRISM_ALLOW_LOCAL_AUTH_BYPASS;
export const ALLOW_LOCAL_AUTH_BYPASS = localBypassEnv
  ? !['0', 'false', 'no'].includes(String(localBypassEnv).toLowerCase())
  : process.env.NODE_ENV !== 'production';

// MinerU API
export const MINERU_API_BASE = 'https://mineru.net/api/v4';
export const MINERU_POLL_INTERVAL_MS = 3000;
export const MINERU_MAX_POLL_ATTEMPTS = 200;

function positiveFiniteNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const MAX_IMPORT_ARCHIVE_FILES = positiveFiniteNumber(process.env.OPENPRISM_MAX_IMPORT_ARCHIVE_FILES, 5000);
export const MAX_IMPORT_ARCHIVE_BYTES = positiveFiniteNumber(process.env.OPENPRISM_MAX_IMPORT_ARCHIVE_BYTES, 200 * 1024 * 1024);
export const MAX_IMPORT_ARCHIVE_ENTRY_BYTES = positiveFiniteNumber(process.env.OPENPRISM_MAX_IMPORT_ARCHIVE_ENTRY_BYTES, 50 * 1024 * 1024);
