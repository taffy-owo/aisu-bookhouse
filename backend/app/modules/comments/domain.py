from dataclasses import dataclass, replace
from datetime import datetime, timezone
from typing import Literal

CommentTargetType = Literal["book", "volume"]


@dataclass(frozen=True)
class PublicComment:
    id: str
    book_id: str
    user_id: str
    target_type: CommentTargetType
    target_index: int | None
    body: str
    created_at: datetime
    updated_at: datetime
    deleted_at: datetime | None = None

    def with_changes(self, **changes: object) -> "PublicComment":
        if "updated_at" not in changes:
            changes["updated_at"] = datetime.now(timezone.utc)
        return replace(self, **changes)
