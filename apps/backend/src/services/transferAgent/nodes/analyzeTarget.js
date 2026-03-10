import { promises as fs } from 'fs';
import path from 'path';
import { getProjectRoot } from '../../projectService.js';
import { safeJoin } from '../../../utils/pathUtils.js';
import { listFilesRecursive } from '../../../utils/fsUtils.js';

/**
 * Recursively resolve \input{} and \include references.
 */
async function resolveInputs(projectRoot, relPath, visited = new Set()) {
  const normalizedRelPath = path.normalize(relPath).replace(/\\/g, '/');
  if (visited.has(normalizedRelPath)) return '';
  visited.add(normalizedRelPath);

  const absPath = safeJoin(projectRoot, normalizedRelPath);
  let content;
  try {
    content = await fs.readFile(absPath, 'utf8');
  } catch {
    return '';
  }

  const pattern = /\\(?:input|include)\{([^}]+)\}/g;
  let result = '';
  let lastIndex = 0;
  let match;

  while ((match = pattern.exec(content)) !== null) {
    result += content.slice(lastIndex, match.index);
    let ref = match[1].trim();
    if (!path.extname(ref)) ref += '.tex';
    const resolvedRef = path.normalize(path.join(path.dirname(normalizedRelPath), ref)).replace(/\\/g, '/');
    const childContent = await resolveInputs(projectRoot, resolvedRef, visited);
    result += childContent;
    lastIndex = pattern.lastIndex;
  }
  result += content.slice(lastIndex);
  return result;
}

/**
 * Extract preamble (everything before \begin{document}).
 */
function extractPreamble(content) {
  const marker = '\\begin{document}';
  const idx = content.indexOf(marker);
  if (idx === -1) return content;
  return content.slice(0, idx).trim();
}

/**
 * Parse section outline from template content.
 */
function parseOutline(content) {
  const outline = [];
  const pattern = /\\(section|subsection|subsubsection)\*?\{([^}]*)\}/g;
  let match;
  while ((match = pattern.exec(content)) !== null) {
    outline.push({ level: match[1], title: match[2].trim() });
  }
  return outline;
}

/**
 * analyzeTarget node — reads target template project,
 * extracts preamble, outline, and full template content.
 */
export async function analyzeTarget(state) {
  const projectRoot = await getProjectRoot(state.targetProjectId);
  const targetMainFile = state.targetMainFile;

  if (!targetMainFile) {
    throw new Error('Target main file is required.');
  }

  const rootMainPath = safeJoin(projectRoot, targetMainFile);
  let rootContent = '';
  try {
    rootContent = await fs.readFile(rootMainPath, 'utf8');
  } catch {
    throw new Error(`Target main file not found: ${targetMainFile}`);
  }
  if (!rootContent.trim()) {
    throw new Error(`Target main file is empty: ${targetMainFile}`);
  }

  const fullContent = await resolveInputs(projectRoot, targetMainFile);
  if (!fullContent.trim()) {
    throw new Error(`Resolved target template is empty: ${targetMainFile}`);
  }

  const preamble = extractPreamble(fullContent);
  const outline = parseOutline(fullContent);

  return {
    targetProjectRoot: projectRoot,
    targetOutline: outline,
    targetPreamble: preamble,
    targetTemplateContent: fullContent,
    progressLog: `[analyzeTarget] Using ${targetMainFile}. Template has ${outline.length} sections. Preamble length: ${preamble.length} chars.`,
  };
}
