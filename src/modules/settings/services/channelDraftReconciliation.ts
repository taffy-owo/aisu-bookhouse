import { reconcileSubmittedFields } from '../../../shared/utils/reconcileSubmittedFields';

export function reconcileChannelModels<T extends { model: string }>(current: T[], previous: T[], incoming: T[]): T[] {
  const oldByName = new Map(previous.map((item) => [item.model, item]));
  const nextByName = new Map(incoming.map((item) => [item.model, item]));
  const result: T[] = [];
  for (const draft of current) {
    const old = oldByName.get(draft.model);
    const next = nextByName.get(draft.model);
    if (old && next) result.push(reconcileSubmittedFields(draft, old, next));
    else if (!old || Object.keys(old).some((key) => !Object.is(draft[key as keyof T], old[key as keyof T]))) result.push(draft);
    nextByName.delete(draft.model);
  }
  return [...result, ...nextByName.values()];
}
