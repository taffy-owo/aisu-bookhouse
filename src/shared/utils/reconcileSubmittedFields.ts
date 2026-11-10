/** Apply server-normalized scalar fields only when they have not been edited since submission. */
export function reconcileSubmittedFields<T extends object>(current: T, submitted: T, acknowledged: T): T {
  const next = { ...current };
  for (const key of Object.keys(acknowledged) as Array<keyof T>) {
    if (Object.is(current[key], submitted[key])) next[key] = acknowledged[key];
  }
  return next;
}
