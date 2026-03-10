import { promises as fs } from 'fs';
import net from 'net';
import path from 'path';
import { MINERU_API_BASE, MINERU_POLL_INTERVAL_MS, MINERU_MAX_POLL_ATTEMPTS } from '../config/constants.js';
import { ensureDir } from '../utils/fsUtils.js';
import { safeJoin } from '../utils/pathUtils.js';

const MINERU_MAX_FILE_BYTES = 200 * 1024 * 1024;
const MINERU_REQUEST_TIMEOUT_MS = Math.max(1000, Number(process.env.OPENPRISM_MINERU_REQUEST_TIMEOUT_MS) || 120000);
const MINERU_TRANSFER_TIMEOUT_MS = Math.max(MINERU_REQUEST_TIMEOUT_MS, Number(process.env.OPENPRISM_MINERU_TRANSFER_TIMEOUT_MS) || 600000);
const MINERU_ALLOWED_HOSTS_ENV = 'OPENPRISM_MINERU_ALLOWED_HOSTS';
const MINERU_DEFAULT_ALLOWED_HOSTS = [
  'mineru.net',
  'mineru.oss-cn-shanghai.aliyuncs.com',
  'cdn-mineru.openxlab.org.cn',
];

function withMineruCause(message, cause) {
  const error = new Error(message);
  if (cause) {
    error.cause = cause;
  }
  return error;
}

function createMineruTimeoutError(timeoutMs) {
  return withMineruCause(`MinerU request timed out after ${timeoutMs}ms`, { timeoutMs });
}

function getAllowedMineruHosts(apiBase) {
  const apiHost = new URL(String(apiBase)).host;
  const configuredHosts = String(process.env[MINERU_ALLOWED_HOSTS_ENV] || '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  return new Set([
    apiHost.toLowerCase(),
    ...MINERU_DEFAULT_ALLOWED_HOSTS,
    ...configuredHosts,
  ]);
}

function assertAllowedMineruUrl(url, apiBase) {
  let parsedUrl;
  try {
    parsedUrl = new URL(String(url));
  } catch {
    throw new Error('MinerU returned an invalid URL.');
  }

  if (parsedUrl.protocol !== 'https:') {
    throw new Error('MinerU returned an unsupported URL protocol.');
  }
  if (parsedUrl.username || parsedUrl.password) {
    throw new Error('MinerU returned a URL with embedded credentials.');
  }
  if (net.isIP(parsedUrl.hostname)) {
    throw new Error('MinerU returned a URL with a disallowed host.');
  }

  const allowedHosts = getAllowedMineruHosts(apiBase);
  if (!allowedHosts.has(parsedUrl.host.toLowerCase())) {
    throw new Error('MinerU returned a URL for an unexpected host.');
  }
}

function createRequestTimeout(timeoutMs, upstreamSignal) {
  const controller = new AbortController();
  let timedOut = false;
  let cleanedUp = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  return {
    signal: upstreamSignal ? AbortSignal.any([upstreamSignal, controller.signal]) : controller.signal,
    timeoutMs,
    didTimeout: () => timedOut,
    cleanup: () => {
      if (cleanedUp) return;
      cleanedUp = true;
      clearTimeout(timeoutId);
    },
  };
}

async function fetchResponseWithTimeout(url, options = {}, timeoutMs = MINERU_REQUEST_TIMEOUT_MS) {
  const requestTimeout = createRequestTimeout(timeoutMs, options?.signal);
  try {
    const response = await fetch(url, { ...options, redirect: 'error', signal: requestTimeout.signal });
    return { response, requestTimeout };
  } catch (error) {
    requestTimeout.cleanup();
    if (requestTimeout.didTimeout() && error?.name === 'AbortError') {
      throw createMineruTimeoutError(timeoutMs);
    }
    throw error;
  }
}

async function readResponseTextWithTimeout({ response, requestTimeout }) {
  try {
    return await response.text();
  } catch (error) {
    if (requestTimeout.didTimeout() && error?.name === 'AbortError') {
      throw createMineruTimeoutError(requestTimeout.timeoutMs);
    }
    throw error;
  } finally {
    requestTimeout.cleanup();
  }
}

async function readResponseArrayBufferWithTimeout({ response, requestTimeout }) {
  try {
    return await response.arrayBuffer();
  } catch (error) {
    if (requestTimeout.didTimeout() && error?.name === 'AbortError') {
      throw createMineruTimeoutError(requestTimeout.timeoutMs);
    }
    throw error;
  } finally {
    requestTimeout.cleanup();
  }
}

/**
 * Resolve MinerU configuration from request config or environment variables.
 * apiBase is controlled server-side and cannot be overridden by the frontend.
 */
