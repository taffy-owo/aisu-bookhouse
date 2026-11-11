import { useEffect, useRef } from 'react';
import { TextLayer, type PDFDocumentProxy } from 'pdfjs-dist';
import './pdfTextLayer.css';

export function PdfTextLayer({ document, pageNumber, pageWidth }: { document: PDFDocumentProxy; pageNumber: number; pageWidth: number }) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current!;
    const container = window.document.createElement('div');
    container.className = 'pdf-text-layer';
    host.append(container);
    let active = true;
    let layer: TextLayer | undefined;
    void document.getPage(pageNumber).then(async (page) => {
      if (!active) return;
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: pageWidth / base.width });
      container.style.setProperty('--total-scale-factor', String(viewport.scale * page.userUnit));
      layer = new TextLayer({ container, viewport, textContentSource: page.streamTextContent() });
      await layer.render();
    }).catch((error: unknown) => {
      if (active) {
        container.replaceChildren();
        console.warn('PDF text selection unavailable', error);
      }
    });
    return () => { active = false; layer?.cancel(); container.remove(); };
  }, [document, pageNumber, pageWidth]);

  return <div ref={hostRef} />;
}
