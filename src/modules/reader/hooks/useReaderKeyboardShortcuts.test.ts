import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEffect } from 'react';
import { useReaderKeyboardShortcuts } from './useReaderKeyboardShortcuts';

vi.mock('react', () => ({ useEffect: vi.fn() }));

let target: EventTarget;
let modal: boolean;
let selected: boolean;
let cleanup: void | (() => void);
class ControlTarget { closest = () => this; }

beforeEach(() => {
  target = new EventTarget();
  modal = false;
  selected = false;
  vi.stubGlobal('Element', ControlTarget);
  vi.stubGlobal('window', Object.assign(target, { getSelection: () => ({ isCollapsed: !selected }) }));
  vi.stubGlobal('document', { querySelector: () => modal ? {} : null });
});
afterEach(() => {
  if (typeof cleanup === 'function') cleanup();
  cleanup = undefined;
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function press(key: string, properties: Record<string, unknown> = {}) {
  const event = Object.assign(new Event('keydown', { cancelable: true }), { key });
  for (const [name, value] of Object.entries(properties)) Object.defineProperty(event, name, { value });
  target.dispatchEvent(event);
  return event;
}

describe('reader keyboard isolation', () => {
  it.each([true, false])('leaves modal arrow keys alone (modal=%s)', (isModal) => {
    modal = isModal;
    const next = vi.fn();
    useReaderKeyboardShortcuts({ onArrowRight: next });
    cleanup = vi.mocked(useEffect).mock.calls[0][0]();
    expect(press('ArrowRight').defaultPrevented).toBe(!modal);
    expect(next).toHaveBeenCalledTimes(modal ? 0 : 1);
  });
  it.each(['altKey', 'ctrlKey', 'metaKey', 'isComposing'])('preserves %s events', (property) => {
    const next = vi.fn();
    useReaderKeyboardShortcuts({ onArrowRight: next });
    cleanup = vi.mocked(useEffect).mock.calls[0][0]();
    expect(press('ArrowRight', { [property]: true }).defaultPrevented).toBe(false);
    expect(next).not.toHaveBeenCalled();
  });
  it('does not act on legacy IME events', () => {
    const next = vi.fn();
    useReaderKeyboardShortcuts({ onPageDown: next });
    cleanup = vi.mocked(useEffect).mock.calls[0][0]();
    expect(press(' ', { keyCode: 229 }).defaultPrevented).toBe(false);
    expect(next).not.toHaveBeenCalled();
  });
  it('honors a keyboard event already handled by an inner control', () => {
    const next = vi.fn();
    useReaderKeyboardShortcuts({ onArrowRight: next });
    cleanup = vi.mocked(useEffect).mock.calls[0][0]();
    const event = Object.assign(new Event('keydown', { cancelable: true }), { key: 'ArrowRight' });
    event.preventDefault();
    target.dispatchEvent(event);
    expect(next).not.toHaveBeenCalled();
  });
  it.each(['ArrowRight', ' ', 'PageDown', '+', '0'])('leaves %s to a focused control', (key) => {
    const action = vi.fn();
    useReaderKeyboardShortcuts({ onArrowRight: action, onPageDown: action, onZoomIn: action, onZoomReset: action });
    cleanup = vi.mocked(useEffect).mock.calls[0][0]();
    expect(press(key, { target: new ControlTarget() }).defaultPrevented).toBe(false);
    expect(action).not.toHaveBeenCalled();
  });
  it('keeps direction keys available for a text selection', () => {
    selected = true;
    const next = vi.fn();
    useReaderKeyboardShortcuts({ onArrowRight: next });
    cleanup = vi.mocked(useEffect).mock.calls[0][0]();
    expect(press('ArrowRight').defaultPrevented).toBe(false);
    expect(next).not.toHaveBeenCalled();
    selected = false;
    expect(press('ArrowRight').defaultPrevented).toBe(true);
    expect(next).toHaveBeenCalledOnce();
  });
  it.each(['ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown'])('preserves Shift+%s to extend a selection', (key) => {
    const action = vi.fn();
    useReaderKeyboardShortcuts({ onArrowLeft: action, onArrowRight: action, onPageUp: action, onPageDown: action });
    cleanup = vi.mocked(useEffect).mock.calls[0][0]();
    expect(press(key, { shiftKey: true }).defaultPrevented).toBe(false);
    expect(action).not.toHaveBeenCalled();
  });
  it('does not consume keys without an assigned action', () => {
    useReaderKeyboardShortcuts({});
    cleanup = vi.mocked(useEffect).mock.calls[0][0]();
    for (const key of ['ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', ' ', '+', '-', '0']) {
      expect(press(key).defaultPrevented).toBe(false);
    }
  });
  it('keeps forward and backward screen actions distinct', () => {
    const next = vi.fn();
    const previous = vi.fn();
    useReaderKeyboardShortcuts({ onPageDown: next, onPageUp: previous });
    cleanup = vi.mocked(useEffect).mock.calls[0][0]();
    press(' '); press('PageDown');
    press(' ', { shiftKey: true }); press('PageUp');
    expect(next).toHaveBeenCalledTimes(2);
    expect(previous).toHaveBeenCalledTimes(2);
  });
  it('disables all reader actions while content is unavailable', () => {
    const next = vi.fn();
    useReaderKeyboardShortcuts({ disabled: true, onArrowRight: next });
    cleanup = vi.mocked(useEffect).mock.calls[0][0]();
    expect(press('ArrowRight').defaultPrevented).toBe(false);
    expect(next).not.toHaveBeenCalled();
  });
});