export function resolveMineruConfig(mineruConfig) {
  if (mineruConfig?.apiBase) {
    throw new Error('MinerU apiBase override is not supported. Configure OPENPRISM_MINERU_API_BASE on the server.');
  }
  if (mineruConfig?.callback) {
    throw new Error('MinerU callback is not supported.');
  }

  const rawBase = (process.env.OPENPRISM_MINERU_API_BASE || MINERU_API_BASE).trim();
  const rawExtraFormats = Array.isArray(mineruConfig?.extraFormats) ? mineruConfig.extraFormats : [];
  const extraFormats = rawExtraFormats
    .map(v => String(v || '').trim().toLowerCase())
    .filter(v => ['docx', 'html', 'latex'].includes(v));

  return {
    apiBase: rawBase.replace(/\/+$/, ''),
    token: (mineruConfig?.token || process.env.OPENPRISM_MINERU_TOKEN || '').trim(),
    modelVersion: mineruConfig?.modelVersion || 'vlm',
    isOcr: typeof mineruConfig?.isOcr === 'boolean' ? mineruConfig.isOcr : undefined,
    enableFormula: typeof mineruConfig?.enableFormula === 'boolean' ? mineruConfig.enableFormula : true,
    enableTable: typeof mineruConfig?.enableTable === 'boolean' ? mineruConfig.enableTable : true,
    language: typeof mineruConfig?.language === 'string' ? mineruConfig.language.trim() : '',
    pageRanges: typeof mineruConfig?.pageRanges === 'string' ? mineruConfig.pageRanges.trim() : '',
    dataId: typeof mineruConfig?.dataId === 'string' ? mineruConfig.dataId.trim() : '',
    callback: '',
    seed: typeof mineruConfig?.seed === 'string' ? mineruConfig.seed.trim() : '',
    extraFormats,
  };
}

/**
 * Request a presigned upload URL from MinerU API.
 * POST /file-urls/batch
 */
async function requestUploadUrl(apiBase, token, fileName, modelVersion, options = {}) {
  const url = `${apiBase}/file-urls/batch`;
  const file = { name: fileName };
  if (typeof options.isOcr === 'boolean') file.is_ocr = options.isOcr;
  if (options.dataId) file.data_id = options.dataId;
  if (options.pageRanges) file.page_ranges = options.pageRanges;

  const payload = {
    files: [file],
    model_version: modelVersion,
    enable_formula: options.enableFormula,
    enable_table: options.enableTable,
  };
  if (options.language) payload.language = options.language;
  if (options.callback) payload.callback = options.callback;
  if (options.seed) payload.seed = options.seed;
  if (options.extraFormats?.length) payload.extra_formats = options.extraFormats;

  const result = await fetchResponseWithTimeout(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });

  const text = await readResponseTextWithTimeout(result);
  if (!result.response.ok) {
    throw withMineruCause(`MinerU requestUploadUrl failed (${result.response.status})`, { status: result.response.status });
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`MinerU requestUploadUrl: invalid JSON response`);
  }

  if (data.code !== 0) {
    throw withMineruCause('MinerU requestUploadUrl error');
  }

  const batchId = data.data?.batch_id;
  const fileUrls = data.data?.file_urls;
  if (!batchId || !fileUrls?.length) {
    throw new Error('MinerU requestUploadUrl: missing batch_id or file_urls');
  }

  assertAllowedMineruUrl(fileUrls[0], apiBase);
  return { batchId, uploadUrl: fileUrls[0] };
}

/**
 * Upload PDF buffer to the presigned URL.
 */
async function uploadPdfToMineru(uploadUrl, pdfBuffer) {
  const result = await fetchResponseWithTimeout(uploadUrl, {
    method: 'PUT',
    body: pdfBuffer,
  }, MINERU_TRANSFER_TIMEOUT_MS);

  if (!result.response.ok) {
    const text = await readResponseTextWithTimeout(result);
    throw withMineruCause(`MinerU upload failed (${result.response.status})`, { status: result.response.status });
  }
  result.requestTimeout.cleanup();
}

/**
 * Poll MinerU for extraction results.
 * GET /extract-results/batch/{batchId}
 */
