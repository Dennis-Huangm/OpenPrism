import { promises as fs } from 'fs';
import path from 'path';
import { parsePdfWithMineru as callMineru } from '../../mineruService.js';
import { ensureDir } from '../../../utils/fsUtils.js';
import { getProjectRoot } from '../../projectService.js';

/**
 * parsePdfWithMineru node — calls MinerU API to parse the source PDF
 * into Markdown + images.
 */
export async function parsePdfWithMineru(state) {
  const targetProjectRoot = state.targetProjectRoot || await getProjectRoot(state.targetProjectId);
  const outputDir = path.join(targetProjectRoot, '_mineru_output');
  await ensureDir(outputDir);

  const result = await callMineru(
    state.sourcePdfPath,
    state.mineruConfig,
    outputDir,
  );

  const normalizedImages = [];
  const usedNames = new Set();
  const imagesDir = path.join(targetProjectRoot, 'images');
  await ensureDir(imagesDir);
  for (const image of (result.images || [])) {
    const rawName = image?.name || path.basename(image?.localPath || 'image');
    const parsed = path.parse(rawName);
    let finalName = `${parsed.name}${parsed.ext}`;
    let suffix = 1;
    while (usedNames.has(finalName)) {
      finalName = `${parsed.name}-${suffix}${parsed.ext}`;
      suffix += 1;
    }
    while (true) {
      try {
        await fs.access(path.join(imagesDir, finalName));
        finalName = `${parsed.name}-${suffix}${parsed.ext}`;
        suffix += 1;
      } catch {
        break;
      }
    }
    usedNames.add(finalName);
    normalizedImages.push({ ...image, name: finalName, originalName: rawName });
  }

  const mdLen = (result.markdownContent || '').length;
  const imgCount = normalizedImages.length;
  const markdownRef = result.markdownPath ? path.basename(result.markdownPath) : 'markdown file';

  return {
    sourceMarkdown: result.markdownContent,
    sourceImages: normalizedImages,
    targetProjectRoot,
    mineruOutputDir: outputDir,
    progressLog: `[parsePdfWithMineru] Parsed PDF: ${mdLen} chars markdown, ${imgCount} images. Selected ${markdownRef} (${result.selectionReason || 'default selection'}).`,
  };
}
