"""Deterministic translation checks and source dialogue boundary normalization."""
from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
import re

from .memory import _glossary_target_candidates

KANA_RE = re.compile(r"[\u3040-\u30ff\u31f0-\u31ff]")


KOREAN_RE = re.compile(r"[\uac00-\ud7af]")


EXTRA_CONTENT_PREFIX_RE = re.compile(
    r"^\s*(?:#{1,6}\s*)?(?:"
    r"以下(?:是|为).{0,16}(?:翻译|译文)|"
    r"(?:翻译|译文)(?:如下|结果)?\s*[：:]|"
    r"当然[，,:]\s*(?:以下(?:是|为)|这是).{0,8}(?:翻译|译文)\s*[：:]|"
    r"(?:译者注|翻译说明|译文说明|分析|解释)\s*[：:]|"
    r"```|"
    r"\{?\s*[\"']?translations[\"']?\s*:"
    r")",
    re.IGNORECASE,
)


EXTRA_CONTENT_SUFFIX_RE = re.compile(
    r"(?:以上(?:就是|是).{0,20}(?:翻译|译文)|"
    r"如需(?:继续|进一步).{0,30}|"
    r"希望(?:以上|这).{0,20}(?:能|可以).{0,12}(?:帮助|帮到)你)\s*[。！!]?\s*$",
    re.IGNORECASE,
)


