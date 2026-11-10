from datetime import datetime

from pydantic import BaseModel, Field


class ReadingActivityRecordRequest(BaseModel):
    book_id: str | None = None
    date_key: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    event_id: str | None = Field(default=None, min_length=8, max_length=64)
    occurred_at: datetime | None = None
    seconds: int = Field(gt=0, le=3600)


class ReadingActivityDayPublic(BaseModel):
    date_key: str
    seconds: int


class ReadingActivityBookTotalPublic(BaseModel):
    book_id: str
    book_title: str | None = None
    seconds: int


class ReadingActivitySummaryPublic(BaseModel):
    active_days: int
    book_totals: list[ReadingActivityBookTotalPublic]
    days: list[ReadingActivityDayPublic]
    first_read_date: str | None
    last_read_date: str | None
    longest_streak_days: int
    streak_days: int
    today_seconds: int
    total_seconds: int
    week_seconds: int
