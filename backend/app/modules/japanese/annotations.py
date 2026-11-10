"""Japanese readings with a tagger owned by each calling thread."""
import re
import threading

from fugashi import Tagger

from app.modules.japanese.schemas import JapaneseAnnotationResponse, JapaneseAnnotationResult, JapaneseAnnotationSpan


_kanji_pattern = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3005]")
_tagger_state = threading.local()


def annotate_japanese_texts(texts: list[str]) -> JapaneseAnnotationResponse:
    return JapaneseAnnotationResponse(
        annotations=[JapaneseAnnotationResult(text=text, spans=_annotate_japanese_text(text)) for text in texts]
    )


def _annotate_japanese_text(text: str) -> list[JapaneseAnnotationSpan]:
    spans: list[JapaneseAnnotationSpan] = []
    consumed = 0
    for token in _get_tagger()(text):
        whitespace = str(token.white_space)
        if whitespace:
            _append_annotation_span(spans, whitespace)
            consumed += len(whitespace)

        original = str(token.surface)
        consumed += len(original)
        reading = _resolve_token_reading(original, getattr(token.feature, "kana", None))
        ruby = reading if reading and reading != original and _kanji_pattern.search(original) else None
        _append_annotation_span(spans, original, ruby)

    if consumed < len(text):
        _append_annotation_span(spans, text[consumed:])
    return spans or [JapaneseAnnotationSpan(text=text)]


def _get_tagger() -> Tagger:
    tagger = getattr(_tagger_state, "tagger", None)
    if tagger is None:
        tagger = Tagger()
        _tagger_state.tagger = tagger
    return tagger


def _resolve_token_reading(original: str, katakana: object) -> str | None:
    if original == "私":
        return "わたし"
    if not isinstance(katakana, str) or not katakana or katakana == "*":
        return None
    return "".join(chr(ord(character) - 0x60) if "ァ" <= character <= "ヶ" else character for character in katakana)


def _append_annotation_span(spans: list[JapaneseAnnotationSpan], text: str, ruby: str | None = None) -> None:
    if not text:
        return
    if spans and ruby is None and spans[-1].ruby is None:
        spans[-1].text += text
    else:
        spans.append(JapaneseAnnotationSpan(text=text, ruby=ruby))
