export const MAX_ENABLED_CHANNEL_MODELS = 60;

export function modelsForChannelSave<T extends { model: string; enabled: boolean }>(
  candidates: T[],
  saved: { model: string }[],
): T[] {
  const savedNames = new Set(saved.map((item) => item.model.trim()));
  const unique = new Map<string, T>();
  for (const item of candidates) {
    const name = item.model.trim();
    if (name && !unique.has(name)) unique.set(name, { ...item, model: name });
  }
  return [...unique.values()].filter((item) => item.enabled || savedNames.has(item.model));
}
