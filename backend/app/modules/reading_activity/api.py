from fastapi import APIRouter, Depends, HTTPException, status

from app.core.dependencies import get_book_repository, get_current_user, get_reading_activity_repository
from app.modules.books.repository import BookRepository
from app.modules.reading_activity.repository import ReadingActivityRepository
from app.modules.reading_activity.schemas import ReadingActivityRecordRequest, ReadingActivitySummaryPublic
from app.modules.reading_activity.service import get_reading_activity_summary, record_reading_activity
from app.modules.users.domain import User

router = APIRouter(tags=["reading-activity"])


@router.get("/reading-activity", response_model=ReadingActivitySummaryPublic)
def get_activity_summary(
    current_user: User = Depends(get_current_user),
    activity_repository: ReadingActivityRepository = Depends(get_reading_activity_repository),
) -> ReadingActivitySummaryPublic:
    return get_reading_activity_summary(user_id=current_user.id, activity_repository=activity_repository)


@router.post("/reading-activity", response_model=ReadingActivitySummaryPublic)
def post_activity(
    payload: ReadingActivityRecordRequest,
    current_user: User = Depends(get_current_user),
    book_repository: BookRepository = Depends(get_book_repository),
    activity_repository: ReadingActivityRepository = Depends(get_reading_activity_repository),
) -> ReadingActivitySummaryPublic:
    summary = record_reading_activity(
        user_id=current_user.id,
        seconds=payload.seconds,
        book_id=payload.book_id,
        occurred_at=payload.occurred_at,
        date_key=payload.date_key,
        event_id=payload.event_id,
        book_repository=book_repository,
        activity_repository=activity_repository,
    )
    if summary is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Book not found")
    return summary
