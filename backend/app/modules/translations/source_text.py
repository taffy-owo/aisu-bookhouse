from __future__ import annotations

from dataclasses import dataclass
from html.parser import HTMLParser
import json
import re
from urllib.parse import parse_qs, urlsplit

import httpx
from fastapi import HTTPException, status
from app.core.safe_outbound import PinnedPublicTransport

from app.modules.uploads.schemas import WorkSourceEpisode
from app.modules.uploads.source_metadata import MAX_SOURCE_RESPONSE_BYTES, SOURCE_LOOKUP_TIMEOUT_SECONDS, fetch_limited_bytes


SOURCE_USER_AGENT = "AisuBookhouse/1.0 (+whole-work translation)"


@dataclass(frozen=True)
class SourceChapter:
    index: int
    title: str
    paragraphs: list[str]
    url: str
    section_title: str | None = None
    section_level: int = 1


async def fetch_source_chapter(
    episode: WorkSourceEpisode,
    provider: str,
    *,
    flaresolverr_url: str = "",
    public_only: bool = False,
) -> SourceChapter:
    async with httpx.AsyncClient(
        headers={"Accept-Language": "ja,en;q=0.8", "User-Agent": SOURCE_USER_AGENT},
        follow_redirects=False,
        timeout=SOURCE_LOOKUP_TIMEOUT_SECONDS,
        **({"transport": PinnedPublicTransport(), "trust_env": False} if public_only else {}),
    ) as client:
        if provider == "pixiv":
            chapter = await _fetch_pixiv_chapter(client, episode)
        else:
            try:
                payload = await fetch_limited_bytes(
                    client,
                    episode.url,
                    accept="text/html,application/xhtml+xml",
                    headers=_source_chapter_headers(episode.url, provider),
                )
            except HTTPException as error:
                if provider != "hameln" or error.status_code != status.HTTP_502_BAD_GATEWAY or not flaresolverr_url:
                    raise
                if public_only:
                    # Only the administrator-configured helper may be private.
                    async with httpx.AsyncClient(follow_redirects=False, trust_env=False, timeout=70.0) as helper:
                        payload = await _fetch_with_flaresolverr(helper, flaresolverr_url, episode.url)
                else:
                    payload = await _fetch_with_flaresolverr(client, flaresolverr_url, episode.url)
            parser = SourceBodyHTMLParser(provider)
            parser.feed(payload.decode("utf-8", errors="replace"))
            paragraphs = parser.paragraphs
            if not paragraphs:
                raise ValueError("来源章节正文为空或页面结构已经变化")
            chapter = SourceChapter(
                index=episode.index,
                title=parser.title or episode.title,
                paragraphs=paragraphs,
                url=episode.url,
                section_title=episode.section_title,
                section_level=episode.section_level,
            )
    return chapter


async def _fetch_with_flaresolverr(client: httpx.AsyncClient, endpoint: str, source_url: str) -> bytes:
    """Resolve a Cloudflare-protected Hameln chapter through the local helper."""
    try:
        async with client.stream("POST",
            f"{endpoint.rstrip('/')}/v1",
            json={"cmd": "request.get", "url": source_url, "maxTimeout": 60_000},
            timeout=70.0,
        ) as response:
            response.raise_for_status()
            data = bytearray()
            async for chunk in response.aiter_bytes():
                if len(data) + len(chunk) > 20_000_000:
                    raise ValueError("Helper response too large")
                data.extend(chunk)
            decoded = json.loads(data)
    except (httpx.HTTPError, ValueError) as error:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="来源网站的人机验证暂时无法通过",
        ) from error
    solution = decoded.get("solution") if isinstance(decoded, dict) else None
    html = solution.get("response") if isinstance(solution, dict) else None
    solution_status = solution.get("status") if isinstance(solution, dict) else None
    if not isinstance(decoded, dict) or decoded.get("status") != "ok" or solution_status != 200 or not isinstance(html, str) or not html.strip():
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="来源网站的人机验证暂时无法通过")
    payload = html.encode("utf-8")
    if len(payload) > MAX_SOURCE_RESPONSE_BYTES:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="来源页面数据过大")
    return payload


