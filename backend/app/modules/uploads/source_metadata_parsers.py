"""Provider metadata parsing, independent of HTTP retrieval and URL selection."""
from html.parser import HTMLParser
import json
import re

from fastapi import HTTPException, status
from app.modules.uploads.schemas import WorkSourceEpisode, WorkSourceMetadata


HTML_VOID_ELEMENTS = frozenset({
    "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta",
    "param", "source", "track", "wbr",
})
KAKUYOMU_SCHEDULE_TIME_RE = re.compile(r"(?<!\d)([01]?\d|2[0-3]):([0-5]\d)(?!\d)")
KAKUYOMU_TIMEZONE = "Asia/Tokyo"


def _decode_source_json(payload: bytes | str) -> object:
    try:
        return json.loads(payload)
    except (ValueError, TypeError, RecursionError) as error:
        raise unrecognized_source() from error


def _source_object(value: object) -> dict[str, object]:
    if not isinstance(value, dict):
        raise unrecognized_source()
    return value


def parse_kakuyomu_work_html(html: str, *, source_url: str, work_id: str) -> WorkSourceMetadata:
    parser = NextDataParser()
    parser.feed(html)
    if not parser.payload:
        raise unrecognized_source()

    page_data = _source_object(_decode_source_json(parser.payload))
    props = _source_object(page_data.get("props"))
    page_props = _source_object(props.get("pageProps"))
    apollo_state = _source_object(page_props.get("__APOLLO_STATE__"))
    work = _source_object(apollo_state.get(f"Work:{work_id}"))
    author_record = resolve_apollo_reference(apollo_state, work.get("author")) or {}
    title = require_text(work.get("title"), "作品名")
    author = optional_text(author_record.get("activityName")) or optional_text(author_record.get("name")) or "未知作者"

    catchphrase = optional_text(work.get("catchphrase"))
    introduction = optional_text(work.get("introduction"))
    tags = unique_strings(work.get("tagLabels"))
    episodes = parse_kakuyomu_catalog(apollo_state, work, source_url=source_url)
    schedule_label, schedule_time = parse_kakuyomu_schedule(apollo_state, work)
    return WorkSourceMetadata(
        author=author,
        character_count=non_negative_int(work.get("totalCharacterCount")),
        cover_url=optional_text(work.get("ogImageUrl")),
        description="\n\n".join(part for part in (catchphrase, introduction) if part),
        episode_count=non_negative_int(work.get("publicEpisodeCount")),
        publication_status="completed" if work.get("serialStatus") == "COMPLETED" else "ongoing",
        source="kakuyomu",
        source_url=source_url,
        tags=tags,
        title=title,
        episodes=episodes,
        schedule_label=schedule_label,
        schedule_time=schedule_time,
        schedule_timezone=KAKUYOMU_TIMEZONE if schedule_time else None,
    )


def parse_kakuyomu_schedule(
    apollo_state: dict[str, object],
    work: dict[str, object],
) -> tuple[str | None, str | None]:
    schedule_record = resolve_apollo_reference(apollo_state, work.get("schedule"))
    schedule_label = optional_text(schedule_record.get("description")) if schedule_record else None
    if not schedule_label:
        return None, None

    match = KAKUYOMU_SCHEDULE_TIME_RE.search(schedule_label)
    if not match:
        return schedule_label, None
    return schedule_label, f"{int(match.group(1)):02d}:{match.group(2)}"


def parse_kakuyomu_catalog(
    apollo_state: dict[str, object],
    work: dict[str, object],
    *,
    source_url: str,
) -> list[WorkSourceEpisode]:
    table_of_contents = work.get("tableOfContentsV2")
    if not isinstance(table_of_contents, list):
        return []

    episodes: list[WorkSourceEpisode] = []
    for table_reference in table_of_contents:
        table_record = resolve_apollo_reference(apollo_state, table_reference)
        if not table_record:
            continue
        chapter_record = resolve_apollo_reference(apollo_state, table_record.get("chapter"))
        section_title = optional_text(chapter_record.get("title")) if chapter_record else None
        section_level = bounded_level(chapter_record.get("level")) if chapter_record else 1
        episode_references = table_record.get("episodeUnions")
        if not isinstance(episode_references, list):
            continue
        for episode_reference in episode_references:
            episode_record = resolve_apollo_reference(apollo_state, episode_reference)
            if not episode_record:
                continue
            episode_id = optional_text(episode_record.get("id"))
            episode_title = optional_text(episode_record.get("title"))
            if not episode_id or not episode_title:
                continue
            episodes.append(
                WorkSourceEpisode(
                    index=len(episodes) + 1,
                    title=episode_title,
                    url=f"{source_url}/episodes/{episode_id}",
                    section_title=section_title,
                    section_level=section_level,
                )
            )
    return episodes


