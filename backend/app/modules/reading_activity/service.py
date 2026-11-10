from datetime import datetime, timedelta, timezone
import re

from app.modules.books.repository import BookRepository
from app.modules.reading_activity.repository import ReadingActivityRepository
from app.modules.reading_activity.schemas import ReadingActivityBookTotalPublic, ReadingActivityDayPublic, ReadingActivitySummaryPublic


def record_reading_activity(
    *,
    user_id: str,
    seconds: int,
    book_id: str | None,
    occurred_at: datetime | None,
    date_key: str | None,
    event_id: str | None,
    book_repository: BookRepository,
    activity_repository: ReadingActivityRepository,
) -> ReadingActivitySummaryPublic | None:
    if seconds <= 0:
        return get_reading_activity_summary(user_id=user_id, activity_repository=activity_repository)

    book = book_repository.get_accessible(user_id, book_id) if book_id else None
    if book_id and not book:
        # A pagehide event can remain in the browser outbox while the user
        # deletes that same book in another tab. Deleted books are soft-kept so
        # their historical seconds and title remain attributable; accept the
        # delayed event only for the original owner.
        book = book_repository.get_owned_including_deleted(user_id, book_id)
    if book_id and not book:
        return None

    resolved_date_key = date_key or format_date_key(occurred_at or datetime.now(timezone.utc))
    if not is_valid_date_key(resolved_date_key):
        return None

    recorded = activity_repository.add_seconds(
        user_id=user_id,
        book_id=book_id,
        book_title=book.title if book else None,
        date_key=resolved_date_key,
        event_id=event_id,
        seconds=seconds,
    )
    if not recorded:
        # The book was deleted between the existence check and the write; treat
        # it the same as "book not found" instead of surfacing a 500.
        return None
    return get_reading_activity_summary(user_id=user_id, activity_repository=activity_repository)


def get_reading_activity_summary(*, user_id: str, activity_repository: ReadingActivityRepository, now: datetime | None = None) -> ReadingActivitySummaryPublic:
    daily_rows, book_rows = activity_repository.aggregate_for_user(user_id)
    seconds_by_date = {date_key: seconds for date_key, seconds in daily_rows if seconds > 0}
    seconds_by_book = {book_id: seconds for book_id, _, seconds in book_rows if seconds > 0}
    titles_by_book = {book_id: title for book_id, title, seconds in book_rows if seconds > 0}

    days = [
        ReadingActivityDayPublic(date_key=date_key, seconds=seconds)
        for date_key, seconds in sorted(seconds_by_date.items())
        if seconds > 0
    ]
    book_totals = [
        ReadingActivityBookTotalPublic(book_id=book_id, book_title=titles_by_book.get(book_id), seconds=seconds)
        for book_id, seconds in sorted(seconds_by_book.items(), key=lambda item: item[1], reverse=True)
        if seconds > 0
    ]
    active_date_keys = [day.date_key for day in days]
    current_now = now or datetime.now(timezone.utc)
    today_key = format_date_key(current_now)
    week_keys = {format_date_key(current_now - timedelta(days=day_offset)) for day_offset in range(7)}

    return ReadingActivitySummaryPublic(
        active_days=len(days),
        book_totals=book_totals,
        days=days,
        first_read_date=active_date_keys[0] if active_date_keys else None,
        last_read_date=active_date_keys[-1] if active_date_keys else None,
        longest_streak_days=count_longest_streak_days(active_date_keys),
        streak_days=count_current_streak_days(set(active_date_keys), current_now),
        today_seconds=seconds_by_date.get(today_key, 0),
        total_seconds=sum(seconds_by_date.values()),
        week_seconds=sum(seconds_by_date.get(date_key, 0) for date_key in week_keys),
    )


def count_current_streak_days(date_keys: set[str], now: datetime) -> int:
    today_key = format_date_key(now)
    anchor = now if today_key in date_keys else now - timedelta(days=1)
    streak_days = 0

    for day_offset in range(3650):
        date_key = format_date_key(anchor - timedelta(days=day_offset))
        if date_key not in date_keys:
            break
        streak_days += 1

    return streak_days


def count_longest_streak_days(date_keys: list[str]) -> int:
    parsed_dates = sorted(parse_date_key(date_key) for date_key in set(date_keys))
    if not parsed_dates:
        return 0

    longest_streak = 1
    current_streak = 1

    for index in range(1, len(parsed_dates)):
        day_diff = (parsed_dates[index] - parsed_dates[index - 1]).days
        if day_diff == 1:
            current_streak += 1
        elif day_diff > 1:
            current_streak = 1
        longest_streak = max(longest_streak, current_streak)

    return longest_streak


def parse_date_key(date_key: str) -> datetime:
    return datetime.strptime(date_key, "%Y-%m-%d").replace(tzinfo=timezone.utc)


def format_date_key(value: datetime) -> str:
    return value.astimezone(timezone.utc).strftime("%Y-%m-%d") if value.tzinfo else value.strftime("%Y-%m-%d")


def is_valid_date_key(value: str) -> bool:
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        return False
    try:
        datetime.strptime(value, "%Y-%m-%d")
    except ValueError:
        return False
    return True
