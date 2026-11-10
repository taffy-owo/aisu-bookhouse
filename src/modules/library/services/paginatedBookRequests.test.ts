import { describe, expect, it } from 'vitest';
import { PaginatedRequestGate } from './paginatedBookRequests';

describe('PaginatedRequestGate', () => {
  it('aborts and ignores stale requests when a newer query starts', () => {
    const gate = new PaginatedRequestGate();
    const first = gate.begin('replace');
    const second = gate.begin('replace');

    expect(first?.signal.aborted).toBe(true);
    expect(second?.signal.aborted).toBe(false);
    expect(first && gate.isCurrent(first.id)).toBe(false);
    expect(second && gate.isCurrent(second.id)).toBe(true);
  });

  it('returns null when an append request is already in flight', () => {
    const gate = new PaginatedRequestGate();
    const first = gate.begin('append');
    const duplicate = gate.begin('append');

    expect(first).not.toBeNull();
    expect(duplicate).toBeNull();
  });

  it('clears an in-flight append when a replace request starts', () => {
    const gate = new PaginatedRequestGate();
    const append = gate.begin('append');
    const replace = gate.begin('replace');

    expect(append?.signal.aborted).toBe(true);
    expect(replace).not.toBeNull();
    expect(gate.begin('append')).not.toBeNull();
  });

  it('allows another append after the active append completes', () => {
    const gate = new PaginatedRequestGate();
    const first = gate.begin('append');

    gate.complete(first?.id ?? 0, 'append');

    expect(gate.begin('append')).not.toBeNull();
  });

  it('invalidates the active request when aborted', () => {
    const gate = new PaginatedRequestGate();
    const request = gate.begin('replace');

    gate.abort();

    expect(request?.signal.aborted).toBe(true);
    expect(request && gate.isCurrent(request.id)).toBe(false);
  });

  it('does not let stale completions clear the active append guard', () => {
    const gate = new PaginatedRequestGate();
    const append = gate.begin('append');
    const replace = gate.begin('replace');

    gate.complete(append?.id ?? 0, 'append');

    expect(replace && gate.isCurrent(replace.id)).toBe(true);
    expect(gate.begin('append')).not.toBeNull();
  });
});
