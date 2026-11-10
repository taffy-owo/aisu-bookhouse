import { describe, expect, it } from 'vitest';
import { modelsForChannelSave } from './channelModelSelection';

describe('channel model selection', () => {
  it('saves only the three selections from a 300-model catalog', () => {
    const catalog = Array.from({ length: 300 }, (_, i) => ({ model: `model-${i}`, enabled: i < 3 }));
    expect(modelsForChannelSave(catalog, [])).toEqual(catalog.slice(0, 3));
  });
  it('retains a previously configured model when disabled, including its tuning', () => {
    const old = { model: 'saved', enabled: false, maxConcurrency: 8 };
    expect(modelsForChannelSave([old, { model: 'new', enabled: false, maxConcurrency: 4 }], [{ model: 'saved' }])).toEqual([old]);
  });
  it('normalizes and deduplicates model names without counting duplicates', () => {
    expect(modelsForChannelSave([{ model: ' model ', enabled: true }, { model: 'model', enabled: true }], [])).toEqual([{ model: 'model', enabled: true }]);
  });
  it('allows an empty selection', () => {
    expect(modelsForChannelSave([{ model: 'unchecked', enabled: false }], [])).toEqual([]);
  });
});