async function pollMineruResult(apiBase, token, batchId, onProgress) {
  const url = `${apiBase}/extract-results/batch/${batchId}`;
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };

  for (let attempt = 0; attempt < MINERU_MAX_POLL_ATTEMPTS; attempt++) {
    const pollResponse = await fetchResponseWithTimeout(url, { headers });
    const text = await readResponseTextWithTimeout(pollResponse);

    if (!pollResponse.response.ok) {
      throw withMineruCause(`MinerU poll failed (${pollResponse.response.status})`, { status: pollResponse.response.status });
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error('MinerU poll: invalid JSON response');
    }

    if (data.code !== 0) {
      throw withMineruCause('MinerU poll error');
    }

    const results = data.data?.extract_result;
    if (!results?.length) {
      await sleep(MINERU_POLL_INTERVAL_MS);
      continue;
    }

    const result = results[0];
    const state = result.state;

    if (onProgress) {
      onProgress({
        state,
        extractedPages: result.extract_progress?.extracted_pages,
        totalPages: result.extract_progress?.total_pages,
      });
    }

    if (state === 'done') {
      if (!result.full_zip_url) {
        throw new Error('MinerU: task done but no full_zip_url');
      }
      assertAllowedMineruUrl(result.full_zip_url, apiBase);
      return { zipUrl: result.full_zip_url };
    }

    if (state === 'failed') {
      throw withMineruCause('MinerU extraction failed');
    }

    // Still processing: pending, running, converting, waiting-file
    await sleep(MINERU_POLL_INTERVAL_MS);
  }

  throw new Error('MinerU: polling timed out');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Download a zip file from URL and extract it to outputDir.
 * Returns { markdownContent, images, jsonContent }
 */
async function downloadAndExtractZip(zipUrl, outputDir) {
  // Dynamic import to avoid issues if not installed
  const { default: unzipper } = await import('unzipper');

  // Clear previous extraction output to avoid stale-file contamination.
  await fs.rm(outputDir, { recursive: true, force: true });
  await ensureDir(outputDir);

  // Download zip
  const result = await fetchResponseWithTimeout(zipUrl, {}, MINERU_TRANSFER_TIMEOUT_MS);
  if (!result.response.ok) {
    const text = await readResponseTextWithTimeout(result);
    throw withMineruCause(`Failed to download MinerU zip (${result.response.status})`, { status: result.response.status });
  }

  const arrayBuffer = await readResponseArrayBufferWithTimeout(result);
  const zipBuffer = Buffer.from(arrayBuffer);

  // Extract zip to outputDir
  const directory = await unzipper.Open.buffer(zipBuffer);
  for (const file of directory.files) {
    if (file.type === 'Directory') continue;
    const normalized = file.path.replace(/\\/g, '/');
    let filePath;
    try {
      filePath = safeJoin(outputDir, normalized);
    } catch {
      throw new Error(`Unsafe path in MinerU zip: ${file.path}`);
    }
    await ensureDir(path.dirname(filePath));
    const content = await file.buffer();
    await fs.writeFile(filePath, content);
  }

  // Find markdown file and images
  return await parseExtractedOutput(outputDir);
}

/**
 * Parse the extracted MinerU output directory.
 * MinerU output structure varies but typically:
 *   <name>/
 *     <name>.md
 *     images/
 *       *.png, *.jpg
 *     <name>_content_list.json (or similar)
 */
async function parseExtractedOutput(outputDir) {
  const markdownCandidates = await findFilesRecursive(outputDir, (filePath) => filePath.toLowerCase().endsWith('.md'));
  const markdownMatch = await chooseBestMarkdownFile(markdownCandidates);
  if (!markdownMatch?.path) {
    throw new Error('MinerU output missing markdown file');
  }
  const markdownPath = markdownMatch.path;
  const searchDir = path.dirname(markdownPath);
  const markdownContent = markdownMatch.content;
  if (!markdownContent.trim()) {
    throw new Error('MinerU output missing markdown content');
  }

  // Collect images: prefer markdown sibling images/, fallback to any images/* in output.
  const images = [];
  const primaryImagesDir = path.join(searchDir, 'images');
  const primary = await listImageFilesRecursive(primaryImagesDir);
  if (primary.length) {
    images.push(...primary);
  } else {
    const fallback = await findFilesUnderDirNamedRecursive(outputDir, 'images', isImageFilePath);
    images.push(...fallback);
  }

  return {
    markdownContent,
    images,
    searchDir,
    markdownPath,
    selectionReason: markdownMatch.reason,
  };
}

async function findFilesRecursive(rootDir, predicate) {
  const out = [];
  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    const abs = path.join(rootDir, entry.name);
    if (entry.isFile()) {
      if (predicate(abs)) out.push(abs);
      continue;
    }
    if (!entry.isDirectory()) continue;
    out.push(...await findFilesRecursive(abs, predicate));
  }
  return out;
}

