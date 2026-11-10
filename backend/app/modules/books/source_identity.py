"""Stable URL identity without discarding meaningful paths or query parameters."""

from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit


def source_url_identity(value):
    if not isinstance(value, str) or not value.strip():
        return None
    value = value.strip()
    try:
        parts = urlsplit(value)
        if (
            parts.scheme.lower() not in {"http", "https"}
            or not parts.hostname
            or parts.username
            or parts.password
        ):
            return value
        return urlunsplit(
            (
                parts.scheme.lower(),
                parts.netloc.lower(),
                parts.path.rstrip("/"),
                urlencode(sorted(parse_qsl(parts.query, keep_blank_values=True))),
                "",
            )
        )
    except ValueError:
        return value
