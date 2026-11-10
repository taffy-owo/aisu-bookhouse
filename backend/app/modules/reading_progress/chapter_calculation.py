from dataclasses import replace
from math import floor, isfinite

from app.modules.book_assets.domain import BookAsset
from app.modules.reader.service import get_reader_progress_weight, resolve_progress_chapter_position
from app.modules.reading_progress.domain import ReadingProgress
from app.modules.reading_progress.repository import ReadingProgressRepository


def scroll_ratio(epub_cfi: str | None) -> float | None:
    if not epub_cfi or not epub_cfi.startswith("aisu-scroll:"):
        return None
    try:
        value = float(epub_cfi[len("aisu-scroll:"):])
    except ValueError:
        return None
    return min(1.0, max(0.0, value)) if isfinite(value) else None


def chapter_weights(chapters: list[BookAsset]) -> list[int]:
    weights = [get_reader_progress_weight(chapter) for chapter in chapters]
    return weights if all(weight is not None for weight in weights) else [1] * len(chapters)


def chapter_progress_percent(chapters: list[BookAsset], chapter_index: int, ratio: float) -> int:
    if not chapters:
        return 0
    index = min(len(chapters), max(1, chapter_index))
    ratio = min(1.0, max(0.0, ratio))
    weights = chapter_weights(chapters)
    raw = (sum(weights[:index - 1]) + weights[index - 1] * ratio) / sum(weights) * 100
    if raw <= 0:
        return 0
    if index == len(chapters) and ratio == 1:
        return 100
    # Match the reader: rounding an almost-finished position must not mark it read.
    return min(99, floor(raw + .5))


def appended_progress_percent(percent: int, previous: list[BookAsset], current: list[BookAsset]) -> int:
    if not previous or not current or percent <= 0:
        return 0
    # Use one consistent weight basis when older assets have no length metadata.
    weights = chapter_weights(current)
    raw = percent * sum(weights[:len(previous)]) / sum(weights)
    return min(99, max(1, floor(raw + .5)))


def rebase_appended_progress(book_id: str, previous: list[BookAsset], current: list[BookAsset],
                            repository: ReadingProgressRepository) -> None:
    for saved in repository.list_all_for_book(book_id):
        if saved.reader_type not in {"text", "epub"}:
            continue
        ratio = scroll_ratio(saved.epub_cfi)
        if saved.chapter_index and 1 <= saved.chapter_index <= len(previous) and ratio is not None:
            percent = chapter_progress_percent(current, saved.chapter_index, ratio)
        else:
            percent = appended_progress_percent(saved.progress_percent, previous, current)
        if percent != saved.progress_percent:
            repository.rebase_percentage(saved, percent)


def rebase_edited_progress(book_id: str, reader_type: str, current: list[BookAsset],
                          repository: ReadingProgressRepository) -> None:
    for saved in repository.list_all_for_book(book_id):
        ratio = scroll_ratio(saved.epub_cfi)
        # Explicit completion survives revisions. Unanchored legacy positions
        # retain their percentage until a current reader supplies coordinates.
        if (saved.reader_type != reader_type or saved.progress_percent >= 100 or ratio is None
                or not saved.chapter_index or not 1 <= saved.chapter_index <= len(current)):
            continue
        percent = chapter_progress_percent(current, saved.chapter_index, ratio)
        if percent != saved.progress_percent:
            repository.rebase_percentage(saved, percent)


def progress_after_chapter_delete(progress: ReadingProgress, deleted_index: int,
                                  previous: list[BookAsset], current: list[BookAsset]) -> ReadingProgress:
    if progress.chapter_index is None and progress.progress_percent in {0, 100}:
        return progress
    old_index = progress.chapter_index
    ratio = scroll_ratio(progress.epub_cfi)
    next_cfi = progress.epub_cfi
    href = progress.chapter_href
    if old_index is not None and not 1 <= old_index <= len(previous):
        # Old unkeyed clients could persist a chapter outside the catalog.
        # Its ratio/href belongs to an unknown chapter; recover from the last
        # whole-book percentage before applying this deletion's movement.
        old_index, ratio = resolve_progress_chapter_position(progress.progress_percent, chapter_weights(previous))
        next_cfi = f"aisu-scroll:{ratio}" if ratio is not None else None
        href = None
    if not old_index or ratio is None:
        inferred_index, inferred_ratio = resolve_progress_chapter_position(progress.progress_percent, chapter_weights(previous))
        if not old_index:
            old_index = inferred_index
        if ratio is None:
            ratio = inferred_ratio if old_index == inferred_index else 0.0
    if not old_index or ratio is None:
        return progress
    if old_index == deleted_index:
        next_index = min(deleted_index, len(current))
        ratio = 0.0 if deleted_index <= len(current) else 1.0
        next_cfi = f"aisu-scroll:{int(ratio)}"
        href = None
    else:
        next_index = old_index - 1 if old_index > deleted_index else old_index
    percent = 100 if progress.progress_percent >= 100 else chapter_progress_percent(current, next_index, ratio)
    return replace(progress, chapter_index=next_index if progress.chapter_index is not None else None,
                   epub_cfi=next_cfi, chapter_href=href, progress_percent=percent)
