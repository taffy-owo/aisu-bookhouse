"""Shared EPUB document decoding and archive path resolution."""
from pathlib import PurePosixPath
import posixpath
import re
from urllib.parse import unquote


def build_archive_path(opf_parent: PurePosixPath, href: str) -> str:
    cleaned_href = href.split("#", 1)[0].split("?", 1)[0]
    base_path = "" if opf_parent.as_posix() == "." else opf_parent.as_posix()
    joined_path = posixpath.join(base_path, unquote(cleaned_href).lstrip("/"))
    return posixpath.normpath(joined_path).replace("\\", "/")



def strip_generated_chapter_title(document: bytes) -> tuple[bytes, bool]:
    """Our editor separates its one generated heading from the untouched body."""
    cleaned, count = re.subn(
        rb'(?is)(<body\b[^>]*>\s*)<h1\b(?=[^>]*\bdata-aisu-chapter-title\s*=\s*[\"\x27]true[\"\x27])[^>]*>.*?</h1\s*>',
        rb'\1', document, count=1,
    )
    return cleaned, bool(count)


def extract_body_html(html: str) -> str:
    match = re.search(r"(?is)<body\b[^>]*>(.*?)</body\s*>", html)
    return match.group(1) if match else html



def decode_document(data: bytes) -> str:
    for encoding in ("utf-8-sig", "utf-8", "gb18030"):
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            continue

    return data.decode("utf-8", errors="ignore")



def unescape_html_entities(text: str) -> str:
    import html

    return html.unescape(text).replace("\xa0", " ")

