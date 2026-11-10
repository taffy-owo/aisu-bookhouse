import { describe, expect, it } from 'vitest';
import { reconcileReaderResource } from './readerResourceRefresh';
import type { ReaderResourceLoadState } from '../types/novelReaderState';
import type { ReaderResource } from '../types/reader';
const resource = (version: string, positionKey = 'a'): Extract<ReaderResource, { readerType: 'text' | 'epub' }> => ({ readerType: 'text', chapterCount: 1, version, toc: [{ index: 1, title: 'Chapter', positionKey }] });
const state = (version: string): ReaderResourceLoadState => ({ bookId: 'book-1', isLoaded: true, resource: resource(version) });
describe('reader resource reconciliation', () => {
  it('ignores a response for another book', () => { const old = state('v1'); expect(reconcileReaderResource(old, 'book-2', resource('v2'))).toBe(old); });
  it('keeps an unchanged known version on ordinary refresh', () => { const old = state('v1'); expect(reconcileReaderResource(old, 'book-1', resource('v1'))).toBe(old); });
  it('applies a newer edition', () => { expect(reconcileReaderResource(state('v1'), 'book-1', resource('v2'))).toMatchObject({ resource: { version: 'v2' } }); });
  it('does not roll a newer edition back after a late response', () => { const old = state('2026-10-27T02:00:00Z'); expect(reconcileReaderResource(old, 'book-1', resource('2026-10-27T01:00:00Z'), true)).toBe(old); });
  it('checks chapter identities after a conflict even if the timestamp is unchanged', () => { expect(reconcileReaderResource(state('v1'), 'book-1', resource('v1', 'b'), true).resource).toMatchObject({ toc: [{ positionKey: 'b' }] }); });
  it('keeps equivalent data during conflict recovery', () => { const old = state('v1'); expect(reconcileReaderResource(old, 'book-1', resource('v1'), true)).toBe(old); });
  it('marks a matching resource loaded', () => { expect(reconcileReaderResource({ bookId: 'book-1', isLoaded: false, resource: null }, 'book-1', resource('v1'))).toMatchObject({ isLoaded: true }); });
  it.each(['pdf', 'comic', 'epub'] as const)('keeps the active text reader when publication switches to %s', (readerType) => {
    const old = state('2026-10-27T01:00:00Z');
    const next: ReaderResource = readerType === 'pdf' ? { readerType, fileUrl: '/new.pdf', version: '2026-10-27T02:00:00Z' } : readerType === 'comic' ? { readerType, pages: [], pageCount: 0, version: '2026-10-27T02:00:00Z' } : { ...resource('2026-10-27T02:00:00Z'), readerType };
    const refreshed = reconcileReaderResource(old, 'book-1', next);
    expect(refreshed.resource).toBe(old.resource); expect(refreshed.pendingResource).toEqual(next);
  });
  it('rejects a late response older than the pending format change', () => {
    const pending = reconcileReaderResource(state('2026-10-27T01:00:00Z'), 'book-1', { readerType: 'pdf', version: '2026-10-27T03:00:00Z' });
    expect(reconcileReaderResource(pending, 'book-1', resource('2026-10-27T02:00:00Z'), true)).toBe(pending);
  });
  it('keeps the newer pending edition when the late response differs only in microseconds', () => {
    const pending = reconcileReaderResource(state('2026-11-08T07:00:00.123100Z'), 'book-1', { readerType: 'pdf', version: '2026-11-08T07:00:00.123900Z' });
    expect(reconcileReaderResource(pending, 'book-1', resource('2026-11-08T07:00:00.123800Z'), true)).toBe(pending);
  });
  it('returns to a newer chaptered edition if publication changes again before confirmation', () => {
    const pending = reconcileReaderResource(state('2026-10-27T01:00:00Z'), 'book-1', { readerType: 'pdf', version: '2026-10-27T02:00:00Z' });
    const restored = reconcileReaderResource(pending, 'book-1', resource('2026-10-27T03:00:00Z', 'new'));
    expect(restored.pendingResource).toBeUndefined(); expect(restored.resource).toMatchObject({ toc: [{ positionKey: 'new' }] });
  });
  it('preserves the displayed PDF during a switch to chaptered text', () => {
    const pdf: ReaderResource = { readerType: 'pdf', fileUrl: '/old.pdf' };
    expect(reconcileReaderResource({ bookId: 'book-1', isLoaded: true, resource: pdf }, 'book-1', resource('v2')).resource).toBe(pdf);
  });
  it('keeps the current PDF and URL when a new file is discovered', () => {
    const pdf: ReaderResource = { readerType: 'pdf', positionKey: 'file-a', fileUrl: '/old.pdf', version: 'v1' };
    const next: ReaderResource = { readerType: 'pdf', positionKey: 'file-b', fileUrl: '/new.pdf', version: 'v2' };
    const refreshed = reconcileReaderResource({ bookId: 'book-1', isLoaded: true, resource: pdf }, 'book-1', next);
    expect(refreshed.resource).toBe(pdf); expect(refreshed.pendingResource).toBe(next);
  });
  it('does not rebuild the PDF merely because its access ticket changed', () => {
    const pdf: ReaderResource = { readerType: 'pdf', positionKey: 'same-file', fileUrl: '/pdf?ticket=old', version: 'v1' };
    const refreshed = reconcileReaderResource({ bookId: 'book-1', isLoaded: true, resource: pdf }, 'book-1', { ...pdf, fileUrl: '/pdf?ticket=new', version: 'v2' });
    expect(refreshed.pendingResource).toBeUndefined(); expect(refreshed.resource).toMatchObject({ fileUrl: '/pdf?ticket=old', version: 'v2' });
  });
  it('detects replacement image identities even if the timestamp and page URLs match', () => {
    const pages: ReaderResource = { readerType: 'comic', pageCount: 1, pages: [{ index: 1, positionKey: 'old', imageUrl: '/page/1' }], version: 'same' };
    const next = { ...pages, pages: [{ index: 1, positionKey: 'new', imageUrl: '/page/1' }] };
    const refreshed = reconcileReaderResource({ bookId: 'book-1', isLoaded: true, resource: pages }, 'book-1', next);
    expect(refreshed.resource).toBe(pages); expect(refreshed.pendingResource).toBe(next);
  });
  it('keeps rendered image pages when the new response temporarily has no pages', () => {
    const pages: ReaderResource = { readerType: 'image', pageCount: 1, pages: [{ index: 1, positionKey: 'old' }] };
    const next: ReaderResource = { readerType: 'image', pageCount: 0, pages: [] };
    expect(reconcileReaderResource({ bookId: 'book-1', isLoaded: true, resource: pages }, 'book-1', next)).toMatchObject({ resource: pages, pendingResource: next });
  });
  it('does not prompt when only image metadata changes', () => {
    const pages: ReaderResource = { readerType: 'comic', pageCount: 1, pages: [{ index: 1, positionKey: 'same', imageUrl: '/page/1' }], version: 'v1' };
    expect(reconcileReaderResource({ bookId: 'book-1', isLoaded: true, resource: pages }, 'book-1', { ...pages, version: 'v2' }).pendingResource).toBeUndefined();
  });
});
