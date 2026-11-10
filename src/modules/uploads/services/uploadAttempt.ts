import { createRequestId } from '../../../shared/utils/requestId';
import { getAccountScope } from '../../../shared/api';
import type { UploadBookMetadata } from './uploadService';

export type UploadAttempt = { file: File; metadata?: UploadBookMetadata; requestId: string; accountScope: string };

export function createUploadAttempt(file: File, metadata?: UploadBookMetadata, requestId = createRequestId()): UploadAttempt {
  return { file, metadata: metadata ? { ...metadata, tags: metadata.tags ? [...metadata.tags] : undefined } : undefined,
    requestId, accountScope: getAccountScope() };
}
