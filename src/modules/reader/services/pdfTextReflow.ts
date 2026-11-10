export type PdfTextItemLike = {
  dir?: string;
  height: number;
  str: string;
  transform: Array<number>;
  width: number;
};

export type PdfReflowResult = {
  characterCount: number;
  paragraphs: string[];
};

type PositionedText = {
  fontSize: number;
  str: string;
  width: number;
  x: number;
  y: number;
};

type PdfTextLine = {
  fontSize: number;
  text: string;
  x0: number;
  x1: number;
  y: number;
};

// Four-digit numbers may be dates or years, including in a colophon.
const PAGE_NUMBER_PATTERN = /^\d{1,3}$/;
const WORD_END = /[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{Script=Hangul}\p{N}\p{M}]$/u;
const WORD_START = /^[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{Script=Hangul}\p{N}\p{M}]/u;

export function buildPdfPageReflow(items: PdfTextItemLike[], viewBox: readonly number[]): PdfReflowResult {
  const [left, bottom, right, top] = viewBox;
  if (viewBox.length < 4 || !viewBox.slice(0, 4).every(Number.isFinite) || right <= left || top <= bottom) return { characterCount: 0, paragraphs: [] };
  // Text extraction uses PDF user-space coordinates. A cropped page can have
  // a nonzero origin, and viewport dimensions may also include UserUnit/rotation.
  const normalized = left === 0 && bottom === 0 ? items : items.map((item) => ({
    ...item,
    transform: item.transform.map((value, index) => value - (index === 4 ? left : index === 5 ? bottom : 0)),
  }));
  return buildPdfReflowParagraphs(normalized, right - left, top - bottom);
}

export function buildPdfReflowParagraphs(items: PdfTextItemLike[], pageWidth: number, pageHeight?: number): PdfReflowResult {
  // Keep the original page when linear text would lose reading order or notes.
  if (items.some((item) => item.str.trim() && (
    item.dir === 'ttb' || item.dir === 'rtl' || !hasUsablePosition(item)
    || item.transform[0] < 0 || Math.abs(item.transform[1]) > Math.abs(item.transform[0]) * 0.25
  ))) return { characterCount: 0, paragraphs: [] };

  const positionedItems = items.filter((item) => item.str && hasUsablePosition(item)).map((item) => ({
    fontSize: Math.max(Math.abs(item.height), Math.hypot(item.transform[2], item.transform[3]), 1),
    str: item.str,
    width: Math.abs(item.width),
    x: item.transform[4],
    y: item.transform[5],
  })).sort((a, b) => b.y - a.y || a.x - b.x);
  const groups = groupTextLines(positionedItems);
  const rawLines = groups.map(buildTextLine).filter((line) => line.text);
  if (hasLikelyMultipleColumns(groups, rawLines, pageWidth)) return { characterCount: 0, paragraphs: [] };

  const lines = removeMarginPageNumbers(rawLines, pageWidth, pageHeight);
  if (!lines.length) return { characterCount: 0, paragraphs: [] };

  const bodyLines = lines.filter((line) => line.text.length >= 8);
  const edgeLines = bodyLines.length >= 3 ? bodyLines : lines;
  const leftEdge = percentile(edgeLines.map((line) => line.x0), 0.2);
  const rightEdge = percentile(edgeLines.map((line) => line.x1), 0.82);
  const lineSteps = lines.slice(1).flatMap((line, index) => {
    const previous = lines[index];
    const gap = previous.y - line.y;
    return similarTypeSize(previous, line) && gap >= line.fontSize * 0.8 && gap <= line.fontSize * 3 ? [gap] : [];
  });
  const normalLineStep = percentile(lineSteps, 0.3);
  const paragraphs: string[] = [];
  let paragraph = '';
  let previousLine: PdfTextLine | null = null;

  for (const line of lines) {
    const tolerance = Math.max(8, line.fontSize * 1.5);
    const continuesParagraph = Boolean(
      paragraph && previousLine
      && similarTypeSize(previousLine, line)
      && previousLine.y - line.y <= Math.max(normalLineStep * 1.55, line.fontSize * 2.25)
      && previousLine.x1 >= rightEdge - tolerance
      && previousLine.x1 - previousLine.x0 >= (rightEdge - leftEdge) * 0.5
      && line.x0 <= leftEdge + tolerance,
    );

    if (!continuesParagraph && paragraph) {
      paragraphs.push(paragraph.trim());
      paragraph = '';
    }
    paragraph = joinPdfText(paragraph, line.text);
    previousLine = line;
  }

  if (paragraph) paragraphs.push(paragraph.trim());
  return {
    characterCount: paragraphs.reduce((total, text) => total + text.replace(/\s/g, '').length, 0),
    paragraphs: paragraphs.filter(Boolean),
  };
}

