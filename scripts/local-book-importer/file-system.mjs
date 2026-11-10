import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { FORMAT_META, IMPORTED_COVER_DIR, PROJECT_ROOT } from './config.mjs';

export async function assertDirectory(directoryPath) {
  const directoryStats = await stat(directoryPath).catch(() => null);

  if (!directoryStats?.isDirectory()) {
    throw new Error(`Local import source is not a directory: ${directoryPath}`);
  }
}

export function assertOutputInsideProject(filePath) {
  const relativePath = getRelativeProjectPath(filePath);

  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new Error(`Refusing to write outside project: ${filePath}`);
  }
}

function getRelativeProjectPath(filePath) {
  const projectRoot = normalizePathForComparison(PROJECT_ROOT);
  const targetPath = normalizePathForComparison(filePath);

  return path.relative(projectRoot, targetPath);
}

function normalizePathForComparison(filePath) {
  const resolvedPath = path.resolve(filePath);
  return process.platform === 'win32' ? resolvedPath.toLowerCase() : resolvedPath;
}

export async function resetImportedCoverDir() {
  await rm(IMPORTED_COVER_DIR, { force: true, recursive: true });
  await mkdir(IMPORTED_COVER_DIR, { recursive: true });
}

export async function collectSupportedFiles(sourceDir) {
  return collectSupportedFilesInside(sourceDir, sourceDir);
}

async function collectSupportedFilesInside(directoryPath, sourceDir) {
  const entries = await readdir(directoryPath, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const entryPath = path.join(directoryPath, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await collectSupportedFilesInside(entryPath, sourceDir)));
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const extension = path.extname(entry.name).toLowerCase();
    const formatMeta = FORMAT_META.get(extension);

    if (!formatMeta) {
      continue;
    }

    const fileStats = await stat(entryPath);
    files.push({
      absolutePath: entryPath,
      extension,
      formatMeta,
      mtimeMs: fileStats.mtimeMs,
      relativePath: path.relative(sourceDir, entryPath),
      size: fileStats.size,
    });
  }

  return files;
}
