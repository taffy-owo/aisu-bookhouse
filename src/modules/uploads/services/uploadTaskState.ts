import type { UploadTask } from '../types/upload';

export function adoptUploadTask(tasks: UploadTask[], localTaskId: string, serverTaskId: string, bookId?: string): UploadTask[] {
  const localTask = tasks.find((task) => task.id === localTaskId);
  if (!localTask) {
    return tasks;
  }

  const adoptedTask = { ...localTask, bookId, id: serverTaskId };
  const seenTaskIds = new Set<string>();
  return [adoptedTask, ...tasks.filter((task) => task.id !== localTaskId)].filter((task) => {
    if (seenTaskIds.has(task.id)) {
      return false;
    }
    seenTaskIds.add(task.id);
    return true;
  });
}
