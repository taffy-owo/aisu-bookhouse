import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureReaderViewportAnchor, restoreReaderViewportAnchor } from './readerViewportAnchor';

class FakeElement {
  scrollTop = 900;
  scrollHeight = 4000;
  clientHeight = 800;
  top = 0;
  height = 800;
  textContent = '';
  children: FakeElement[] = [];
  getBoundingClientRect() { return { top: this.top, bottom: this.top + this.height, height: this.height }; }
  querySelector() { return this.children.length ? { children: this.children } : null; }
}
function setup() {
  vi.stubGlobal('HTMLElement', FakeElement);
  const scroll = new FakeElement();
  const shell = new FakeElement();
  shell.children = Array.from({ length: 3 }, (_, index) => Object.assign(new FakeElement(), { top: index * 160 - 150, height: 140, textContent: `第 ${index + 1} 段` }));
  const body = { style: { position: '', top: '' } };
  vi.stubGlobal('document', { scrollingElement: scroll, body });
  return { scroll, shell, body };
}
afterEach(() => vi.unstubAllGlobals());

describe('reader paragraph position', () => {
  it('tracks forward and backward scrolling from a nearby paragraph without scanning the chapter', () => {
    const { shell, scroll } = setup();
    shell.children = Array.from({ length: 2000 }, (_, index) => Object.assign(new FakeElement(), {
      top: (index - 1500) * 160 + 10, height: 140, textContent: `段落 ${index}`,
    }));
    const measure = vi.spyOn(FakeElement.prototype, 'getBoundingClientRect');
    const forward = captureReaderViewportAnchor(shell as unknown as HTMLElement, scroll as unknown as HTMLElement, 1499);
    expect(forward?.blockIndex).toBe(1500);
    expect(measure.mock.calls.length).toBeLessThan(20);
    measure.mockClear();
    const backward = captureReaderViewportAnchor(shell as unknown as HTMLElement, scroll as unknown as HTMLElement, 1502);
    expect(backward).toEqual(forward);
    expect(measure.mock.calls.length).toBeLessThan(20);
    measure.mockClear();
    const distantForward = captureReaderViewportAnchor(shell as unknown as HTMLElement, scroll as unknown as HTMLElement, 0);
    expect(distantForward).toEqual(forward);
    expect(measure.mock.calls.length).toBeLessThan(20);
    measure.mockClear();
    const distantBackward = captureReaderViewportAnchor(shell as unknown as HTMLElement, scroll as unknown as HTMLElement, 1999);
    expect(distantBackward).toEqual(forward);
    expect(measure.mock.calls.length).toBeLessThan(20);
    measure.mockRestore();
  });
  it('handles an empty body and an anchor hint beyond a shortened chapter', () => {
    const { shell, scroll } = setup();
    expect(captureReaderViewportAnchor(shell as unknown as HTMLElement, scroll as unknown as HTMLElement, 100)?.blockIndex).toBe(1);
    shell.children = [];
    expect(captureReaderViewportAnchor(shell as unknown as HTMLElement, scroll as unknown as HTMLElement, 100)).toBeNull();
  });
  it('preserves the same point within a paragraph after font reflow', () => {
    const { shell, scroll } = setup();
    const anchor = captureReaderViewportAnchor(shell as unknown as HTMLElement, scroll as unknown as HTMLElement)!;
    expect(anchor).toMatchObject({ blockIndex: 1, offsetRatio: 0.5, viewportOffset: 80 });
    shell.children[1].top = 200;
    shell.children[1].height = 200;
    restoreReaderViewportAnchor(shell as unknown as HTMLElement, scroll as unknown as HTMLElement, anchor);
    expect(scroll.scrollTop).toBe(1120);
  });
  it('does not mistake a fixed-body reader sheet for the chapter beginning', () => {
    const { shell, scroll, body } = setup();
    body.style.position = 'fixed';
    body.style.top = '-900px';
    scroll.scrollTop = 0;
    expect(captureReaderViewportAnchor(shell as unknown as HTMLElement, scroll as unknown as HTMLElement)?.boundary).toBeUndefined();
  });
  it('keeps repeated short dialogue at the original paragraph rather than its first occurrence', () => {
    const { shell, scroll } = setup();
    shell.children[0].textContent = '嗯。';
    shell.children[1].textContent = '嗯。';
    const anchor = captureReaderViewportAnchor(shell as unknown as HTMLElement, scroll as unknown as HTMLElement)!;
    shell.children[1].top = 200;
    shell.children[1].height = 200;
    restoreReaderViewportAnchor(shell as unknown as HTMLElement, scroll as unknown as HTMLElement, anchor);
    expect(scroll.scrollTop).toBe(1120);
  });
  it('keeps real chapter boundaries at the boundary after reflow', () => {
    const { shell, scroll } = setup();
    scroll.scrollTop = 3200;
    const anchor = captureReaderViewportAnchor(shell as unknown as HTMLElement, scroll as unknown as HTMLElement)!;
    expect(anchor.boundary).toBe('end');
    scroll.scrollHeight = 5000;
    restoreReaderViewportAnchor(shell as unknown as HTMLElement, scroll as unknown as HTMLElement, anchor);
    expect(scroll.scrollTop).toBe(4200);
  });
});
