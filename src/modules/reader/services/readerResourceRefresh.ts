import type { ReaderResourceLoadState } from '../types/novelReaderState';
import type { ReaderResource } from '../types/reader';
import { compareAppTimestamps } from '../../../shared/utils/formatDate';

export function readerPageIdentity(resource: ReaderResource | null | undefined): string | null {
  if (resource?.readerType === 'pdf') return resource.positionKey ? `pdf:${resource.positionKey}` : null;
  if (resource?.readerType === 'comic' || resource?.readerType === 'image') {
    return resource.pages.length && resource.pages.every((page) => page.positionKey)
      ? JSON.stringify([resource.readerType, resource.pages.map((page) => [page.index, page.positionKey])]) : null;
  }
  return null;
}

export function reconcileReaderResource(current: ReaderResourceLoadState, bookId: string, resource: ReaderResource, forceCheck = false): ReaderResourceLoadState {
  if (current.bookId !== bookId) return current;
  const latest = current.pendingResource ?? current.resource;
  const nextIdentity = readerPageIdentity(resource);
  const latestIdentity = readerPageIdentity(latest);
  if (!forceCheck && latest?.version && latest.version === resource.version && latest.readerType === resource.readerType && latestIdentity === nextIdentity) return current;
  if (compareAppTimestamps(resource.version ?? '', latest?.version ?? '') < 0) return current;
  // Neither a format change nor new page identities may replace the visible
  // document. The current pixels and coordinates belong to its loaded edition.
  const activeIdentity = readerPageIdentity(current.resource);
  if (current.resource && (current.resource.readerType !== resource.readerType || (activeIdentity && activeIdentity !== nextIdentity))) {
    return JSON.stringify(current.pendingResource) === JSON.stringify(resource) ? current : { ...current, pendingResource: resource };
  }
  // Renewing a PDF ticket or editing metadata must not rebuild the open PDF.
  if (current.resource?.readerType === 'pdf' && resource.readerType === 'pdf' && activeIdentity && activeIdentity === nextIdentity) {
    resource = { ...resource, fileUrl: current.resource.fileUrl };
  }
  if (!current.pendingResource && JSON.stringify(current.resource) === JSON.stringify(resource)) return current;
  return { bookId, isLoaded: true, resource };
}
