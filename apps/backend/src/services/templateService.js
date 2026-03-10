import { promises as fs } from 'fs';
import path from 'path';
import { TEMPLATE_DIR, TEMPLATE_MANIFEST } from '../config/constants.js';
import { ensureDir, readJson, writeJson, listFilesRecursive } from '../utils/fsUtils.js';
import { safeJoin } from '../utils/pathUtils.js';

function isValidTemplateId(templateId) {
  return /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(String(templateId || ''));
}

export async function readTemplateManifest() {
  // Read manifest
  let manifestTemplates = [];
  let categories = [];
  try {
    const data = await readJson(TEMPLATE_MANIFEST);
    manifestTemplates = Array.isArray(data?.templates) ? data.templates : [];
    categories = Array.isArray(data?.categories) ? data.categories : [];
  } catch { /* ignore */ }

  // Scan templates directory for dirs not in manifest
  const knownIds = new Set(manifestTemplates.map(t => t.id));
  try {
    await ensureDir(TEMPLATE_DIR);
    const entries = await fs.readdir(TEMPLATE_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === 'node_modules') continue;
      if (entry.name.startsWith('.')) continue;
      if (knownIds.has(entry.name)) continue;
      const entrypoints = await listTemplateEntrypoints(entry.name);
      const mainFile = resolvePreferredTemplateMainFile(entrypoints);
      if (!mainFile) continue;
      manifestTemplates.push({
        id: entry.name,
        label: entry.name,
        mainFile,
        category: 'academic',
        description: entry.name,
        descriptionEn: entry.name,
        tags: [],
        author: '',
        featured: false,
      });
    }
  } catch { /* ignore */ }

  return { templates: manifestTemplates, categories };
}

export async function addTemplateToManifest(entry) {
  const templateId = String(entry?.id || '').trim();
  if (!isValidTemplateId(templateId)) {
    throw new Error(`Invalid templateId: ${templateId}`);
  }

  const entrypoints = await listTemplateEntrypoints(templateId);
  const resolvedMainFile = resolvePreferredTemplateMainFile(entrypoints, entry?.mainFile);
  if (!resolvedMainFile) {
    throw new Error(`A valid mainFile is required for template ${templateId}`);
  }

  let data = { templates: [], categories: [] };
  try {
    data = await readJson(TEMPLATE_MANIFEST);
  } catch { /* ignore */ }
  const templates = Array.isArray(data.templates) ? data.templates : [];
  const exists = templates.findIndex(t => t.id === templateId);
  const nextEntry = { ...entry, id: templateId, mainFile: resolvedMainFile };
  if (exists >= 0) {
    templates[exists] = { ...templates[exists], ...nextEntry };
  } else {
    templates.push(nextEntry);
  }
  data.templates = templates;
  await writeJson(TEMPLATE_MANIFEST, data);
}

function isTemplateEntrypoint(content) {
  const text = String(content || '');
  return /\\documentclass(?:\[[^\]]*\])?\{[^}]+\}/.test(text) && text.includes('\\begin{document}');
}

export function resolvePreferredTemplateMainFile(entrypoints, preferredMainFile = '') {
  if (!Array.isArray(entrypoints) || entrypoints.length === 0) return '';
  if (preferredMainFile && entrypoints.includes(preferredMainFile)) return preferredMainFile;
  if (entrypoints.includes('main.tex')) return 'main.tex';
  if (entrypoints.length === 1) return entrypoints[0];
  return '';
}

export async function listTemplateEntrypointsFromRoot(templateRoot) {
  const allFiles = await listFilesRecursive(templateRoot);
  const texFiles = allFiles
    .filter((file) => file.type === 'file' && file.path.toLowerCase().endsWith('.tex'))
    .map((file) => file.path)
    .sort((a, b) => a.localeCompare(b));

  const entrypoints = [];
  for (const relPath of texFiles) {
    try {
      const absPath = safeJoin(templateRoot, relPath);
      const content = await fs.readFile(absPath, 'utf8');
      if (isTemplateEntrypoint(content)) {
        entrypoints.push(relPath);
      }
    } catch {
      // ignore unreadable files
    }
  }

  return entrypoints;
}

export async function listTemplateEntrypoints(templateId) {
  const templateRoot = safeJoin(TEMPLATE_DIR, templateId);
  return listTemplateEntrypointsFromRoot(templateRoot);
}

export async function copyTemplateIntoProject(templateRoot, projectRoot, templateMainFile = 'main.tex') {
  const changed = [];
  const normalizedTemplateMain = String(templateMainFile || 'main.tex').replace(/\\/g, '/');
  const walk = async (rel = '') => {
    const dirPath = path.join(templateRoot, rel);
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const nextRel = path.join(rel, entry.name);
      if (nextRel.replace(/\\/g, '/') === normalizedTemplateMain) continue;
      const srcPath = path.join(templateRoot, nextRel);
      const destPath = path.join(projectRoot, nextRel);
      if (entry.isDirectory()) {
        await ensureDir(destPath);
        await walk(nextRel);
      } else {
        const ext = path.extname(entry.name).toLowerCase();
        const shouldOverwrite = ext && ext !== '.tex';
        try {
          await fs.access(destPath);
          if (!shouldOverwrite) continue;
        } catch {
          // file missing; proceed to copy
        }
        await ensureDir(path.dirname(destPath));
        await fs.copyFile(srcPath, destPath);
        changed.push(nextRel);
      }
    }
  };
  await walk('');
  return changed;
}
