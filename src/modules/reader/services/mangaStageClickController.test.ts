import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMangaStageClickController } from './mangaStageClickController';

function fixture() {
  vi.useFakeTimers();
  const onSingleClick = vi.fn();
  const onDoubleClick = vi.fn();
  const controller = createMangaStageClickController({ onSingleClick, onDoubleClick });
  return { controller, onSingleClick, onDoubleClick };
}
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('manga image click and double-click arbitration', () => {
  it('commits an isolated navigation once after the double-click window', () => {
    const { controller, onSingleClick, onDoubleClick } = fixture();
    controller.click('next', 1);
    vi.advanceTimersByTime(499);
    expect(onSingleClick).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onSingleClick.mock.calls).toEqual([['next']]);
    expect(onDoubleClick).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(['previous', 'next', 'controls'] as const)('zooms without committing the first %s click', (action) => {
    const { controller, onSingleClick, onDoubleClick } = fixture();
    controller.click(action, 1);
    vi.advanceTimersByTime(450);
    controller.click(action, 2);
    controller.doubleClick();
    vi.runAllTimers();
    expect(onSingleClick).not.toHaveBeenCalled();
    expect(onDoubleClick).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('cancels a pending click when its book, page or mounted reader changes', () => {
    const { controller, onSingleClick } = fixture();
    controller.click('next', 1);
    vi.advanceTimersByTime(100);
    controller.cancel();
    vi.runAllTimers();
    expect(onSingleClick).not.toHaveBeenCalled();
    controller.click('previous', 1);
    vi.runAllTimers();
    expect(onSingleClick.mock.calls).toEqual([['previous']]);
  });
  it('uses current controls without dropping a same-page pending click', () => {
    const { controller, onSingleClick, onDoubleClick } = fixture();
    const current = vi.fn();
    controller.click('controls', 1);
    controller.configure({ onSingleClick: current, onDoubleClick });
    vi.runAllTimers();
    expect(onSingleClick).not.toHaveBeenCalled();
    expect(current.mock.calls).toEqual([['controls']]);
  });
  it('ignores the trailing third click rather than scheduling another page turn', () => {
    const { controller, onSingleClick, onDoubleClick } = fixture();
    controller.click('next', 1);
    controller.doubleClick();
    controller.click('next', 3);
    vi.runAllTimers();
    expect(onSingleClick).not.toHaveBeenCalled();
    expect(onDoubleClick).toHaveBeenCalledTimes(1);
  });
});
