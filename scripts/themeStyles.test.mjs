import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';
import { describe, expect, it } from 'vitest';

function readSources(directory) {
  return readdirSync(directory, { withFileTypes: true }).map((entry) => {
    const filename = path.join(directory, entry.name);
    return entry.isDirectory() ? readSources(filename) : /\.tsx?$/.test(filename) && !filename.endsWith('.test.ts') ? readFileSync(filename, 'utf8') : '';
  }).join('\n');
}

describe('theme color utilities', () => {
  it('compiles every numeric color opacity used by components', async () => {
    const sources = readSources('src');
    const tokens = [...new Set(sources.match(/\b(?:text|bg|border(?:-[xytrbl])?|ring(?:-offset)?|outline|divide|from|via|to|placeholder|decoration|shadow|fill|stroke)-(?:[\w-]+|\[[^\]\s]+\])\/(?:\d{1,3}|\[0?\.\d+\])/g))];
    const { default: config } = await import('../tailwind.config.js');
    const result = await postcss([tailwindcss({ ...config, content: [{ raw: tokens.join(' '), extension: 'html' }] })]).process('@tailwind utilities;', { from: undefined });
    const missing = tokens.filter((token) => !result.css.includes('.' + token.replace(/[^\w-]/g, '\\$&')));
    expect(missing, 'Uncompiled utilities inherit the wrong theme color').toEqual([]);
  });
});
