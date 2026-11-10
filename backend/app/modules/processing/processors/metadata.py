import html
import re
from uuid import UUID


DESCRIPTION_BLOCK_TAG_PATTERN = re.compile(r"(?i)</(p|div|section|article|h[1-6]|li|tr)>")
HTML_BREAK_PATTERN = re.compile(r"(?i)<br\s*/?>")
HTML_TAG_PATTERN = re.compile(r"(?s)<[^>]+>")
SCRIPT_STYLE_PATTERN = re.compile(r"(?is)<(script|style).*?>.*?</\1>")
INLINE_WHITESPACE_PATTERN = re.compile(r"[ \t\f\v]+")


def clean_metadata_title(title: str | None) -> str | None:
    if not title:
        return None

    normalized_title = title.strip()
    if not normalized_title or is_machine_generated_title(normalized_title):
        return None

    return normalized_title


def clean_metadata_description(description: str | None) -> str | None:
    if not description:
        return None

    cleaned = html.unescape(description).replace("\xa0", " ")
    cleaned = SCRIPT_STYLE_PATTERN.sub("", cleaned)
    cleaned = HTML_BREAK_PATTERN.sub("\n", cleaned)
    cleaned = DESCRIPTION_BLOCK_TAG_PATTERN.sub("\n", cleaned)
    cleaned = HTML_TAG_PATTERN.sub("", cleaned)
    cleaned = html.unescape(cleaned).replace("\xa0", " ")

    lines = [INLINE_WHITESPACE_PATTERN.sub(" ", line).strip() for line in cleaned.splitlines()]
    normalized = "\n".join(line for line in lines if line)
    return normalized or None


def is_machine_generated_title(title: str) -> bool:
    try:
        UUID(title)
        return True
    except ValueError:
        return False
