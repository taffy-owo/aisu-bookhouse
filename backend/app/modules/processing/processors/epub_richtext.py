"""Structured (rich) block extraction for EPUB chapter documents.

The legacy :func:`extract_chapter_text` flattens a chapter into plain text so
bold/italic/emphasis-dot/ruby/heading information is lost. This module parses
the same body HTML into a *whitelisted* structured representation instead:

  * ``paragraph`` / ``heading`` blocks made of inline ``spans``
  * ``image`` blocks that reference an already-extracted chapter image index

Only a small whitelist of inline marks survives (``strong``/``emphasis``/
``emphasis_dot``) plus ruby annotations; everything else degrades to plain
text. The output is *data*, never raw HTML, so the frontend can render it with
plain React elements without ever needing ``dangerouslySetInnerHTML``.

Parsing uses the standard library :class:`html.parser.HTMLParser` (lenient,
no external-entity/DTD expansion), so it stays safe against XXE/entity-bomb
payloads while tolerating the malformed XHTML real EPUBs ship.
"""

from html.parser import HTMLParser
from pathlib import PurePosixPath
import re

from app.modules.processing.processors.epub_documents import (
    build_archive_path,
    decode_document,
    extract_body_html,
)
from app.modules.processing.processors.epub_images import image_href_from_attributes

# Inline marks we preserve; anything else collapses to plain text.
CANONICAL_MARKS = ("strong", "emphasis", "emphasis_dot")

_STRONG_TAGS = {"strong", "b"}
_EMPHASIS_TAGS = {"em", "i"}
_HEADING_TAGS = {"h1", "h2", "h3", "h4", "h5", "h6"}
# Block-level containers: opening or closing one ends the current block.
_BLOCK_TAGS = {"p", "div", "section", "article", "li", "tr", "blockquote", "figure", "figcaption", "dd", "dt", "hr"}
# Elements ignored entirely (their text content is dropped).
_SKIP_TAGS = {"script", "style", "head", "title", "template"}
# Void / self-closing elements never carry inline marks, so they must not be
# pushed onto the inline stack (they get no matching end tag).
_VOID_TAGS = {"br", "img", "image", "hr", "wbr", "input", "meta", "link", "source", "col", "area", "base", "embed", "param", "track"}

# Class-name signals that conventionally denote CJK emphasis dots (着重号 /
# 傍点 / 圏点). Best-effort — undetected cases degrade to plain emphasis. Bare
# ``emphasis`` is intentionally excluded (it is commonly just italic).
_EMPHASIS_DOT_EXACT_CLASSES = {"dot", "dots", "em-dot", "boten", "bouten", "bou-ten", "sesame", "傍点", "圏点", "着重", "着重号"}
_EMPHASIS_DOT_CLASS_FRAGMENTS = ("emphasis-dot", "text-emphasis", "boten", "bouten", "傍点", "圏点", "着重", "sesame")


def extract_chapter_blocks(
    data: bytes,
    document_path: str | None = None,
    image_marker_by_path: dict[str, int] | None = None,
) -> list[dict[str, object]]:
    """Parse a chapter document into whitelisted structured blocks.

    ``image_marker_by_path`` maps an archive image path to the global chapter
    image index (as already resolved by the processor). Images absent from the
    map — inline icons, ``data:`` URIs, missing files — are dropped, mirroring
    the plain-text extractor.
    """

    html = extract_body_html(decode_document(data))
    parser = _ChapterBlockParser(document_path, image_marker_by_path)
    parser.feed(html)
    parser.close()
    return parser.finalize()