def resolve_apollo_reference(apollo_state: dict[str, object], value: object) -> dict[str, object] | None:
    if not isinstance(value, dict):
        return None
    reference = value.get("__ref")
    record = apollo_state.get(reference) if isinstance(reference, str) else value
    return record if isinstance(record, dict) else None


def bounded_level(value: object) -> int:
    if not isinstance(value, int) or isinstance(value, bool):
        return 1
    return min(6, max(1, value))


def parse_narou_api_json(payload: bytes, *, source_url: str) -> WorkSourceMetadata:
    records = _decode_source_json(payload)
    if not isinstance(records, list) or len(records) < 2:
        raise unrecognized_source()
    work = _source_object(records[1])
    episode_count = non_negative_int(work.get("general_all_no"))
    # Narou short stories have one API episode, but unlike serialized works
    # their prose is served at the work root.  `/1/` is a real 404 for them.
    is_short_story = work.get("novel_type") == 2
    return WorkSourceMetadata(
        author=require_text(work.get("writer"), "作者"),
        character_count=non_negative_int(work.get("length")),
        cover_url=None,
        description=optional_text(work.get("story")) or "",
        episode_count=episode_count,
        publication_status="completed" if work.get("end") == 0 else "ongoing",
        source="narou",
        source_url=source_url,
        tags=split_keywords(work.get("keyword")),
        title=require_text(work.get("title"), "作品名"),
        episodes=[
            WorkSourceEpisode(
                index=index,
                title=f"第 {index} 话",
                url=source_url if is_short_story else f"{source_url}{index}/",
            )
            for index in range(1, episode_count + 1)
        ],
    )


def parse_hameln_work_html(html: str, *, source_url: str) -> WorkSourceMetadata:
    parser = PublicWorkHTMLParser()
    parser.feed(html)
    title = first_value(parser.itemprops.get("name")) or remove_suffix(parser.meta.get("og:title"), " - ハーメルン")
    author = first_value(parser.itemprops.get("author")) or "未知作者"
    tags = unique_strings([*(parser.itemprops.get("genre") or []), *(parser.itemprops.get("keywords") or [])])
    description = clean_multiline("".join(parser.summary_parts)) or optional_text(parser.meta.get("og:description")) or ""
    episode_paths = sorted(parser.episode_paths, key=lambda value: int(re.search(r"\d+", value).group()))
    return WorkSourceMetadata(
        author=author,
        character_count=0,
        cover_url=optional_text(parser.meta.get("og:image")),
        description=description,
        episode_count=len(episode_paths),
        publication_status="completed" if re.search(r"完結済|完結作品|【完結】", html) else "ongoing",
        source="hameln",
        source_url=source_url,
        tags=tags,
        title=require_text(title, "作品名"),
        episodes=[
            WorkSourceEpisode(
                index=index,
                title=f"第 {index} 话",
                url=f"{source_url}{path.removeprefix('./')}",
            )
            for index, path in enumerate(episode_paths, start=1)
        ],
    )


def parse_pixiv_api_json(payload: bytes, *, source_url: str, kind: str) -> WorkSourceMetadata:
    result = _source_object(_decode_source_json(payload))
    if result.get("error") is True:
        raise unrecognized_source()
    work = _source_object(result.get("body"))

    if kind == "series":
        episode_count = non_negative_int(work.get("publishedContentCount"))
        character_count = non_negative_int(work.get("publishedTotalCharacterCount"))
        description = clean_html_fragment(work.get("caption"))
        publication_status = "completed" if work.get("isConcluded") is True else "ongoing"
        cover_url = nested_text(work, "cover", "urls", "original") or nested_text(work, "firstEpisode", "url")
    else:
        episode_count = 1
        character_count = non_negative_int(work.get("characterCount"))
        description = clean_html_fragment(work.get("description"))
        publication_status = "completed"
        cover_url = optional_text(work.get("coverUrl"))

    return WorkSourceMetadata(
        author=require_text(work.get("userName"), "作者"),
        character_count=character_count,
        cover_url=cover_url,
        description=description,
        episode_count=episode_count,
        publication_status=publication_status,
        source="pixiv",
        source_url=source_url,
        tags=parse_pixiv_tags(work.get("tags")),
        title=require_text(work.get("title"), "作品名"),
    )


class NextDataParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self._is_next_data = False
        self._parts: list[str] = []

    @property
    def payload(self) -> str:
        return "".join(self._parts).strip()

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = dict(attrs)
        self._is_next_data = tag == "script" and attributes.get("id") == "__NEXT_DATA__"

    def handle_endtag(self, tag: str) -> None:
        if tag == "script" and self._is_next_data:
            self._is_next_data = False

    def handle_data(self, data: str) -> None:
        if self._is_next_data:
            self._parts.append(data)


class PublicWorkHTMLParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.meta: dict[str, str] = {}
        self.itemprops: dict[str, list[str]] = {}
        self.episode_paths: set[str] = set()
        self.summary_parts: list[str] = []
        self._captures: list[dict[str, object]] = []
        self._summary_depth = 0
        self._summary_index = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = dict(attrs)
        if tag not in HTML_VOID_ELEMENTS:
            for capture in self._captures:
                capture["depth"] = int(capture["depth"]) + 1

        itemprop = attributes.get("itemprop")
        if itemprop in {"name", "author", "genre", "keywords"}:
            if tag in HTML_VOID_ELEMENTS:
                value = optional_text(attributes.get("content"))
                if value:
                    self.itemprops.setdefault(itemprop, []).append(value)
            else:
                self._captures.append({"depth": 1, "parts": [], "property": itemprop})

        meta_key = attributes.get("property") or attributes.get("name")
        meta_content = attributes.get("content")
        if tag == "meta" and meta_key and meta_content:
            self.meta[meta_key.lower()] = meta_content.strip()

        classes = set((attributes.get("class") or "").split())
        if tag == "div" and "ss" in classes and self._summary_depth == 0:
            self._summary_index += 1
            if self._summary_index == 2:
                self._summary_depth = 1
        elif tag == "div" and self._summary_depth > 0:
            self._summary_depth += 1

        href = attributes.get("href") or ""
        if tag == "a" and re.fullmatch(r"\./\d+\.html", href):
            self.episode_paths.add(href)
        if tag == "br" and self._summary_depth > 0:
            self.summary_parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in HTML_VOID_ELEMENTS:
            return
        completed: list[dict[str, object]] = []
        for capture in self._captures:
            capture["depth"] = int(capture["depth"]) - 1
            if capture["depth"] == 0:
                completed.append(capture)
        for capture in completed:
            self._captures.remove(capture)
            value = clean_inline("".join(capture["parts"]))
            if value:
                self.itemprops.setdefault(str(capture["property"]), []).append(value)

        if tag == "div" and self._summary_depth > 0:
            self._summary_depth -= 1

    def handle_data(self, data: str) -> None:
        for capture in self._captures:
            capture["parts"].append(data)
        if self._summary_depth > 0:
            self.summary_parts.append(data)


class TextOnlyHTMLParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        del attrs
        if tag in {"br", "p", "div"}:
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        self.parts.append(data)


def unrecognized_source() -> HTTPException:
    return HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="来源页面结构无法识别")


def optional_text(value: object) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


def require_text(value: object, label: str) -> str:
    text = optional_text(value)
    if not text:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=f"页面缺少{label}")
    return text


def non_negative_int(value: object) -> int:
    return value if isinstance(value, int) and value >= 0 else 0


def unique_strings(values: object) -> list[str]:
    if not isinstance(values, (list, tuple)):
        return []
    return list(dict.fromkeys(value.strip() for value in values if isinstance(value, str) and value.strip()))


def split_keywords(value: object) -> list[str]:
    return list(dict.fromkeys(re.split(r"[\s,，]+", value.strip()))) if isinstance(value, str) and value.strip() else []


def first_value(values: list[str] | None) -> str | None:
    return values[0] if values else None


def remove_suffix(value: object, suffix: str) -> str | None:
    text = optional_text(value)
    return text.removesuffix(suffix).strip() if text else None


def clean_inline(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()


def clean_multiline(value: str) -> str:
    lines = [clean_inline(line) for line in value.replace("\r", "").split("\n")]
    return "\n".join(line for line in lines if line).strip()


def clean_html_fragment(value: object) -> str:
    if not isinstance(value, str) or not value.strip():
        return ""
    parser = TextOnlyHTMLParser()
    parser.feed(value)
    return clean_multiline("".join(parser.parts))


def parse_pixiv_tags(value: object) -> list[str]:
    if isinstance(value, dict):
        value = value.get("tags")
    if not isinstance(value, list):
        return []
    tags = [item.get("tag") if isinstance(item, dict) else item for item in value]
    return unique_strings(tags)


def nested_text(value: object, *keys: str) -> str | None:
    current = value
    for key in keys:
        if not isinstance(current, dict):
            return None
        current = current.get(key)
    return optional_text(current)
