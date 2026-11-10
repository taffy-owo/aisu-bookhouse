from __future__ import annotations

from dataclasses import dataclass
from pathlib import PurePosixPath
import re
import unicodedata

from app.modules.book_assets.domain import BookAsset
from app.modules.uploads.schemas import WorkSourceEpisode


EPISODE_NUMBER_RE = re.compile(
    r"^\s*(?:第\s*)?([0-9０-９]+)\s*(?:話|话|章|節|节|回|篇)",
    re.IGNORECASE,
)
LATIN_EPISODE_NUMBER_RE = re.compile(
    r"^\s*(?:episode|chapter|ep\.?)\s*([0-9]+)(?=$|[\s:：.．、\-—])",
    re.IGNORECASE,
)
FRONT_MATTER_SOURCE_RE = re.compile(
    r"(?:^|[-_.])(cover|title|toc|nav|contents?|copyright|colophon)(?:[-_.]|$)",
    re.IGNORECASE,
)
PART_ORDINAL_RE = re.compile(r"第\s*([0-9０-９一二三四五六七八九十]+)\s*部")
FINAL_EPISODE_RE = re.compile(r"(?:最[终終]话|最終話|final\s*episode)", re.IGNORECASE)


@dataclass(frozen=True)
class SourceEpisodeScope:
    start_index: int
    end_index: int
    covered_through_index: int

    @property
    def covered_indexes(self) -> set[int]:
        return set(range(self.start_index, self.covered_through_index + 1))

    @property
    def pending_indexes(self) -> set[int]:
        return set(range(self.covered_through_index + 1, self.end_index + 1))


def extract_episode_number(title: str) -> int | None:
    normalized = unicodedata.normalize("NFKC", title)
    match = EPISODE_NUMBER_RE.match(normalized) or LATIN_EPISODE_NUMBER_RE.match(normalized)
    if not match:
        return None
    try:
        number = int(match.group(1))
    except ValueError:
        return None
    return number if number > 0 else None


def match_source_episode_assets(
    assets: list[BookAsset],
    episodes: list[WorkSourceEpisode],
) -> list[tuple[BookAsset, WorkSourceEpisode]]:
    episodes_by_index = {episode.index: episode for episode in episodes}
    episodes_by_url = {episode.url: episode for episode in episodes if episode.url}
    episodes_by_number: dict[int, list[WorkSourceEpisode]] = {}
    episodes_by_title: dict[str, list[WorkSourceEpisode]] = {}
    for episode in episodes:
        number = extract_episode_number(episode.title)
        if number is not None:
            episodes_by_number.setdefault(number, []).append(episode)
        episodes_by_title.setdefault(normalize_episode_title(episode.title), []).append(episode)

    matches: list[tuple[BookAsset, WorkSourceEpisode]] = []
    matched_episode_indexes: set[int] = set()
    for asset in assets:
        if is_front_matter_asset(asset):
            continue
        episode = explicit_source_episode(asset, episodes_by_index, episodes_by_url)
        title = asset.metadata.get("title")
        title = title.strip() if isinstance(title, str) else ""
        if episode is None and title:
            number = extract_episode_number(title)
            numbered_candidates = episodes_by_number.get(number, []) if number is not None else []
            if len(numbered_candidates) == 1:
                episode = numbered_candidates[0]
        if episode is None and title:
            title_candidates = episodes_by_title.get(normalize_episode_title(title), [])
            if len(title_candidates) == 1:
                episode = title_candidates[0]
        if episode is None or episode.index in matched_episode_indexes:
            continue
        matches.append((asset, episode))
        matched_episode_indexes.add(episode.index)
    return sorted(matches, key=lambda pair: pair[1].index)


def covered_source_episode_indexes(
    assets: list[BookAsset],
    episodes: list[WorkSourceEpisode],
) -> set[int]:
    return {episode.index for _asset, episode in match_source_episode_assets(assets, episodes)}


