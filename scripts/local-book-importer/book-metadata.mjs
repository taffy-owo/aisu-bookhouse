import { createHash } from 'node:crypto';
import path from 'node:path';
import { extractEpubMetadata } from './epub-metadata.mjs';

const UNKNOWN_AUTHOR = '未知作者';

export async function createBookFromFile(file, index) {
  const id = `local-${String(index + 1).padStart(3, '0')}-${createStableHash(file.relativePath)}`;
  const parentName = getParentName(file.relativePath);
  const fileTitle = getDisplayTitle(file);
  const epubMetadata = file.extension === '.epub' ? await extractEpubMetadata(file.absolutePath, id).catch(() => null) : null;
  const title = selectDisplayTitle({ epubTitle: epubMetadata?.title, fileTitle });
  const author = selectDisplayAuthor({ creator: epubMetadata?.creator, parentName, title });
  const tags = getTags(`${title} ${parentName}`, file.formatMeta.fileLabel, file.formatMeta.kind);

  return {
    author,
    coverUrl: epubMetadata?.coverUrl,
    createdAt: new Date(file.mtimeMs).toISOString(),
    currentChapter: '待开始',
    description: '从本地书库扫描生成的本机条目。脚本提取 EPUB 封面和展示元数据，不读取正文，也不在浏览器中暴露真实文件路径。',
    id,
    kind: file.formatMeta.kind,
    progressPercent: 0,
    readerType: file.formatMeta.readerType,
    readersLabel: '仅本机',
    subtitle: `${file.formatMeta.fileLabel} · ${formatFileSize(file.size)}`,
    tags,
    title,
    updatedAt: '本地导入',
  };
}

export function selectDisplayTitle({ epubTitle, fileTitle }) {
  const cleanedEpubTitle = cleanTitle(epubTitle ?? '');

  if (isUsefulTitle(cleanedEpubTitle)) {
    return cleanedEpubTitle;
  }

  return fileTitle;
}

export function selectDisplayAuthor({ creator, parentName, title }) {
  const cleanedCreator = cleanAuthor(creator ?? '');

  if (isUsefulAuthor(cleanedCreator) && !looksLikeSameWork(cleanedCreator, title)) {
    return cleanedCreator;
  }

  const cleanedParentName = cleanAuthor(parentName ?? '');

  if (isUsefulAuthor(cleanedParentName) && !looksLikeSameWork(cleanedParentName, title) && cleanedParentName.length <= 12) {
    return cleanedParentName;
  }

  return UNKNOWN_AUTHOR;
}

export function getDisplayTitle(file) {
  const normalizedPath = normalizePathSeparators(file.relativePath);
  const stem = path.basename(normalizedPath, file.extension);
  const parentName = getParentName(normalizedPath);
  const cleanedStem = cleanTitle(stem);

  if (/^\d+$/.test(cleanedStem) && parentName) {
    return `${parentName} ${cleanedStem}`;
  }

  return cleanedStem;
}

export function cleanTitle(value) {
  const normalizedTitle = value
    .replace(/\+-\+/g, ' ')
    .replace(/^\[[^\]]{1,12}\](?=\[)/g, '')
    .replace(/\[([^\]]+)\]/g, '$1')
    .replace(/卷[_\s]*(\d+)/gi, '卷$1')
    .replace(/話[_\s]*(\d+)/g, '话$1')
    .replace(/_/g, ' ')
    .replace(/\s*-\s*/g, ' - ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!/[\u4e00-\u9fff]/u.test(normalizedTitle)) {
    return normalizedTitle;
  }

  return normalizedTitle.replace(/([^0-9\s卷话第])(\d{1,2})$/u, '$1 $2');
}

function getParentName(relativePath) {
  const normalizedPath = normalizePathSeparators(relativePath);
  const parent = path.basename(path.dirname(normalizedPath));

  if (!parent || parent === '.') {
    return '';
  }

  return cleanTitle(parent);
}

function normalizePathSeparators(value) {
  return value.replace(/\\/g, '/');
}

function cleanAuthor(value) {
  return value.replace(/\s+/g, ' ').trim();
}

function getTags(searchableText, fileLabel, kind) {
  const tags = ['本地导入', fileLabel];

  if (kind === 'novel') {
    tags.push('小说');
  }

  if (kind === 'manga') {
    tags.push('漫画');
  }

  if (searchableText.includes('百合')) {
    tags.push('百合');
  }

  return Array.from(new Set(tags));
}

function isUsefulTitle(value) {
  return Boolean(value) && !isUuidLike(value) && !isUnknownLabel(value);
}

function isUsefulAuthor(value) {
  return Boolean(value) && !isUnknownLabel(value) && !isUuidLike(value);
}

function isUnknownLabel(value) {
  return ['unknown', 'untitled', '未知', '未知作者'].includes(value.trim().toLowerCase());
}

function isUuidLike(value) {
  const normalizedValue = value.trim().replace(/\s*-\s*/g, '-');
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(normalizedValue);
}

function looksLikeSameWork(authorCandidate, title) {
  if (!authorCandidate || !title) {
    return false;
  }

  return title.includes(authorCandidate) || authorCandidate.includes(title.slice(0, Math.min(title.length, 12)));
}

function createStableHash(value) {
  return createHash('sha1').update(value).digest('hex').slice(0, 8);
}

function formatFileSize(size) {
  if (size >= 1024 * 1024 * 1024) {
    return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }

  if (size >= 1024 * 1024) {
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  }

  if (size >= 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }

  return `${size} B`;
}
