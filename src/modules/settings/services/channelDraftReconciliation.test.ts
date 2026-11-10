import { describe, expect, it } from 'vitest';
import { reconcileChannelModels } from './channelDraftReconciliation';

const base = { model: 'a', enabled: true, maxConcurrency: 4, chunkCharacters: 4500 };

describe('reconcileChannelModels', () => {
  it('applies remote changes to pristine fields while keeping local edits', () => {
    expect(reconcileChannelModels([{ ...base, maxConcurrency: 8 }], [base], [{ ...base, enabled: false, chunkCharacters: 6000 }])).toEqual([
      { ...base, maxConcurrency: 8, enabled: false, chunkCharacters: 6000 },
    ]);
  });
  it('keeps probed drafts and newly added server models without duplicates', () => {
    const discovered = { ...base, model: 'discovered', enabled: false };
    const incoming = { ...base, model: 'remote' };
    expect(reconcileChannelModels([base, discovered], [base], [base, incoming])).toEqual([base, discovered, incoming]);
  });
  it('drops remotely removed pristine models and retains locally edited ones', () => {
    expect(reconcileChannelModels([base, { ...base, model: 'edited', maxConcurrency: 8 }], [base, { ...base, model: 'edited' }], [])).toEqual([
      { ...base, model: 'edited', maxConcurrency: 8 },
    ]);
  });
});