def infer_source_episode_scope(
    book_title: str,
    assets: list[BookAsset],
    episodes: list[WorkSourceEpisode],
) -> SourceEpisodeScope | None:
    """Infer a numbered part when one source work contains multiple episode runs.

    Compiled translations commonly merge several web episodes into one EPUB
    chapter.  Their last explicit episode number still tells us how far that
    volume reaches, while labels such as "第二部" disambiguate a numbering
    reset in the source catalog.
    """

    runs = _numbered_episode_runs(episodes)
    asset_numbers = [
        number
        for asset in assets
        if not is_front_matter_asset(asset)
        for number in [_asset_episode_number(asset)]
        if number is not None
    ]
    if not runs or not asset_numbers:
        return None

    part_ordinal = _part_ordinal(book_title)
    if part_ordinal is not None:
        if part_ordinal > len(runs):
            return None
        selected_run = runs[part_ordinal - 1]
    else:
        maximum_asset_number = max(asset_numbers)
        candidates = [
            run
            for run in runs
            if any(extract_episode_number(episode.title) == maximum_asset_number for episode in run)
        ]
        if len(candidates) != 1:
            return None
        selected_run = candidates[0]

    maximum_asset_number = max(asset_numbers)
    covered_candidates = [
        episode.index
        for episode in selected_run
        if extract_episode_number(episode.title) == maximum_asset_number
    ]
    if len(covered_candidates) != 1:
        return None
    covered_through_index = covered_candidates[0]

    has_local_finale = any(
        isinstance(asset.metadata.get("title"), str)
        and FINAL_EPISODE_RE.search(str(asset.metadata["title"]))
        for asset in assets
    )
    if has_local_finale and FINAL_EPISODE_RE.search(selected_run[-1].title):
        covered_through_index = selected_run[-1].index

    return SourceEpisodeScope(
        start_index=selected_run[0].index,
        end_index=selected_run[-1].index,
        covered_through_index=covered_through_index,
    )


def explicit_source_episode(
    asset: BookAsset,
    episodes_by_index: dict[int, WorkSourceEpisode],
    episodes_by_url: dict[str, WorkSourceEpisode],
) -> WorkSourceEpisode | None:
    source_url = asset.metadata.get("source_episode_url")
    if isinstance(source_url, str) and source_url in episodes_by_url:
        return episodes_by_url[source_url]
    source_index = asset.metadata.get("source_catalog_index")
    if isinstance(source_index, int) and not isinstance(source_index, bool):
        return episodes_by_index.get(source_index)
    return None


def is_front_matter_asset(asset: BookAsset) -> bool:
    source = asset.metadata.get("source")
    if not isinstance(source, str) or source == "manual_append":
        return False
    name = PurePosixPath(source).stem
    return bool(FRONT_MATTER_SOURCE_RE.search(name))


def normalize_episode_title(title: str) -> str:
    normalized = unicodedata.normalize("NFKC", title).lower().replace("話", "话")
    return re.sub(r"[\s\W_]+", "", normalized, flags=re.UNICODE)


def _asset_episode_number(asset: BookAsset) -> int | None:
    title = asset.metadata.get("title")
    return extract_episode_number(title) if isinstance(title, str) else None


def _numbered_episode_runs(episodes: list[WorkSourceEpisode]) -> list[list[WorkSourceEpisode]]:
    runs: list[list[WorkSourceEpisode]] = []
    current: list[WorkSourceEpisode] = []
    maximum_number = 0
    for episode in episodes:
        number = extract_episode_number(episode.title)
        if number == 1 and current and maximum_number > 1:
            runs.append(current)
            current = []
            maximum_number = 0
        current.append(episode)
        if number is not None:
            maximum_number = max(maximum_number, number)
    if current:
        runs.append(current)
    return runs


def _part_ordinal(title: str) -> int | None:
    match = PART_ORDINAL_RE.search(unicodedata.normalize("NFKC", title))
    if not match:
        return None
    value = match.group(1)
    if value.isdigit():
        ordinal = int(value)
    else:
        digits = {"一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9}
        if value == "十":
            ordinal = 10
        elif value.startswith("十"):
            ordinal = 10 + digits.get(value[1:], 0)
        elif value.endswith("十"):
            ordinal = digits.get(value[:-1], 0) * 10
        elif "十" in value:
            tens, ones = value.split("十", 1)
            ordinal = digits.get(tens, 0) * 10 + digits.get(ones, 0)
        else:
            ordinal = digits.get(value, 0)
    return ordinal if ordinal > 0 else None
