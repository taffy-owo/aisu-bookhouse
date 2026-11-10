import re


KANA_PATTERN = re.compile(r"[\u3040-\u30ff\u31f0-\u31ff]")
HAN_PATTERN = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff]")
LATIN_PATTERN = re.compile(r"[A-Za-z]")
LANGUAGE_TAG_PATTERN = re.compile(r"[a-z]{2,8}(?:-[a-z0-9]{1,8})*")
WORD_PATTERN = re.compile(r"[^\W\d_]+")
NON_PROSE_ADDRESS_PATTERN = re.compile(r"https?://\S+|www\.\S+|\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b", re.IGNORECASE)
ENGLISH_PROSE_MARKERS = frozenset({
    "the", "and", "this", "that", "with", "she", "her", "he", "his",
    "they", "their", "were", "would", "could", "there", "then", "which",
    "have", "from", "not", "but", "you", "your", "for", "what", "when", "while",
})


def normalize_declared_language(value: str | None) -> str | None:
    if not value:
        return None

    normalized = value.strip().lower().replace("_", "-")
    named_languages = {"日本語": "ja", "japanese": "ja", "中文": "zh", "chinese": "zh", "english": "en", "other": "other"}
    if normalized in named_languages:
        return named_languages[normalized]
    if not LANGUAGE_TAG_PATTERN.fullmatch(normalized):
        return None

    # Match the whole primary subtag: jam, zha and enm are not ja, zh or en.
    primary = normalized.split("-", 1)[0]
    if primary in {"und", "mul", "zxx", "mis"}:
        return None
    return {"ja": "ja", "jpn": "ja", "zh": "zh", "chi": "zh", "zho": "zh", "en": "en", "eng": "en"}.get(primary, "other")


def detect_book_language(*samples: str | None, declared_language: str | None = None) -> str:
    declared = normalize_declared_language(declared_language)
    text = "\n".join(sample for sample in samples if sample)[:200_000]
    if not text.strip():
        return declared if declared in {"zh", "en", "other"} else "und"

    kana_count = len(KANA_PATTERN.findall(text))
    han_count = len(HAN_PATTERN.findall(text))
    latin_count = len(LATIN_PATTERN.findall(text))
    letter_count = sum(character.isalpha() for character in text)
    cjk_count = kana_count + han_count
    kana_share = kana_count / max(cjk_count, 1)
    cjk_dominant = cjk_count * 2 >= letter_count

    # EPUB metadata is often inherited from the Japanese source even after a
    # Chinese translation replaces the body. Treat the actual readable text as
    # authoritative and require sustained kana usage before calling a book a
    # Japanese original. A Japanese title/author alone is not enough.
    if cjk_dominant and kana_count >= 24 and cjk_count >= 48 and kana_share >= 0.18:
        return "ja"
    if cjk_dominant and han_count >= 32 and cjk_count >= 48 and kana_share <= 0.10:
        return "zh"

    # A publisher's English notice does not make Cyrillic, Arabic or Korean
    # prose English. An explicit other-language declaration also survives a
    # Latin alphabet, which by itself cannot distinguish English from French.
    other_letter_count = letter_count - cjk_count - latin_count
    if other_letter_count >= 32 and other_letter_count * 2 >= letter_count:
        return "other"
    if declared == "other":
        return "other"
    if latin_count >= 40 and latin_count > han_count * 2 and latin_count * 2 >= letter_count and has_english_prose_evidence(text):
        return "en"

    # Chinese and English declarations are useful fallbacks. A Japanese
    # declaration remains unverified when there is no prose evidence; image
    # books can be marked as Japanese manually from the detail page.
    if declared in {"zh", "en"}:
        return declared
    if cjk_dominant and han_count >= 16 and kana_count == 0 and han_count >= latin_count:
        return "zh"
    return "und"


def has_english_prose_evidence(text: str) -> bool:
    # Be conservative for unlabeled Latin text; unknown is preferable to
    # asserting English from names, URLs, French or German prose alone.
    words = WORD_PATTERN.findall(NON_PROSE_ADDRESS_PATTERN.sub(" ", text).casefold())
    markers = [word for word in words if word in ENGLISH_PROSE_MARKERS]
    return len(set(markers)) >= 2 and len(markers) >= 4 and len(markers) / max(len(words), 1) >= 0.08
