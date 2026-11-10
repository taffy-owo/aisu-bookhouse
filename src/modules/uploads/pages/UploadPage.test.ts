import { describe, expect, it } from 'vitest';
import type { UploadTask } from '../types/upload';
import { adoptUploadTask } from '../services/uploadTaskState';

const optimisticTask: UploadTask = {
  fileName: '新书.epub',
  fileSize: 2048,
  fileType: 'EPUB',
  id: 'local-1',
  message: '服务器正在解析',
  progress: 76,
  status: 'processing',
};

describe('upload task hand-off', () => {
  it('replaces an optimistic task with the server id without rendering a duplicate card', () => {
    const serverTask: UploadTask = {
      ...optimisticTask,
      bookId: 'book-1',
      id: 'server-1',
      message: '原文件已保存',
    };

    const tasks = adoptUploadTask([optimisticTask, serverTask], 'local-1', 'server-1', 'book-1');

    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ bookId: 'book-1', id: 'server-1' });
  });

  it('leaves the queue unchanged when the optimistic task is already gone', () => {
    const tasks = [{ ...optimisticTask, id: 'server-1' }];

    expect(adoptUploadTask(tasks, 'local-1', 'server-1')).toBe(tasks);
  });
});
