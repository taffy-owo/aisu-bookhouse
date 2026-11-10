"""Bounded source retrieval and provider dispatch."""
import httpx
from fastapi import HTTPException, status
from app.core.safe_outbound import PinnedPublicTransport

from app.modules.uploads.schemas import WorkSourceEpisode, WorkSourceMetadata
from app.modules.uploads.source_urls import build_narou_api_url, invalid_source_url, normalize_work_source_url
from app.modules.uploads.source_metadata_parsers import (
    parse_hameln_work_html, parse_kakuyomu_work_html, parse_narou_api_json, parse_pixiv_api_json,
)


MAX_SOURCE_RESPONSE_BYTES = 3_000_000
SOURCE_LOOKUP_TIMEOUT_SECONDS = 15.0


def normalize_kakuyomu_work_url(raw_url: str) -> tuple[str, str]:
    """Compatibility wrapper for callers that only accept Kakuyomu works."""
    target = normalize_work_source_url(raw_url)
    if target.provider != "kakuyomu":
        raise invalid_source_url()
    return target.source_url, target.work_id


async def fetch_work_source_metadata(raw_url: str, *, public_only: bool = False, flaresolverr_url: str = "") -> WorkSourceMetadata:
    target = normalize_work_source_url(raw_url)
    try:
        async with httpx.AsyncClient(
            headers={"Accept-Language": "ja,en;q=0.8", "User-Agent": "AisuBookhouse/1.0 (+metadata lookup)"},
            follow_redirects=False,
            timeout=SOURCE_LOOKUP_TIMEOUT_SECONDS,
            **({"transport": PinnedPublicTransport(), "trust_env": False} if public_only else {}),
        ) as client:
            if target.provider == "narou":
                api_url = build_narou_api_url(target)
                payload = await fetch_limited_bytes(client, api_url, accept="application/json")
                return parse_narou_api_json(payload, source_url=target.source_url)
            if target.provider == "pixiv":
                api_path = "series" if target.kind == "series" else "novel"
                api_url = f"https://www.pixiv.net/ajax/novel/{api_path + '/' if api_path == 'series' else ''}{target.work_id}"
                payload = await fetch_limited_bytes(
                    client,
                    api_url,
                    accept="application/json",
                    headers={"Referer": target.source_url},
                )
                metadata = parse_pixiv_api_json(payload, source_url=target.source_url, kind=target.kind)
                if target.kind == "series":
                    from app.modules.translations.source_text import fetch_pixiv_series_catalog

                    episodes = await fetch_pixiv_series_catalog(target.work_id, target.source_url, metadata.episode_count,
                                                                **({"public_only": True} if public_only else {}))
                    return metadata.model_copy(update={"episodes": episodes})
                return metadata.model_copy(
                    update={
                        "episodes": [
                            WorkSourceEpisode(index=1, title=metadata.title, url=target.source_url)
                        ]
                    }
                )

            try:
                payload = await fetch_limited_bytes(client, target.source_url, accept="text/html,application/xhtml+xml")
            except HTTPException as error:
                if target.provider != "hameln" or error.status_code != 502 or not flaresolverr_url:
                    raise
                from app.modules.translations.source_text import _fetch_with_flaresolverr
                async with httpx.AsyncClient(follow_redirects=False, trust_env=False, timeout=70.0) as helper:
                    payload = await _fetch_with_flaresolverr(helper, flaresolverr_url, target.source_url)
            html = payload.decode("utf-8", errors="replace")
            if target.provider == "kakuyomu":
                return parse_kakuyomu_work_html(html, source_url=target.source_url, work_id=target.work_id)
            return parse_hameln_work_html(html, source_url=target.source_url)
    except HTTPException:
        raise
    except httpx.HTTPError as error:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="来源网站连接失败，请稍后重试") from error


async def fetch_limited_bytes(
    client: httpx.AsyncClient,
    url: str,
    *,
    accept: str,
    headers: dict[str, str] | None = None,
) -> bytes:
    request_headers = {"Accept": accept, **(headers or {})}
    async with client.stream("GET", url, headers=request_headers) as response:
        if response.status_code == status.HTTP_404_NOT_FOUND:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="没有找到这个作品")
        if response.status_code >= 400:
            raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="来源网站暂时拒绝访问")
        chunks: list[bytes] = []
        total_bytes = 0
        async for chunk in response.aiter_bytes():
            total_bytes += len(chunk)
            if total_bytes > MAX_SOURCE_RESPONSE_BYTES:
                raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="来源页面数据过大")
            chunks.append(chunk)
    return b"".join(chunks)
