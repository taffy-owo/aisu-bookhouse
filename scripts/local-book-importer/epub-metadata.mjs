import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { IMPORTED_COVER_DIR, IMPORTED_COVER_URL_PREFIX } from './config.mjs';
import { getAttributes, findTags, readXmlText } from './xml-utils.mjs';
import { normalizeZipPath, readZipEntries, readZipEntry, readZipText } from './zip-reader.mjs';

export async function extractEpubMetadata(epubPath, bookId) {
  const zipEntries = readZipEntries(await readFile(epubPath));
  const containerXml = readZipText(zipEntries, 'META-INF/container.xml');
  const opfPath = getRootFilePath(containerXml);

  if (!opfPath) {
    return null;
  }

  const opfXml = readZipText(zipEntries, opfPath);
  const manifestItems = getManifestItems(opfXml);
  const coverHref = getCoverHref(opfXml, manifestItems);
  const coverUrl = coverHref ? await writeCoverAsset(zipEntries, opfPath, coverHref, bookId) : undefined;

  return {
    coverUrl,
    creator: readXmlText(opfXml, 'dc:creator') ?? readXmlText(opfXml, 'creator'),
    title: readXmlText(opfXml, 'dc:title') ?? readXmlText(opfXml, 'title'),
  };
}

function getRootFilePath(containerXml) {
  const rootfileTag = findTags(containerXml, 'rootfile')[0];
  return rootfileTag ? getAttributes(rootfileTag)['full-path'] : null;
}

function getManifestItems(opfXml) {
  return findTags(opfXml, 'item').map((itemTag) => getAttributes(itemTag));
}

function getCoverHref(opfXml, manifestItems) {
  const coverId = findTags(opfXml, 'meta')
    .map((metaTag) => getAttributes(metaTag))
    .find((attributes) => attributes.name?.toLowerCase() === 'cover')?.content;

  const coverByMeta = coverId ? manifestItems.find((item) => item.id === coverId && item.href)?.href : undefined;

  if (coverByMeta) {
    return coverByMeta;
  }

  const imageItems = manifestItems.filter((item) => item.href && item['media-type']?.startsWith('image/'));
  const namedCover = imageItems.find((item) => /cover|title|front/i.test(`${item.id ?? ''} ${item.href ?? ''}`));

  return namedCover?.href ?? imageItems[0]?.href;
}

export function safeDecodeHref(href) {
  try {
    return decodeURIComponent(href);
  } catch {
    return href;
  }
}


async function writeCoverAsset(zipEntries, opfPath, coverHref, bookId) {
  const decodedHref = safeDecodeHref(coverHref);
  const coverEntryPath = normalizeZipPath(path.posix.join(path.posix.dirname(normalizeZipPath(opfPath)), decodedHref));
  const coverData = readZipEntry(zipEntries, coverEntryPath);
  const coverExtension = getImageExtension(coverEntryPath);
  const coverFileName = `${bookId}${coverExtension}`;

  await writeFile(path.join(IMPORTED_COVER_DIR, coverFileName), coverData);

  return `${IMPORTED_COVER_URL_PREFIX}/${coverFileName}`;
}


function getImageExtension(entryPath) {
  const extension = path.posix.extname(entryPath).toLowerCase();

  if (['.jpeg', '.jpg', '.png', '.webp', '.gif', '.avif'].includes(extension)) {
    return extension;
  }

  return '.jpg';
}