async function chooseBestMarkdownFile(markdownPaths) {
  if (!Array.isArray(markdownPaths) || markdownPaths.length === 0) return null;

  const matches = [];
  for (const filePath of markdownPaths) {
    const content = await fs.readFile(filePath, 'utf8');
    const trimmed = content.trim();
    matches.push({
      path: filePath,
      content,
      size: Buffer.byteLength(content, 'utf8'),
      isFull: path.basename(filePath).toLowerCase() === 'full.md',
      isNonEmpty: trimmed.length > 0,
    });
  }

  const preferredFull = matches
    .filter((item) => item.isFull && item.isNonEmpty)
    .sort((a, b) => b.size - a.size)[0];
  if (preferredFull) {
    return { path: preferredFull.path, content: preferredFull.content, reason: 'preferred full.md' };
  }

  const largestNonEmpty = matches
    .filter((item) => item.isNonEmpty)
    .sort((a, b) => b.size - a.size)[0];
  if (largestNonEmpty) {
    return { path: largestNonEmpty.path, content: largestNonEmpty.content, reason: 'largest non-empty markdown file' };
  }

  const first = matches.sort((a, b) => a.path.localeCompare(b.path))[0];
  return first ? { path: first.path, content: first.content, reason: 'first markdown file fallback' } : null;
}

function isImageFilePath(filePath) {
  return /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(filePath);
}

async function listImageFilesRecursive(imagesDir) {
  const out = [];
  try {
    const entries = await fs.readdir(imagesDir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(imagesDir, entry.name);
      if (entry.isDirectory()) {
        out.push(...await listImageFilesRecursive(abs));
        continue;
      }
      if (entry.isFile() && isImageFilePath(abs)) {
        out.push({
          name: path.basename(abs),
          localPath: abs,
        });
      }
    }
  } catch {
    // Directory does not exist
  }
  return out;
}

async function findFilesUnderDirNamedRecursive(rootDir, targetDirName, filePredicate) {
  const out = [];
  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const absDir = path.join(rootDir, entry.name);
    if (entry.name === targetDirName) {
      const files = await listImageFilesRecursive(absDir);
      out.push(...files);
    }
    out.push(...await findFilesUnderDirNamedRecursive(absDir, targetDirName, filePredicate));
  }
  if (filePredicate) {
    return out.filter(item => filePredicate(item.localPath));
  }
  return out;
}

/**
 * Main entry: parse a PDF file using MinerU API.
 * @param {string} pdfPath - absolute path to the PDF file
 * @param {object} mineruConfig - { apiBase, token, modelVersion }
 * @param {string} outputDir - directory to extract results into
 * @param {function} onProgress - optional progress callback
 * @returns {{ markdownContent: string, images: Array<{name,localPath}> }}
 */
export async function parsePdfWithMineru(pdfPath, mineruConfig, outputDir, onProgress) {
  const config = resolveMineruConfig(mineruConfig);
  const {
    apiBase,
    token,
    modelVersion,
    isOcr,
    enableFormula,
    enableTable,
    language,
    pageRanges,
    dataId,
    callback,
    seed,
    extraFormats,
  } = config;
  if (!token) {
    throw new Error('MinerU token not configured. Set OPENPRISM_MINERU_TOKEN or provide in settings.');
  }
  if (callback && !seed) {
    throw new Error('MinerU seed is required when callback is provided.');
  }

  const fileName = path.basename(pdfPath);
  const stat = await fs.stat(pdfPath);
  if (stat.size > MINERU_MAX_FILE_BYTES) {
    throw new Error(`MinerU file too large (${stat.size} bytes). Max supported size is ${MINERU_MAX_FILE_BYTES} bytes.`);
  }
  const pdfBuffer = await fs.readFile(pdfPath);

  // Step 1: Request upload URL
  if (onProgress) onProgress({ phase: 'requesting_upload_url' });
  const { batchId, uploadUrl } = await requestUploadUrl(apiBase, token, fileName, modelVersion, {
    isOcr,
    enableFormula,
    enableTable,
    language,
    pageRanges,
    dataId,
    callback,
    seed,
    extraFormats,
  });

  // Step 2: Upload PDF
  if (onProgress) onProgress({ phase: 'uploading_pdf' });
  await uploadPdfToMineru(uploadUrl, pdfBuffer);

  // Step 3: Poll for results
  if (onProgress) onProgress({ phase: 'parsing' });
  const { zipUrl } = await pollMineruResult(apiBase, token, batchId, (info) => {
    if (onProgress) onProgress({ phase: 'parsing', ...info });
  });

  // Step 4: Download and extract
  if (onProgress) onProgress({ phase: 'downloading_results' });
  const result = await downloadAndExtractZip(zipUrl, outputDir);

  if (onProgress) onProgress({ phase: 'done' });
  return result;
}
