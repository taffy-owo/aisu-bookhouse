export type UploadStatus = 'queued' | 'uploading' | 'processing' | 'ready' | 'failed';

export type UploadTask = {
  id: string;
  bookId?: string;
  errorCode?: string;
  fileName: string;
  fileSize: number;
  fileType: string;
  status: UploadStatus;
  progress: number;
  message?: string;
};

export type UploadFileLike = {
  name: string;
  size: number;
  type?: string;
};

export type UploadStatusMeta = {
  description: string;
  label: string;
  tone: 'accent' | 'success' | 'danger';
};
