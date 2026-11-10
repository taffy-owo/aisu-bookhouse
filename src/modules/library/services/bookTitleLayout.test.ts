import { describe, expect, it } from 'vitest';
import { getBookTitleLayoutClass } from './bookTitleLayout';

describe('getBookTitleLayoutClass', () => {
  it('keeps short titles visually prominent', () => {
    expect(getBookTitleLayoutClass('三日间的幸福')).toContain('lg:text-5xl');
  });

  it('reduces medium and long title sizes progressively', () => {
    expect(getBookTitleLayoutClass('被发现是硬核百合了，现在正被威胁中！')).toContain('lg:text-[2.5rem]');
    expect(getBookTitleLayoutClass('第二次人生的我，将全力把你攻陷～绝不会再把心爱的青梅竹马交给任何人～')).toContain('lg:text-[2.25rem]');
  });

  it('uses the smallest readable scale for exceptionally long metadata', () => {
    expect(getBookTitleLayoutClass('这是一个超过四十四个字的极端长书名测试样例，它仍然应当完整显示但不应破坏图书详情页面的整体排版结构')).toContain('lg:text-[2rem]');
  });
});
