import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { assertOutputInsideProject } from './file-system.mjs';
import { PROJECT_ROOT } from './config.mjs';

describe('file-system helpers', () => {
  it('assertOutputInsideProject allows paths inside project', () => {
    const testPath = path.join(PROJECT_ROOT, 'src/somefile.ts');
    expect(() => assertOutputInsideProject(testPath)).not.toThrow();
  });

  it('assertOutputInsideProject refuses paths outside project', () => {
    const testPath = path.resolve(PROJECT_ROOT, '../../outside.ts');
    expect(() => assertOutputInsideProject(testPath)).toThrow();
  });

  if (process.platform === 'win32') {
    it('assertOutputInsideProject is case-insensitive for drive letters on Windows', () => {
      const firstChar = PROJECT_ROOT[0] ?? '';
      if (/[a-zA-Z]/.test(firstChar)) {
        const toggledChar = firstChar === firstChar.toLowerCase() ? firstChar.toUpperCase() : firstChar.toLowerCase();
        const toggledProjectRoot = toggledChar + PROJECT_ROOT.slice(1);
        const testPath = path.join(toggledProjectRoot, 'src/somefile.ts');

        expect(() => assertOutputInsideProject(testPath)).not.toThrow();
      }
    });
  }
});
