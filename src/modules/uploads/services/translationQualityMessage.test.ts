import { expect, it } from 'vitest';
import { getWholeBookTranslationQualityMessage } from './wholeBookTranslationService';

it('does not claim the whole book passed after only one chapter', () => {
  expect(getWholeBookTranslationQualityMessage({quality_status:'passed',quality_issue_count:0,completed_chapters:1,total_chapters:11})).toBe('已完成的 1 话检查通过；其余待检查');
});
it('shows pending and warnings explicitly', () => {
  expect(getWholeBookTranslationQualityMessage({quality_status:'warning',quality_issue_count:2,completed_chapters:1,total_chapters:11})).toBe('质量检查 · 2 项待复核');
  expect(getWholeBookTranslationQualityMessage({quality_status:'pending',quality_issue_count:0,completed_chapters:0,total_chapters:11})).toBe('质量检查 · 待检查');
});
