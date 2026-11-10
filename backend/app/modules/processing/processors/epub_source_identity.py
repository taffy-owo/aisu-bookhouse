"""EPUB chapter provenance shared by the file writer and processor."""
from collections.abc import Mapping
from html import escape
from urllib.parse import urlsplit
from xml.etree.ElementTree import ParseError

import defusedxml.ElementTree as SafeElementTree
from defusedxml.common import DefusedXmlException

XHTML_NS = 'http://www.w3.org/1999/xhtml'
IDENTITY_FIELDS = {
    'aisu:source-id': ('external_source_id', 'source_id', 255),
    'aisu:source-url': ('source_episode_url', 'source_url', 2000),
}


def _identity_value(value: object, *, limit: int, is_url: bool) -> str | None:
    if not isinstance(value, str) or not value.strip() or len(value) > limit:
        return None
    value = value.strip()
    if is_url:
        try:
            parsed = urlsplit(value)
            if parsed.scheme not in {'http', 'https'} or not parsed.hostname or parsed.username or parsed.password:
                return None
        except ValueError:
            return None
    return value


def epub_source_identity_tags(chapter: Mapping[str, object]) -> str:
    tags = []
    for name, (asset_key, chapter_key, limit) in IDENTITY_FIELDS.items():
        value = _identity_value(chapter.get(chapter_key) or chapter.get(asset_key),
                                limit=limit, is_url=chapter_key == 'source_url')
        if value:
            tags.append(f'<meta name="{name}" content="{escape(value, quote=True)}"/>')
    return ''.join(tags)


def extract_epub_source_identity(document: bytes) -> dict[str, object]:
    if b'aisu:source-' not in document:
        return {}
    try:
        root = SafeElementTree.fromstring(document)
    except (ParseError, DefusedXmlException):
        return {}
    head = root.find(f'{{{XHTML_NS}}}head')
    if head is None:
        return {}
    values: dict[str, set[str]] = {}
    for meta in head.findall(f'{{{XHTML_NS}}}meta'):
        name = meta.get('name', '').lower()
        field = IDENTITY_FIELDS.get(name)
        if field:
            asset_key, chapter_key, limit = field
            value = _identity_value(meta.get('content'), limit=limit, is_url=chapter_key == 'source_url')
            if value:
                values.setdefault(asset_key, set()).add(value)
    # Conflicting declarations cannot establish a unique source identity.
    return {key: next(iter(candidates)) for key, candidates in values.items() if len(candidates) == 1}