def _source_chapter_headers(source_url: str, provider: str) -> dict[str, str] | None:
    """Return provider-specific headers required to read a chapter page."""
    if provider == "narou" and urlsplit(source_url).hostname == "novel18.syosetu.com":
        return {"Cookie": "over18=yes"}
    return None


async def fetch_pixiv_series_catalog(series_id: str, source_url: str, episode_count: int, *, public_only: bool = False) -> list[WorkSourceEpisode]:
    episodes: list[WorkSourceEpisode] = []
    last_order = 0
    async with httpx.AsyncClient(
        headers={"Accept-Language": "ja,en;q=0.8", "User-Agent": SOURCE_USER_AGENT},
        follow_redirects=False,
        timeout=SOURCE_LOOKUP_TIMEOUT_SECONDS,
        **({"transport": PinnedPublicTransport(), "trust_env": False} if public_only else {}),
    ) as client:
        while len(episodes) < episode_count:
            url = f"https://www.pixiv.net/ajax/novel/series/{series_id}/content_titles"
            payload = await fetch_limited_bytes(
                client,
                f"{url}?limit=30&last_order={last_order}&order_by=asc",
                accept="application/json",
                headers={"Referer": source_url},
            )
            decoded = json.loads(payload)
            body = decoded.get("body") if isinstance(decoded, dict) else None
            records = body if isinstance(body, list) else body.get("thumbnails", {}).get("novel", []) if isinstance(body, dict) else []
            if not isinstance(records, list) or not records:
                break
            before = len(episodes)
            for record in records:
                if not isinstance(record, dict):
                    continue
                novel_id = str(record.get("id") or record.get("contentId") or "").strip()
                title = str(record.get("title") or "").strip()
                if not novel_id.isdigit() or any(item.url.endswith(f"id={novel_id}") for item in episodes):
                    continue
                episodes.append(
                    WorkSourceEpisode(
                        index=len(episodes) + 1,
                        title=title or f"第 {len(episodes) + 1} 话",
                        url=f"https://www.pixiv.net/novel/show.php?id={novel_id}",
                    )
                )
            if len(episodes) == before:
                break
            order_values = [record.get("order") for record in records if isinstance(record, dict) and isinstance(record.get("order"), int)]
            last_order = max(order_values, default=last_order + len(records)) + 1
    return episodes


async def _fetch_pixiv_chapter(client: httpx.AsyncClient, episode: WorkSourceEpisode) -> SourceChapter:
    novel_ids = parse_qs(urlsplit(episode.url).query).get("id", [])
    if len(novel_ids) != 1 or not novel_ids[0].isdigit():
        raise ValueError("Pixiv 章节链接无效")
    payload = await fetch_limited_bytes(
        client,
        f"https://www.pixiv.net/ajax/novel/{novel_ids[0]}",
        accept="application/json",
        headers={"Referer": episode.url},
    )
    decoded = json.loads(payload)
    body = decoded.get("body") if isinstance(decoded, dict) else None
    if not isinstance(body, dict):
        raise ValueError("Pixiv 章节接口返回无效")
    content = body.get("content")
    if not isinstance(content, str) or not content.strip():
        raise ValueError("Pixiv 章节正文为空")
    normalized = re.sub(r"\[pixivimage:\d+(?:-\d+)?]", "\n【插图】\n", content)
    normalized = re.sub(r"\[jump:\d+]", "", normalized)
    normalized = re.sub(r"\[chapter:([^]]+)]", r"\n\1\n", normalized)
    normalized = normalized.replace("[newpage]", "\n\n")
    paragraphs = _normalize_paragraphs(normalized.splitlines())
    return SourceChapter(
        index=episode.index,
        title=str(body.get("title") or episode.title).strip(),
        paragraphs=paragraphs,
        url=episode.url,
        section_title=episode.section_title,
        section_level=episode.section_level,
    )


