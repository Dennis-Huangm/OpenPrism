import path from 'path';

export function safeJoin(root, targetPath) {
  const sanitized = targetPath.replace(/^\/+/, '');
  const resolved = path.resolve(root, sanitized);
  if (!resolved.startsWith(root + path.sep) && resolved !== root) {
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

export function normalizeProjectPath(value) {
  if (typeof value !== 'string') return '';
  const normalized = value.replace(/\\/g, '/').trim().replace(/^\/+/, '');
  if (!normalized || normalized === '.') return '';
  const parts = [];
  for (const part of normalized.split('/')) {
    if (!part || part === '.') {
      continue;
    }
    if (part === '..') {
      if (parts.length === 0) {
        return '';
      }
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join('/');
}
