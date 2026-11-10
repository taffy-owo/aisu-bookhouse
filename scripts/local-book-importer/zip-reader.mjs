import { inflateRawSync } from 'node:zlib';

export function readZipEntries(buffer) {
  const centralDirectory = getCentralDirectory(buffer);
  const entries = new Map();
  let cursor = centralDirectory.offset;

  for (let index = 0; index < centralDirectory.totalEntries; index += 1) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error(`Invalid ZIP central directory at offset ${cursor}`);
    }

    const compressionMethod = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const fileNameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localHeaderOffset = buffer.readUInt32LE(cursor + 42);
    const rawName = buffer.toString('utf8', cursor + 46, cursor + 46 + fileNameLength);
    const name = normalizeZipPath(rawName);

    entries.set(name, {
      compressedSize,
      compressionMethod,
      localHeaderOffset,
      name,
    });

    cursor += 46 + fileNameLength + extraLength + commentLength;
  }

  return {
    buffer,
    entries,
  };
}

export function readZipText(zipEntries, entryPath) {
  return readZipEntry(zipEntries, entryPath).toString('utf8');
}

export function readZipEntry(zipEntries, entryPath) {
  const entry = zipEntries.entries.get(normalizeZipPath(entryPath));

  if (!entry) {
    throw new Error(`ZIP entry not found: ${entryPath}`);
  }

  const localHeaderOffset = entry.localHeaderOffset;
  const buffer = zipEntries.buffer;

  if (buffer.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
    throw new Error(`Invalid ZIP local header for ${entryPath}`);
  }

  const localFileNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
  const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
  const dataOffset = localHeaderOffset + 30 + localFileNameLength + localExtraLength;
  const compressedData = buffer.subarray(dataOffset, dataOffset + entry.compressedSize);

  if (entry.compressionMethod === 0) {
    return compressedData;
  }

  if (entry.compressionMethod === 8) {
    return inflateRawSync(compressedData);
  }

  throw new Error(`Unsupported ZIP compression method ${entry.compressionMethod} for ${entryPath}`);
}

export function normalizeZipPath(value) {
  return value.replace(/\\/g, '/').replace(/^\/+/, '');
}

function getCentralDirectory(buffer) {
  const minimumOffset = Math.max(0, buffer.length - 65557);

  for (let cursor = buffer.length - 22; cursor >= minimumOffset; cursor -= 1) {
    if (buffer.readUInt32LE(cursor) === 0x06054b50) {
      return {
        offset: buffer.readUInt32LE(cursor + 16),
        totalEntries: buffer.readUInt16LE(cursor + 10),
      };
    }
  }

  throw new Error('ZIP end of central directory was not found');
}
