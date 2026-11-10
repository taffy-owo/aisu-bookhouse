export interface FormattedChapterText {
  content: string;
  detectedTitle?: string;
  paragraphCount: number;
}

// Keep this grammar aligned with processing/chapter_headings.py for TXT import
// and direct API appends. Narrative prefixes must remain part of the body.
const CHAPTER_TITLE_PATTERN = /^(?:(?:第[ \t\u3000]*[0-9０-９一二三四五六七八九十百千万零〇两兩壹贰貳叁參肆伍陆陸柒捌玖拾佰仟]{1,24}[ \t\u3000]*[章节節卷回话話幕篇]|序章|序幕|终章|終章|尾声|尾聲|后记|後記|番外|extra\b)(?:[ \t\u3000:：、.．·・—–－\-（(【[「『《〈].*|(?![的地得是在将已又也就还還都里裡中内內外上下之はがをにでと])[^\r\n，。！？!?…]*)|chapter[ \t\u3000]*[0-9０-９]{1,24}(?:[ \t\u3000:：、.．·・—–－\-（(【[「『《〈].*|))$/i;
const TERMINAL_PUNCTUATION_PATTERN = /[。！？!?…」』”’）)】》]$/u;

export function formatPastedChapterText(rawText: string, explicitTitle = '', options: { extractTitle?: boolean | 'matching' } = {}): FormattedChapterText {
  let text = normalizePastedText(rawText);
  let detectedTitle: string | undefined;
  const firstBreak = text.indexOf('\n');
  if (options.extractTitle !== false && firstBreak >= 0) {
    const firstLine = text.slice(0, firstBreak).trim();
    const remainder = text.slice(firstBreak + 1).trim();
    if (remainder && options.extractTitle !== 'matching' && Array.from(firstLine).length <= 255 && CHAPTER_TITLE_PATTERN.test(firstLine)) {
      if (!explicitTitle.trim()) detectedTitle = firstLine;
      text = remainder;
    } else if (remainder && explicitTitle.trim() && normalizeTitle(firstLine) === normalizeTitle(explicitTitle)) {
      text = remainder;
    }
  }

  const paragraphs = buildParagraphs(text);
  return {
    content: paragraphs.join('\n\n'),
    detectedTitle,
    paragraphCount: paragraphs.length,
  };
}

function normalizePastedText(rawText: string): string {
  return rawText
    .replace(/\r\n?/g, '\n')
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .replace(/\u00a0/g, ' ')
    .split('\n')
    .map((line) => line.replace(/[ \t\u3000]+$/g, '').replace(/^[ \t\u3000]+/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function buildParagraphs(text: string): string[] {
  if (!text) return [];

  return text
    .split(/\n{2,}/)
    .flatMap((block) => formatLineBlock(block.split('\n').map((line) => line.trim()).filter(Boolean)))
    .filter(Boolean);
}

function formatLineBlock(lines: string[]): string[] {
  if (lines.length <= 1) return lines;
  if (!looksHardWrapped(lines)) return lines;
  return [lines.reduce((joined, line) => joinWrappedLine(joined, line), '')];
}

function looksHardWrapped(lines: string[]): boolean {
  if (lines.length < 4) return false;
  const representativeLines = lines.slice(0, -1);
  const sortedLengths = representativeLines.map((line) => Array.from(line).length).sort((left, right) => left - right);
  const medianLength = sortedLengths[Math.floor(sortedLengths.length / 2)] ?? 0;
  const minimumWrappedLength = /[\u3400-\u9fff\u3040-\u30ff]/u.test(lines.join('')) ? 28 : 56;
  const continuationRatio = representativeLines.filter((line) => !TERMINAL_PUNCTUATION_PATTERN.test(line)).length / representativeLines.length;
  const regularLengthRatio = representativeLines.filter((line) => Array.from(line).length >= medianLength * 0.68).length / representativeLines.length;
  return medianLength >= minimumWrappedLength && continuationRatio >= 0.6 && regularLengthRatio >= 0.7;
}

function joinWrappedLine(current: string, next: string): string {
  if (!current) return next;
  const needsSpace = /[A-Za-z0-9]$/.test(current) && /^[A-Za-z0-9]/.test(next);
  return `${current}${needsSpace ? ' ' : ''}${next}`;
}

function normalizeTitle(value: string): string {
  return value.replace(/\s+/g, '').toLowerCase();
}
