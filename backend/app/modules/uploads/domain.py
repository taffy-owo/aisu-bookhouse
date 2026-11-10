from dataclasses import dataclass, replace
from datetime import datetime, timezone
from typing import Literal

UploadStatus = Literal["uploading", "processing", "ready", "failed"]

UploadTaskKind = Literal["initial", "reprocess", "replace_keep_progress", "replace_reset_progress"]


@dataclass(frozen=True)
class UploadTask:
    id: str
    user_id: str
    book_id: str | None
    file_name: str
    file_type: str
    file_size: int
    status: UploadStatus
    progress: int
    message: str | None
    error_code: str | None
    created_at: datetime
    updated_at: datetime
    kind: UploadTaskKind = "initial"

    def with_changes(self, **changes: object) -> "UploadTask":
        if "updated_at" not in changes:
            changes["updated_at"] = datetime.now(timezone.utc)
        return replace(self, **changes)
