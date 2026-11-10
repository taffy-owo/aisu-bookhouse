#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_OUTPUT_FILE, DEFAULT_SOURCE_DIR, IMPORTED_COVER_DIR } from './local-book-importer/config.mjs';
import { createBookFromFile } from './local-book-importer/book-metadata.mjs';
import { assertDirectory, assertOutputInsideProject, collectSupportedFiles, resetImportedCoverDir } from './local-book-importer/file-system.mjs';
import { renderBookData } from './local-book-importer/render-book-data.mjs';

const sourceDir = path.resolve(process.argv[2] ?? DEFAULT_SOURCE_DIR);
const outputFile = path.resolve(process.argv[3] ?? DEFAULT_OUTPUT_FILE);

await assertDirectory(sourceDir);
assertOutputInsideProject(outputFile);
assertOutputInsideProject(IMPORTED_COVER_DIR);
await resetImportedCoverDir();

const localFiles = await collectSupportedFiles(sourceDir);
const sortedFiles = localFiles.sort(
  (leftFile, rightFile) => rightFile.mtimeMs - leftFile.mtimeMs || leftFile.relativePath.localeCompare(rightFile.relativePath, 'zh-CN'),
);
const books = await Promise.all(sortedFiles.map((file, index) => createBookFromFile(file, index)));

await mkdir(path.dirname(outputFile), { recursive: true });
await writeFile(outputFile, renderBookData(books), 'utf8');

const coverCount = books.filter((book) => book.coverUrl).length;
console.log(`Imported ${books.length} local book entries from ${sourceDir}`);
console.log(`Extracted ${coverCount} covers into ${IMPORTED_COVER_DIR}`);
console.log(`Updated ${outputFile}`);
