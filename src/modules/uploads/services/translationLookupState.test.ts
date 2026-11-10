import { describe, expect, it } from 'vitest';
import {
  createTranslationLookupState,
  isLatestTranslationLookup,
  shouldRequestTranslationLookup,
} from './translationLookupState';

const KAKUYOMU = 'https://kakuyomu.jp/works/16817330659769095632';

describe('translation link lookup sequencing', () => {
  it('looks up a freshly pasted supported link', () => {
    expect(shouldRequestTranslationLookup(KAKUYOMU, createTranslationLookupState(), 'translation')).toBe(true);
  });

  it('does not look the same link up twice after the field is rewritten with the normalised URL', () => {
    const state = { ...createTranslationLookupState(), requested: KAKUYOMU };

    expect(shouldRequestTranslationLookup(KAKUYOMU, state, 'translation')).toBe(false);
  });

  it('looks up again once the reader pastes a different work', () => {
    const state = { ...createTranslationLookupState(), requested: KAKUYOMU };

    expect(shouldRequestTranslationLookup('https://ncode.syosetu.com/n2656kr/', state, 'translation')).toBe(true);
  });

  it('ignores blank input, unsupported links and the other upload modes', () => {
    const state = createTranslationLookupState();

    expect(shouldRequestTranslationLookup('   ', state, 'translation')).toBe(false);
    expect(shouldRequestTranslationLookup('https://example.com/novel/1', state, 'translation')).toBe(false);
    expect(shouldRequestTranslationLookup(KAKUYOMU, state, 'file')).toBe(false);
  });

  it('lets only the newest request own the spinner and the result', () => {
    const state = createTranslationLookupState();
    const first = (state.sequence += 1);
    const second = (state.sequence += 1);

    expect(isLatestTranslationLookup(first, state)).toBe(false);
    expect(isLatestTranslationLookup(second, state)).toBe(true);
  });
});