class SourceBodyHTMLParser(HTMLParser):
    VOID_TAGS = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}
    TARGET_IDS = {
        "kakuyomu": set(),
        "narou": {"novel_honbun"},
        "hameln": {"honbun"},
    }
    TARGET_CLASSES = {
        "kakuyomu": {"widget-episodeBody", "js-episode-body"},
        # Modern Narou wraps the preface, body, and afterword in the same
        # p-novel__body container, each in a js-novel-text block. The prose
        # block carries no modifier class (it used to be --body), so match the
        # base class and reject the preface/afterword modifiers below.
        "narou": {"p-novel__text", "p-novel__text--body"},
        "hameln": {"section3", "novel_body"},
    }
    EXCLUDED_CLASSES = {
        "narou": {"p-novel__text--preface", "p-novel__text--afterword"},
    }

    def __init__(self, provider: str) -> None:
        super().__init__(convert_charrefs=True)
        self.provider = provider
        self.title: str | None = None
        self._title_depth = 0
        self._title_parts: list[str] = []
        self._body_depth = 0
        self._skip_depth = 0
        self._current: list[str] = []
        self._paragraphs: list[str] = []

    @property
    def paragraphs(self) -> list[str]:
        self._flush()
        return _normalize_paragraphs(self._paragraphs)

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = dict(attrs)
        classes = set((attributes.get("class") or "").split())
        element_id = attributes.get("id") or ""
        starts_body = self._body_depth == 0 and (
            element_id in self.TARGET_IDS.get(self.provider, set())
            or (
                classes.intersection(self.TARGET_CLASSES.get(self.provider, set()))
                and not classes.intersection(self.EXCLUDED_CLASSES.get(self.provider, set()))
            )
        )
        if starts_body:
            self._body_depth = 1
        elif self._body_depth > 0 and (tag in {"rt", "rp", "script", "style"} or self._skip_depth > 0):
            self._skip_depth += 1
            return
        elif self._body_depth > 0 and tag not in self.VOID_TAGS:
            self._body_depth += 1

        if self._body_depth > 0 and tag in {"p", "div", "br", "hr"}:
            self._flush()

        if self._title_depth == 0 and (
            element_id in {"novel_subtitle", "subtitle"}
            or classes.intersection({"widget-episodeTitle", "p-novel__title", "novel_subtitle"})
            or (tag in {"h1", "h2"} and attributes.get("itemprop") in {"headline", "name"})
        ):
            self._title_depth = 1
        elif self._title_depth > 0:
            self._title_depth += 1

    def handle_endtag(self, tag: str) -> None:
        if self._skip_depth > 0:
            self._skip_depth -= 1
        elif self._body_depth > 0:
            if tag in {"p", "div"}:
                self._flush()
            if tag not in self.VOID_TAGS:
                self._body_depth -= 1

        if self._title_depth > 0:
            self._title_depth -= 1
            if self._title_depth == 0:
                title = " ".join("".join(self._title_parts).split()).strip()
                if title:
                    self.title = title

    def handle_data(self, data: str) -> None:
        if self._title_depth > 0:
            self._title_parts.append(data)
        if self._body_depth > 0 and self._skip_depth == 0:
            self._current.append(data)

    def _flush(self) -> None:
        value = "".join(self._current).replace("\u3000", " ").strip()
        self._current.clear()
        if value:
            self._paragraphs.append(value)


def _normalize_paragraphs(values: list[str]) -> list[str]:
    normalized: list[str] = []
    for value in values:
        text = value.replace("\r", "").strip()
        if not text:
            continue
        text = re.sub(r"[ \t]+", " ", text)
        # Identical adjacent dialogue/refrains are still two source paragraphs.
        # Deduplication here silently removed text before translation and QA.
        normalized.append(text)
    return normalized
