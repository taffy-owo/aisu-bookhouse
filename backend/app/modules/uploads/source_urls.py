"""Normalize complete platform links without matching substrings of other URLs."""
from dataclasses import dataclass
import re
from urllib.parse import parse_qs, quote, urlsplit, urlunsplit

from fastapi import HTTPException, status


SUPPORTED_SOURCE_HOSTS = frozenset({
    "kakuyomu.jp", "www.kakuyomu.jp", "ncode.syosetu.com", "novel18.syosetu.com",
    "syosetu.org", "www.syosetu.org", "pixiv.net", "www.pixiv.net",
})
SUPPORTED_SOURCE_INPUT_RE = re.compile(
    r"https?://[^\s<>\"'{}\[\]]+|"
    r"(?<![A-Za-z0-9_.:/-])(?:www\.)?(?:"
    r"kakuyomu\.jp|ncode\.syosetu\.com|novel18\.syosetu\.com|syosetu\.org|pixiv\.net"
    r")[^\s<>\"'{}\[\]]*", re.IGNORECASE,
)
PIXIV_SERIES_PATH_RE = re.compile(r"^/novel/series/(\d+)/?$")
SOURCE_INPUT_TRAILING_PUNCTUATION = "\u3000。，、；：！？）】》」』〉),.!;:"


@dataclass(frozen=True)
class SourceTarget:
    kind: str
    provider: str
    source_url: str
    work_id: str


def normalize_work_source_url(raw_url: str) -> SourceTarget:
    try:
        candidate = extract_supported_source_url(raw_url)
        parsed = urlsplit(candidate)
        port = parsed.port
    except ValueError as error:
        raise invalid_source_url() from error

    host = (parsed.hostname or "").lower()
    if parsed.scheme.lower() not in {"http", "https"} or port not in {None, 80, 443} or parsed.username or parsed.password:
        raise invalid_source_url()

    match = re.fullmatch(r"/works/(\d+)(?:/episodes/[0-9a-z-]+)?/?", parsed.path, re.IGNORECASE)
    if host in {"kakuyomu.jp", "www.kakuyomu.jp"} and match:
        work_id = match.group(1)
        return SourceTarget("work", "kakuyomu", f"https://kakuyomu.jp/works/{work_id}", work_id)

    match = re.fullmatch(r"/(n[0-9a-z]+)(?:/\d+)?/?", parsed.path, re.IGNORECASE)
    if host in {"ncode.syosetu.com", "novel18.syosetu.com"} and match:
        work_id = match.group(1).lower()
        return SourceTarget("work", "narou", urlunsplit(("https", host, f"/{work_id}/", "", "")), work_id)

    match = re.fullmatch(r"/novel/(\d+)(?:/\d+\.html)?/?", parsed.path, re.IGNORECASE)
    if host in {"syosetu.org", "www.syosetu.org"} and match:
        work_id = match.group(1)
        return SourceTarget("work", "hameln", f"https://syosetu.org/novel/{work_id}/", work_id)

    pixiv_path = re.sub(r"^/[a-z]{2}(?=/novel/)", "", parsed.path, flags=re.IGNORECASE)
    match = PIXIV_SERIES_PATH_RE.fullmatch(pixiv_path)
    if host in {"pixiv.net", "www.pixiv.net"} and match:
        work_id = match.group(1)
        return SourceTarget("series", "pixiv", f"https://www.pixiv.net/novel/series/{work_id}", work_id)

    if host in {"pixiv.net", "www.pixiv.net"} and pixiv_path == "/novel/show.php":
        work_ids = parse_qs(parsed.query).get("id", [])
        if len(work_ids) == 1 and work_ids[0].isdigit():
            work_id = work_ids[0]
            return SourceTarget("novel", "pixiv", f"https://www.pixiv.net/novel/show.php?id={work_id}", work_id)

    raise invalid_source_url()


def extract_supported_source_url(raw_value: str) -> str:
    for match in SUPPORTED_SOURCE_INPUT_RE.finditer(raw_value.strip()):
        candidate = match.group(0).rstrip(SOURCE_INPUT_TRAILING_PUNCTUATION)
        if not re.match(r"^https?://", candidate, flags=re.IGNORECASE):
            candidate = f"https://{candidate}"
        try:
            host = (urlsplit(candidate).hostname or "").lower()
        except ValueError:
            continue
        if host in SUPPORTED_SOURCE_HOSTS:
            return candidate
    raise invalid_source_url()


def build_narou_api_url(target: SourceTarget) -> str:
    api_name = "novel18api" if urlsplit(target.source_url).hostname == "novel18.syosetu.com" else "novelapi"
    return f"https://api.syosetu.com/{api_name}/api/?out=json&ncode={quote(target.work_id.upper())}"


def invalid_source_url() -> HTTPException:
    return HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="暂不支持这个作品链接")