function hasUsablePosition(item: PdfTextItemLike) {
  return item.transform.length >= 6 && item.transform.slice(0, 6).every(Number.isFinite)
    && Number.isFinite(item.height) && Number.isFinite(item.width);
}

function groupTextLines(items: PositionedText[]): PositionedText[][] {
  const groups: PositionedText[][] = [];
  for (const item of items) {
    const current = groups.at(-1);
    const reference = current?.[0];
    const tolerance = Math.max(1.5, item.fontSize * 0.16);
    if (!current || !reference || Math.abs(reference.y - item.y) > tolerance) groups.push([item]);
    else current.push(item);
  }
  return groups;
}

function buildTextLine(group: PositionedText[]): PdfTextLine {
  const ordered = [...group].sort((a, b) => a.x - b.x);
  const visible = ordered.filter((item) => item.str.trim());
  let text = '';
  let previousRight: number | null = null;
  for (const item of ordered) {
    const gap = previousRight === null ? 0 : item.x - previousRight;
    if (gap > item.fontSize * 0.22 && needsWordSpace(text, item.str)) text += ' ';
    text += item.str;
    previousRight = item.x + item.width;
  }
  return {
    fontSize: Math.max(...ordered.map((item) => item.fontSize)),
    text: text.trim(),
    x0: Math.min(...visible.map((item) => item.x)),
    x1: Math.max(...visible.map((item) => item.x + item.width)),
    y: ordered[0]?.y ?? 0,
  };
}

function hasLikelyMultipleColumns(groups: PositionedText[][], lines: PdfTextLine[], pageWidth: number): boolean {
  const minGap = pageWidth * 0.08;
  if (groups.some((group) => {
    const visible = group.filter((item) => item.str.trim()).sort((a, b) => a.x - b.x);
    return visible.some((item, index) => {
      const next = visible[index + 1];
      return next && item.str.trim().length >= 4 && next.str.trim().length >= 4 && next.x - (item.x + item.width) > minGap;
    });
  })) return true;

  // Columns can have offset baselines. Repeated disjoint text blocks sharing
  // the same vertical region still cannot be read as one alternating column.
  const body = lines.filter((line) => line.text.length >= 4);
  return body.some((candidate) => {
    const left = body.filter((line) => line.x1 < candidate.x0 - minGap);
    const right = body.filter((line) => line.x0 >= candidate.x0);
    if (left.length < 2 || right.length < 2) return false;
    const overlap = Math.min(Math.max(...left.map((line) => line.y)), Math.max(...right.map((line) => line.y)))
      - Math.max(Math.min(...left.map((line) => line.y)), Math.min(...right.map((line) => line.y)));
    return overlap > candidate.fontSize * 0.5;
  });
}

function removeMarginPageNumbers(lines: PdfTextLine[], pageWidth: number, pageHeight?: number) {
  const body = lines.filter((line) => !PAGE_NUMBER_PATTERN.test(line.text));
  if (!body.length) return lines;
  const top = Math.max(...body.map((line) => line.y));
  const bottom = Math.min(...body.map((line) => line.y));
  return lines.filter((line) => {
    if (!PAGE_NUMBER_PATTERN.test(line.text)) return true;
    const outsideBody = line.y < bottom - line.fontSize * 2 || line.y > top + line.fontSize * 2;
    const verticalMargin = pageHeight !== undefined && (line.y < pageHeight * 0.12 || line.y > pageHeight * 0.88);
    const outerRight = line.x0 > pageWidth * 0.72;
    const centered = Math.abs((line.x0 + line.x1) / 2 - pageWidth / 2) < line.fontSize * 2;
    return !(outsideBody && verticalMargin && (outerRight || centered));
  });
}

function similarTypeSize(left: PdfTextLine, right: PdfTextLine) {
  return Math.min(left.fontSize, right.fontSize) / Math.max(left.fontSize, right.fontSize) >= 0.85;
}

function joinPdfText(left: string, right: string): string {
  if (!left) return right;
  if (needsWordSpace(left, right)) return `${left} ${right}`;
  return `${left}${right}`;
}

function needsWordSpace(left: string, right: string): boolean {
  if (!left || !right || /\s$/u.test(left) || /^\s/u.test(right)) return false;
  if (left.endsWith("'") && !/(?:^|\s)'[^']+'$/u.test(left)) return false;
  if (left.endsWith('’') && !left.includes('‘')) return false;
  const before = left.replace(/[.,;:!?…)\]}”’»"']+$/u, '');
  const after = right.replace(/^[([{“‘«"']+/u, '');
  return WORD_END.test(before) && WORD_START.test(after);
}

function percentile(values: number[], ratio: number): number {
  if (!values.length) return 0;
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.min(ordered.length - 1, Math.max(0, Math.floor((ordered.length - 1) * ratio)))] ?? 0;
}
