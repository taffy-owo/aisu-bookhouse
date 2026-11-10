import { getAccountScope } from '../../../shared/api';
import type { ReaderStartup } from './readerService';
import type { ReadingProgress } from '../types/reader';
import { resolveInitialChapterProgress } from './chapterPositionHistory';
import { resolveInitialMediaProgress } from './mediaReadingProgress';

let handoff: { bookId: string; scope: string; startup: ReaderStartup; expiresAt: number } | null = null;

/** An explicit format switch transfers a loaded startup without private data in browser history. */
export function stageReaderStartup(bookId: string, startup: ReaderStartup, pending: ReadingProgress | null = null): void {
  // Carry the reconciled position through the route switch even if its save
  // already cleared the outbox while this startup response was in flight.
  const progress = pending ? resolveInitialChapterProgress(startup.resource,
    resolveInitialMediaProgress(startup.resource, startup.progress, pending), pending) : startup.progress;
  handoff = { bookId, startup: progress === startup.progress ? startup : { ...startup, progress }, scope: getAccountScope(), expiresAt: Date.now() + 30000 };
}

export function takeReaderStartup(bookId: string): ReaderStartup | null {
  const current = handoff;
  if (!current) return null;
  if (current.scope !== getAccountScope() || current.expiresAt < Date.now()) { handoff = null; return null; }
  if (current.bookId !== bookId) return null;
  return current.startup;
}

export function acknowledgeReaderStartup(bookId: string, startup: ReaderStartup): void {
  if (handoff?.bookId === bookId && handoff.startup === startup) handoff = null;
}
