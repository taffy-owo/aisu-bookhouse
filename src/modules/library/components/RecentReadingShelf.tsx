import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useId, useLayoutEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { createCollectionLinkState } from '../../../shared/navigation/navigationState';
import { getBookDetailPath } from '../../../config/routes';
import { BookCover, type Book } from '../../books';
import { getBookProgressLabel, hasBookReadingHistory } from '../../books/services/bookProgress';

export function RecentReadingShelf({ books, initialScrollLeft = 0 }: { books: Book[]; initialScrollLeft?: number }) {
  const navigationState = createCollectionLinkState(useLocation());
  const readBooks = books.filter(hasBookReadingHistory);
  const railRef = useRef<HTMLDivElement>(null);
  const railId = useId();
  const [edges, setEdges] = useState({ previous: false, next: false });
  useLayoutEffect(() => {
    if (railRef.current) railRef.current.scrollLeft = initialScrollLeft;
  }, [initialScrollLeft]);

  useLayoutEffect(() => {
    const rail = railRef.current;
    if (!rail) return;
    const updateEdges = () => {
      const previous = rail.scrollLeft > 2;
      const next = rail.scrollLeft + rail.clientWidth < rail.scrollWidth - 2;
      if (!previous && !next && rail.parentElement?.querySelector('.recent-reading-controls')?.contains(document.activeElement)) rail.focus({ preventScroll: true });
      setEdges((current) => current.previous === previous && current.next === next ? current : { previous, next });
    };
    updateEdges();
    const observer = new ResizeObserver(updateEdges);
    observer.observe(rail);
    rail.addEventListener('scroll', updateEdges, { passive: true });
    return () => {
      observer.disconnect();
      rail.removeEventListener('scroll', updateEdges);
    };
  }, [books]);

  function move(direction: number) {
    const rail = railRef.current;
    const firstBook = rail?.firstElementChild;
    if (!rail || !firstBook) return;
    const step = firstBook.getBoundingClientRect().width + parseFloat(getComputedStyle(rail).columnGap);
    const distance = Math.max(1, Math.floor(rail.clientWidth / step)) * step;
    rail.scrollBy({ left: direction * distance, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }

  return (
    <section className="recent-reading-shelf" aria-label="最近翻过">
      <div className="recent-reading-heading">
        <h2>最近翻过</h2>
        {readBooks.length > 0 && (edges.previous || edges.next) && <div className="recent-reading-controls">
          <button aria-label="查看前面的书" aria-controls={railId} aria-disabled={!edges.previous} onClick={() => { if (edges.previous) move(-1); }} type="button"><ChevronLeft aria-hidden /></button>
          <button aria-label="查看后面的书" aria-controls={railId} aria-disabled={!edges.next} onClick={() => { if (edges.next) move(1); }} type="button"><ChevronRight aria-hidden /></button>
        </div>}
      </div>
      {readBooks.length > 0 ? <div ref={railRef} id={railId} data-navigation-rail="recent-reading" className="recent-cover-rail" aria-label="最近阅读的图书" role="region" tabIndex={0}>
        {readBooks.map((book) => (
          <Link className="recent-cover-entry group" key={book.id} state={navigationState} to={getBookDetailPath(book.id)}>
            <div className="recent-cover-art"><BookCover book={book} /></div>
            <p className="recent-cover-title" title={book.title}>{book.title}</p>
            <p className="recent-cover-progress">
              {book.currentChapter && <span className="recent-cover-chapter" title={book.currentChapter}>{book.currentChapter}</span>}
              <span className="recent-cover-percent">{getBookProgressLabel(book.progressPercent, book.lastReadAt).label}</span>
            </p>
          </Link>
        ))}
      </div> : <p className="py-3 text-sm text-ink/55 dark:text-night-soft">读过的书会显示在这里。</p>}
    </section>
  );
}