EXTRA_CONTENT_LINE_RE = re.compile(
    r"(?:^|\n)\s*(?:"
    r"(?:译者注|译者按|翻译说明|译文说明|注释|补充说明|分析|解释)\s*[：:]|"
    r"#{1,6}\s*(?:翻译|译文|说明)|"
    r"```|"
    r"(?:here\s+is\s+the\s+translation|translation)\s*:"
    r")",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class QualityIssue:
    """One deterministic check result.

    ``hard`` marks output that is unusable as Chinese prose (untranslated,
    wrong script). ``soft`` marks length and glossary heuristics, which are
    worth showing to the editor pass but are too noisy to fail a book over.
    """

    message: str
    severity: str
    paragraph: int | None = None


OPENING_BRACKETS = "「『（〈《【"


CLOSING_BRACKETS = "」』）〉》】"


BRACKET_PAIRS = dict(zip(OPENING_BRACKETS, CLOSING_BRACKETS, strict=True))


DIALOGUE_BRACKET_PAIRS = {"「": "」", "『": "』"}


REDUNDANT_DIALOGUE_QUOTE_PAIRS = (("“", "”"), ('"', '"'), ("＂", "＂"))


def align_translated_outer_brackets(source: str, translated: str) -> str:
    """Keep multi-paragraph dialogue and letter boundaries aligned to the source."""
    source_text = source.strip()
    translated_text = translated.strip()
    if not source_text or not translated_text:
        return translated_text

    source_opening = source_text[0] if source_text[0] in BRACKET_PAIRS else None
    translated_opening = translated_text[0] if translated_text[0] in BRACKET_PAIRS else None
    if translated_opening and translated_opening != source_opening:
        translated_text = translated_text[1:].lstrip()
    if source_opening and not translated_text.startswith(source_opening):
        translated_text = source_opening + translated_text

    source_closing = source_text[-1] if source_text[-1] in CLOSING_BRACKETS else None
    translated_closing = translated_text[-1] if translated_text and translated_text[-1] in CLOSING_BRACKETS else None
    if translated_closing and translated_closing != source_closing:
        translated_text = translated_text[:-1].rstrip()
    if source_closing and not translated_text.endswith(source_closing):
        translated_text += source_closing

    # Models sometimes localize Japanese dialogue wrappers to Chinese curly
    # quotes. Once the source boundary is restored above, that would otherwise
    # produce `「“……”」`, or `「“……”` / `“……”」` for dialogue split across
    # paragraphs. Remove exactly one complete redundant quote pair only when
    # this source paragraph carries at least one Japanese dialogue boundary.
    dialogue_opening = source_opening if source_opening in DIALOGUE_BRACKET_PAIRS else None
    dialogue_closing = source_closing if source_closing in DIALOGUE_BRACKET_PAIRS.values() else None
    if dialogue_opening or dialogue_closing:
        prefix = dialogue_opening or ""
        suffix = dialogue_closing or ""
        inner_end = -len(suffix) if suffix else None
        inner = translated_text[len(prefix) : inner_end].strip()
        for quote_opening, quote_closing in REDUNDANT_DIALOGUE_QUOTE_PAIRS:
            if len(inner) >= 2 and inner.startswith(quote_opening) and inner.endswith(quote_closing):
                translated_text = prefix + inner[1:-1].strip() + suffix
                break
    return translated_text


class TranslationQualityError(ValueError):
    def __init__(self, chapter_index: int, chunk_index: int, issues: list[QualityIssue]):
        self.chapter_index, self.chunk_index, self.issues = chapter_index, chunk_index, issues
        super().__init__(f"第 {chapter_index} 话质检不通过：{'；'.join(issue.message for issue in issues[:5])}")


@lru_cache(maxsize=128)
def _glossary_source_pattern(terms: tuple[str, ...]) -> re.Pattern:
    alternatives = []
    for term in sorted(set(terms), key=lambda term: (-len(term), term)):
        if not term:
            continue
        before = r'(?<![ァ-ヺー・])' if re.fullmatch(r'[ァ-ヺ]',term[0]) else ''
        after = r'(?![ー・]*[ァ-ヺ])' if re.fullmatch(r'[ァ-ヺ]',term[-1]) else ''
        if term[0].isascii() and term[0].isalnum():
            before = r'(?<![A-Za-z0-9_])'
        if term[-1].isascii() and term[-1].isalnum():
            after = r'(?![A-Za-z0-9_])'
        alternatives.append(before+re.escape(term)+after)
    return re.compile('|'.join(alternatives) if alternatives else r'(?!)')


def _glossary_sources_in_text(text: str, terms: tuple[str, ...]) -> set[str]:
    # Leftmost, longest lexical match: a full name must not also trigger its
    # nickname. Honorifics and elongated exclamations remain legitimate hits.
    return {match.group(0) for match in _glossary_source_pattern(terms).finditer(text)}


def _deterministic_quality_issues(source: list[str], translated: list[str], memory: dict[str, object]) -> list[QualityIssue]:
    issues: list[QualityIssue] = []
    for index, (source_text, target_text) in enumerate(zip(source, translated, strict=True), start=1):
        if source_text == target_text and KANA_RE.search(source_text):
            issues.append(QualityIssue(f"第 {index} 段疑似未翻译", "hard", index))
        kana_count = len(KANA_RE.findall(target_text))
        if kana_count >= 4 and kana_count / max(1, len(target_text)) > 0.04:
            issues.append(QualityIssue(f"第 {index} 段日文假名残留较多", "hard", index))
        if KOREAN_RE.search(target_text):
            issues.append(QualityIssue(f"第 {index} 段混入韩文字符", "hard", index))
        if _contains_extra_translation_content(target_text):
            issues.append(QualityIssue(f"第 {index} 段混入翻译说明或其他非正文内容", "hard", index))
        ratio = len(target_text) / max(1, len(source_text))
        if len(source_text) >= 40 and ratio < 0.25:
            issues.append(QualityIssue(f"第 {index} 段可能漏译", "soft", index))
        if len(source_text) >= 40 and ratio > 2.5 and len(target_text) - len(source_text) >= 80:
            issues.append(QualityIssue(f"第 {index} 段可能过度扩写", "soft", index))
    glossary = memory.get("glossary")
    if isinstance(glossary, list):
        combined_target = "\n".join(translated)
        terms = tuple(item['source'].strip() for item in glossary if isinstance(item,dict) and isinstance(item.get('source'),str) and item['source'].strip())
        occurrences = [_glossary_sources_in_text(text, terms) for text in source]
        all_occurrences = set().union(*occurrences)
        for item in glossary:
            if not isinstance(item, dict):
                continue
            source_term, target_term = item.get("source"), item.get("target")
            if not isinstance(source_term, str) or not isinstance(target_term, str):
                continue
            source_term, target_term = source_term.strip(), target_term.strip()
            if not source_term or not target_term:
                continue
            if item.get("locked") is True:
                # A combined-text check misses mixed variants whenever one correct
                # occurrence exists elsewhere in the same chunk. Check the exact
                # source/target paragraph pair so every occurrence is enforceable
                # and the focused repair pass can rewrite only the drifting line.
                for index, (source_text, target_text) in enumerate(zip(source, translated, strict=True), start=1):
                    if source_term in occurrences[index-1] and not _locked_target_present(target_text, target_term):
                        issues.append(
                            QualityIssue(
                                f"第 {index} 段专名 {source_term} 必须统一为 {target_term}",
                                "hard",
                                index,
                            )
                        )
            elif source_term in all_occurrences and not any(
                _locked_target_present(combined_target, target)
                for target in _glossary_target_candidates(target_term)
            ):
                issues.append(QualityIssue(f"术语 {source_term} 未使用既定译名 {target_term}", "soft"))
    # Preserve blocking errors even when earlier paragraphs produced many warnings.
    return sorted(issues, key=lambda issue: issue.severity != "hard")[:30]


def _locked_target_present(text: str, target_term: str) -> bool:
    """Match the canonical name while allowing contextual outer punctuation.

    A media title may be stored as ``《布丁Q娃》`` but appear without book-title
    marks in dialogue. The lexical name is still identical. Character-name
    changes such as 西尔维娅→西尔维亚 do not differ only by wrappers and remain
    hard failures.
    """
    if target_term in text:
        return True
    wrappers = (("《", "》"), ("「", "」"), ("『", "』"), ("“", "”"), ('"', '"'), ("〈", "〉"))
    for opening, closing in wrappers:
        if target_term.startswith(opening) and target_term.endswith(closing):
            core = target_term[len(opening) : len(target_term) - len(closing)].strip()
            return bool(core and core in text)
    return False


def _contains_extra_translation_content(text: str) -> bool:
    return bool(
        EXTRA_CONTENT_PREFIX_RE.search(text)
        or EXTRA_CONTENT_SUFFIX_RE.search(text)
        or EXTRA_CONTENT_LINE_RE.search(text)
        or "```json" in text.lower()
        or "```markdown" in text.lower()
    )
