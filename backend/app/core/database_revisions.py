"""Exact revision comparisons for current and legacy SQLite datetime spellings."""
from sqlalchemy import String, cast, or_


def datetime_revision_matches(column, expected, dialect_name):
    matches = column == expected
    if dialect_name == 'sqlite':
        # SQL datetime('now') omits fractional seconds. ISO writers may instead
        # retain a T separator or UTC offset. Never truncate real precision.
        formats = {expected.isoformat(sep, timespec=precision)
            for sep in (' ', 'T') for precision in ('auto', 'microseconds')}
        if expected.microsecond % 1000 == 0:
            formats.update(expected.isoformat(sep, timespec='milliseconds') for sep in (' ', 'T'))
        formats.update(value[:-6] + 'Z' for value in tuple(formats) if value.endswith('+00:00'))
        matches = or_(matches, cast(column, String).in_(formats))
    return matches
