import path from 'path';

function normalizeRelativePath(targetPath) {
  const normalized = String(targetPath || '').replace(/^\/+/, '');
  if (!normalized) {
    throw new Error('Invalid path');
  }
  return normalized;
}

export function safeJoin(root, targetPath) {
  const normalized = normalizeRelativePath(targetPath);
  const resolved = path.resolve(root, normalized);
  if (!resolved.startsWith(root + path.sep) && resolved !== root) {
    throw new Error('Invalid path');
  }
  if (resolved === root) {
    throw new Error('Invalid path');
  }
  return resolved;
}

export function sanitizeUploadPath(filename) {
  if (!filename) return '';
  const normalized = filename.replace(/\\/g, '/').replace(/^\/+/, '');
  const parts = normalized.split('/').filter((part) => part && part !== '.' && part !== '..');
  return parts.join('/');
}
