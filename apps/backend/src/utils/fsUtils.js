import { promises as fs } from 'fs';
import path from 'path';

export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

export async function readJson(filePath) {
  const data = await fs.readFile(filePath, 'utf8');
  return JSON.parse(data);
}

export async function writeJson(filePath, data) {
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
}

export async function copyDir(src, dest) {
  await ensureDir(dest);
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath);
    } else {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

export async function listFilesRecursive(root, rel = '') {
  const dirPath = path.join(root, rel);
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const items = [];
  for (const entry of entries) {
    if (entry.name === 'project.json' || entry.name === '.compile') continue;
    let itemRel = path.join(rel, entry.name);
    itemRel = itemRel.replace(/\\/g, '/');
    const full = path.join(root, itemRel);
    if (entry.isDirectory()) {
      items.push({ path: itemRel, type: 'dir' });
      items.push(...await listFilesRecursive(root, itemRel));
    } else {
      items.push({ path: itemRel, type: 'file' });
    }
  }
  return items;
}