class _ChapterBlockParser(HTMLParser):
    def __init__(self, document_path: str | None, image_marker_by_path: dict[str, int] | None) -> None:
        super().__init__(convert_charrefs=True)
        self._document_path = document_path
        self._document_parent = PurePosixPath(document_path).parent if document_path else None
        self._image_marker_by_path = image_marker_by_path or {}

        self.blocks: list[dict[str, object]] = []
        self._spans: list[dict[str, object]] = []
        self._heading_level: int | None = None
        self._inline_stack: list[tuple[str, str | None]] = []
        self._skip_depth = 0
        self._svg_depth = 0

        # Ruby state.
        self._ruby_active = False
        self._ruby_base = ""
        self._ruby_text = ""
        self._ruby_marks: list[str] = []
        self._in_rt = False
        self._in_rp = False

    # -- HTMLParser hooks ---------------------------------------------------

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        tag = tag.lower()
        if tag in _SKIP_TAGS:
            self._skip_depth += 1
            return
        if self._skip_depth:
            return
        if tag == "svg":
            self._svg_depth += 1
            return
        if tag in ("img", "image"):
            self._handle_image(attrs)
            return
        if self._svg_depth:
            return
        if tag == "br" or tag == "hr":
            self._flush_block()
            return
        if tag in _HEADING_TAGS:
            self._flush_block()
            self._heading_level = int(tag[1])
            return
        if tag in _BLOCK_TAGS:
            self._flush_block()
            return
        if tag == "ruby":
            self._start_ruby()
            return
        if tag == "rt":
            self._in_rt = True
            return
        if tag == "rp":
            self._in_rp = True
            return
        if tag == "rb":
            return
        # Generic inline element: remember the mark it contributes (or None) so
        # the matching end tag pops the correct entry even when unmarked.
        self._inline_stack.append((tag, _mark_for(tag, attrs)))

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if tag in _SKIP_TAGS:
            self._skip_depth = max(0, self._skip_depth - 1)
            return
        if self._skip_depth:
            return
        if tag == "svg":
            self._svg_depth = max(0, self._svg_depth - 1)
            return
        if self._svg_depth:
            return
        if tag == "ruby":
            self._end_ruby()
            return
        if tag == "rt":
            self._in_rt = False
            return
        if tag == "rp":
            self._in_rp = False
            return
        if tag in _HEADING_TAGS or tag in _BLOCK_TAGS:
            self._flush_block()
            return
        if tag in _VOID_TAGS or tag == "rb":
            return
        for index in range(len(self._inline_stack) - 1, -1, -1):
            if self._inline_stack[index][0] == tag:
                del self._inline_stack[index]
                return

    def handle_data(self, data: str) -> None:
        if self._skip_depth or self._svg_depth or not data:
            return
        if self._ruby_active:
            if self._in_rp:
                return
            if self._in_rt:
                self._ruby_text += data
            else:
                self._ruby_base += data
            return
        self._append_text(data)

    # -- Block assembly -----------------------------------------------------

    def finalize(self) -> list[dict[str, object]]:
        if self._ruby_active:
            self._end_ruby()
        self._flush_block()
        return self.blocks

    def _append_text(self, text: str) -> None:
        marks = self._active_marks()
        if self._spans:
            last = self._spans[-1]
            if last.get("ruby") is None and last["marks"] == marks:
                last["text"] = f"{last['text']}{text}"
                return
        self._spans.append({"text": text, "marks": marks, "ruby": None})

    def _active_marks(self) -> list[str]:
        present = {mark for _tag, mark in self._inline_stack if mark}
        return [mark for mark in CANONICAL_MARKS if mark in present]

    def _flush_block(self) -> None:
        spans = _normalize_block_spans(self._spans)
        level = self._heading_level
        self._spans = []
        self._heading_level = None
        if not spans:
            return

        text = "".join(str(span["text"]) for span in spans)
        if not text.strip():
            return

        block: dict[str, object] = {"type": "heading" if level else "paragraph", "text": text}
        if level:
            block["level"] = min(6, max(1, level))
        if any(span["marks"] or span["ruby"] for span in spans):
            block["spans"] = spans
        self.blocks.append(block)

    # -- Ruby ---------------------------------------------------------------

    def _start_ruby(self) -> None:
        if self._ruby_active:
            self._end_ruby()
        self._ruby_active = True
        self._ruby_base = ""
        self._ruby_text = ""
        self._ruby_marks = self._active_marks()
        self._in_rt = False
        self._in_rp = False

    def _end_ruby(self) -> None:
        if not self._ruby_active:
            return
        base = re.sub(r"\s+", " ", self._ruby_base).strip()
        annotation = re.sub(r"\s+", " ", self._ruby_text).strip()
        self._ruby_active = False
        self._in_rt = False
        self._in_rp = False
        if base:
            self._spans.append({"text": base, "marks": self._ruby_marks, "ruby": annotation or None})
        elif annotation:
            # Ruby without base text — keep the reading as plain text so nothing
            # is silently dropped.
            self._spans.append({"text": annotation, "marks": self._ruby_marks, "ruby": None})

    # -- Images -------------------------------------------------------------

    def _handle_image(self, attrs: list[tuple[str, str | None]]) -> None:
        self._flush_block()
        if not self._image_marker_by_path or self._document_parent is None:
            return
        href = image_href_from_attributes(attrs)
        if not href or href.lower().startswith("data:"):
            return
        image_path = build_archive_path(self._document_parent, href)
        image_index = self._image_marker_by_path.get(image_path)
        if image_index is None:
            return
        self.blocks.append({"type": "image", "image_index": image_index})


def _normalize_block_spans(spans: list[dict[str, object]]) -> list[dict[str, object]]:
    """Collapse whitespace and trim the block, keeping inline boundaries intact."""

    for span in spans:
        span["text"] = re.sub(r"\s+", " ", str(span["text"]))

    normalized: list[dict[str, object]] = []
    previous_trailing_space = True  # strip leading whitespace of the whole block
    for span in spans:
        is_ruby = span.get("ruby") is not None
        text = str(span["text"])
        if not is_ruby and previous_trailing_space:
            text = text.lstrip(" ")
        if not is_ruby and text == "":
            continue
        span["text"] = text
        normalized.append(span)
        previous_trailing_space = (not is_ruby) and text.endswith(" ")

    while normalized:
        last = normalized[-1]
        if last.get("ruby") is not None:
            break
        last["text"] = str(last["text"]).rstrip(" ")
        if last["text"] == "":
            normalized.pop()
            continue
        break

    return normalized


def _mark_for(tag: str, attrs: list[tuple[str, str | None]]) -> str | None:
    attributes = {name.lower(): (value or "") for name, value in attrs}
    style = attributes.get("style", "").lower()
    class_name = attributes.get("class", "").lower()
    if "text-emphasis" in style or _looks_like_emphasis_dot(class_name):
        return "emphasis_dot"
    if tag in _STRONG_TAGS:
        return "strong"
    if tag in _EMPHASIS_TAGS:
        return "emphasis"
    return None


def _looks_like_emphasis_dot(class_name: str) -> bool:
    if not class_name:
        return False
    for token in class_name.replace("_", "-").split():
        if token in _EMPHASIS_DOT_EXACT_CLASSES:
            return True
        for fragment in _EMPHASIS_DOT_CLASS_FRAGMENTS:
            if fragment in token:
                return True
    return False
